/**
 * parser.js
 * =========
 * Client-side PDF text extraction and bill data parsing.
 * Handles two distinct treasury bill formats:
 *   • SPARK bills  — Head of Account hyphenated (e.g. 2210-02-101-97-00-02-01)
 *                   — Total labelled "Net Sal"
 *   • BiMS bills   — Head of Account space-separated (e.g. 2210 02 198 50 00 00 00)
 *                   — Total labelled "Net Amount"
 *
 * Depends on: pdf.js (loaded via CDN in HTML)
 *
 * Changelog
 * ---------
 * Fix 1 — Bill No regex: changed capture group from [A-Z0-9\-\/]+ (which ran into
 *          adjacent label words when no space separator) to a two-stage approach:
 *          prefer a digit-anchored token (\d[\d\/\-]*), fall back to space-terminated
 *          alphanumeric.  Covers both the common pure-numeric SPARK bill number and
 *          edge-case alphanumeric formats.
 *
 * Fix 2 — DDO Code regex: extended character class from [A-Z0-9]+ to [A-Z0-9\-]+
 *          so hyphenated codes like "0602-320-004" are captured in full.
 *
 * Fix 3 — Department regex: replaced the single Dept(?:artment)? pattern with an
 *          ordered list of explicit \b-anchored label alternatives, adding
 *          "Name of Office" as a primary fallback for SPARK bills that omit
 *          "Department".  The capture now uses [^\n\r]+ (everything to end-of-line)
 *          and strips trailing field labels via a post-match clean-up replace, which
 *          avoids the previous lazy-quantifier backtracking bug where Dept(?:artment)?
 *          matched mid-string occurrences of "Dept" instead of the label at line start.
 *
 * Fix 4 — _extractAmountFromSlice: the old pattern required a decimal point, so
 *          whole-number amounts like "100973" returned 0.  The new pattern makes the
 *          decimal optional, adds a ≥1000 value filter to skip 2–3 digit HoA segment
 *          numbers, and uses lookahead/lookbehind that excludes hyphens as well as
 *          digits (so mid-HoA numbers such as the "97" in "97-00-00-00" are ignored).
 */

const TbrParser = (() => {

  // ── PDF text extraction via pdf.js ────────────────────────────────────────

  /**
   * Extract raw text from all pages of a PDF File object.
   * Returns a single concatenated string with newlines between pages.
   */
  async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    // pdfjsLib must be loaded globally (via CDN script tag)
    const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
    const pageTexts = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Items come with their own transform positions; join with spaces/newlines
      const pageStr = content.items
        .map(item => item.str)
        .join(" ")
        .replace(/\s{2,}/g, " ");   // collapse multiple spaces
      pageTexts.push(pageStr);
    }

    return pageTexts.join("\n");
  }

  // ── Bill type detection ───────────────────────────────────────────────────

  /**
   * Detect whether a PDF text belongs to SPARK or BiMS.
   * SPARK bills contain "Net Sal" (case-insensitive).
   * BiMS bills contain "Net Amount".
   * Returns "SPARK" | "BiMS" | null
   */
  function detectBillType(text) {
    const t = text.toLowerCase();
    if (t.includes("net sal")) return "SPARK";
    if (t.includes("net amount")) return "BiMS";
    return null;
  }

  // ── Head of Account normalisers ───────────────────────────────────────────

  /**
   * Map segments of a Head of Account string to the column variables.
   * A standard 7-part HoA: MJH-SMJH-MIH-SBHLH-SHLH-VOH-SOH
   *
   * @param {string[]} parts  e.g. ["2210","02","101","97","00","02","01"]
   * @returns {Object}
   */
  function _mapHoaParts(parts) {
    // Pad to 7 parts with "00" if fewer
    const p = [...parts];
    while (p.length < 7) p.push("00");

    return {
      MJH:   p[0] || "00",
      SMJH:  p[1] || "00",
      MIH:   p[2] || "00",
      SBHLH: p[3] || "00",
      SHLH:  p[4] || "00",
      VOH:   p[5] || "00",
      SOH:   p[6] || "00",
    };
  }

  /**
   * Parse a SPARK-style HoA string: "2210-02-101-97-00-02-01"
   */
  function parseSparkHoA(hoaStr) {
    const parts = hoaStr.trim().split("-");
    return _mapHoaParts(parts);
  }

  /**
   * Parse a BiMS-style HoA string: "2210 02 198 50 00 00 00"
   */
  function parseBimsHoA(hoaStr) {
    const parts = hoaStr.trim().split(/\s+/);
    return _mapHoaParts(parts);
  }

  /**
   * Returns a canonical "full HoA" string (hyphenated, 7 parts)
   * for grouping/display regardless of source format.
   */
  function canonicalHoA(hoaObj) {
    return [hoaObj.MJH, hoaObj.SMJH, hoaObj.MIH, hoaObj.SBHLH, hoaObj.SHLH, hoaObj.VOH, hoaObj.SOH].join("-");
  }

  // ── Number helpers ────────────────────────────────────────────────────────

  /**
   * Strip commas, spaces, and parse as float. Returns 0 on failure.
   */
  function parseAmount(str) {
    if (!str) return 0;
    const cleaned = String(str).replace(/,/g, "").replace(/\s/g, "");
    const val = parseFloat(cleaned);
    return isNaN(val) ? 0 : val;
  }

  // ── Shared field extractors ────────────────────────────────────────────────
  //
  // These helpers are used by both the single-bill parsers (parseSparkBill /
  // parseBimsBill) and the multi-HoA scanners (_extractMultipleHoAs*).

  /**
   * FIX 4 — Extract the most likely currency amount from a text slice that
   * begins at a Head of Account position.
   *
   * Strategy:
   *   1. Match all numbers that are NOT surrounded by digits or hyphens
   *      (which would indicate they are segments of the HoA itself).
   *   2. Require the raw numeric value to be ≥ 1000 to filter out 2–3 digit
   *      HoA segment numbers such as "97" or "101".
   *   3. Return the LAST qualifying match — amounts always appear after the
   *      HoA string in the text, not before it.
   *   4. Decimal point is optional: whole numbers like "100973" are valid.
   *      Indian comma grouping (1,23,456) is also supported.
   *
   * @param {string} slice  Substring of the full PDF text starting at the HoA.
   * @returns {number}
   */
  function _extractAmountFromSlice(slice) {
    const pattern = /(?<![0-9\-])([1-9][0-9]*(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?)(?![0-9\-,])/g;
    const allMatches = [...slice.matchAll(pattern)];

    // Keep only values ≥ 1000 to skip short HoA segment numbers
    const validMatches = allMatches.filter(m => {
      const raw = parseFloat(m[1].replace(/,/g, "")) || 0;
      return raw >= 1000;
    });

    if (validMatches.length === 0) return 0;
    const last = validMatches[validMatches.length - 1][1];
    return parseFloat(last.replace(/,/g, "")) || 0;
  }

  // ── SPARK parser ──────────────────────────────────────────────────────────

  /**
   * Parse a SPARK bill text and extract structured data.
   *
   * Expected fields in SPARK PDFs:
   *   Bill No    : labelled "Bill No" or "Bill Number" or "BillNo"
   *   DDO Code   : labelled "DDO Code" or "DDO" — may be hyphenated e.g. 0602-320-004
   *   Department : labelled "Department", "Dept", or "Name of Office"
   *   HoA        : hyphenated pattern  \d{4}-\d{2}-\d{3}(-\d{2}){4}
   *   Net Sal    : labelled "Net Sal" followed by the amount (decimal optional)
   *
   * @param {string} text
   * @returns {Object|null}
   */
  function parseSparkBill(text) {
    const result = {
      billType: "SPARK",
      billNo: "",
      ddoCode: "",
      department: "",
      netAmount: 0,
      hoa: null,
    };

    // ── FIX 1: Bill Number ──────────────────────────────────────────────────
    // Old: /Bill\s*No[.:\s]+([A-Z0-9\-\/]+)/i
    //   → [A-Z0-9\-\/]+ is too greedy: when the number and the next label word
    //     merge without a space (a common PDF extraction artefact), it captured
    //     into the next word (e.g. "26915589Head" → "26915589Head").
    //
    // New strategy: two-stage
    //   Stage 1 — prefer a digit-anchored token (\d[\d\/\-]*) which stops
    //             naturally before any alphabetic character regardless of spacing.
    //             Covers all known SPARK bill numbers (purely numeric).
    //   Stage 2 — fall back to an alphanumeric token terminated by whitespace
    //             or end-of-string, for edge-case alphanumeric bill numbers.
    const billNoMatch =
      text.match(/Bill\s*(?:No|Number)[.:\s]+(\d[\d\/\-]*)/i) ||
      text.match(/Bill\s*(?:No|Number)[.:\s]+([A-Z0-9][A-Z0-9\/\-]*)(?=\s|$)/i);
    if (billNoMatch) result.billNo = billNoMatch[1].trim();

    // ── FIX 2: DDO Code ─────────────────────────────────────────────────────
    // Old: /DDO\s*Code[:\s]+([A-Z0-9]+)/i
    //   → [A-Z0-9]+ stopped at the first hyphen, so "0602-320-004" → "0602".
    //
    // New: added \- to the character class → [A-Z0-9\-]+
    //      Also anchored to start on an alphanumeric char so a stray leading
    //      hyphen can never be captured.
    const ddoMatch =
      text.match(/DDO\s*Code[:\s]+([A-Z0-9][A-Z0-9\-]*)/i) ||
      text.match(/\bDDO[:\s]+([A-Z0-9][A-Z0-9\-]*)/i);
    if (ddoMatch) result.ddoCode = ddoMatch[1].trim();

    // ── FIX 3: Department / Name of Office ──────────────────────────────────
    // Old: /Dept(?:artment)?[:\s]+([A-Za-z &]+?)(?:\s{2,}|\n|Bill|DDO)/i
    //   → Two problems:
    //     a) Dept(?:artment)? matched the literal word "Dept" anywhere in the
    //        text — including "Finance Dept" in the VALUE — not just as a label.
    //        Using \b and explicit full-word alternatives fixes the anchoring.
    //     b) The lazy quantifier + lookahead for stopper words caused the capture
    //        to terminate prematurely when a stopper word appeared inside the value
    //        (e.g. "Finance Dept" stopped at "Dept").
    //
    // New strategy:
    //   • Try each label explicitly with \b word boundary so only the label at
    //     the start of a token is matched.
    //   • Capture everything to end-of-line with [^\n\r]+ (greedy, safe).
    //   • Strip any trailing field labels that were inadvertently included.
    //   • "Name of Office" added as a primary fallback for SPARK PDFs that
    //     omit the "Department" label entirely.
    result.department = _extractDeptSpark(text);

    // ── Head of Account (hyphenated: 4-2-3-2-2-2-2) ─────────────────────────
    const hoaMatch = text.match(/(?<![0-9-])(\d{4}-\d{2}-\d{3}-\d{2}-\d{2}-\d{2}-\d{2})(?![0-9-])/);
    if (hoaMatch) {
      result.hoa = parseSparkHoA(hoaMatch[1]);
      result.rawHoA = hoaMatch[1];
    }

    // ── Net Sal ──────────────────────────────────────────────────────────────
    // Decimal is already optional here via (?:\.\d{1,2})?
    // Indian comma grouping supported via (?:,[0-9,]+)?
    const netSalMatch = text.match(/Net\s*Sal[:\s]+([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (netSalMatch) result.netAmount = parseAmount(netSalMatch[1]);

    return result.hoa ? result : null;
  }

  /**
   * Internal helper for Fix 3: extract department/office name from SPARK text.
   * Tries label alternatives in priority order, captures to EOL, then cleans up.
   *
   * @param {string} text
   * @returns {string}
   */
  function _extractDeptSpark(text) {
    // Labels tried in priority order — all anchored with \b
    const labelPatterns = [
      /\bDepartment[:\s]+([^\n\r]+)/i,
      /\bName\s+of\s+Office[:\s]+([^\n\r]+)/i,
      /\bOffice\s+Name[:\s]+([^\n\r]+)/i,
      /\bDept[:\s]+([^\n\r]+)/i,
    ];

    for (const pattern of labelPatterns) {
      const m = text.match(pattern);
      if (m) {
        // Strip trailing field labels that may have been captured on the same line
        let val = m[1].trim();
        val = val
          .replace(/\s*\b(?:Bill\s*(?:No|Number)|DDO\s*Code|Head\s*of\s*Account|Net\s*Sal|Net\s*Amount|Major\s*Head)\b.*$/i, "")
          .trim();
        if (val) return val;
      }
    }
    return "";
  }

  // ── BiMS parser ───────────────────────────────────────────────────────────

  /**
   * Parse a BiMS bill text and extract structured data.
   *
   * Expected fields in BiMS PDFs:
   *   Bill No    : labelled "Bill No" or "Voucher No"
   *   DDO Code   : labelled "DDO Code"
   *   Department : labelled "Department", "Office", or "Name of Office"
   *   HoA        : space-separated pattern  \d{4} \d{2} \d{3} \d{2} \d{2} \d{2} \d{2}
   *   Net Amount : labelled "Net Amount" followed by the amount
   *
   * @param {string} text
   * @returns {Object|null}
   */
  function parseBimsBill(text) {
    const result = {
      billType: "BiMS",
      billNo: "",
      ddoCode: "",
      department: "",
      netAmount: 0,
      hoa: null,
    };

    // --- Bill / Voucher Number ---
    // BiMS numbers can be alphanumeric; same Fix 1 two-stage approach applied.
    const billNoMatch =
      text.match(/(?:Bill|Voucher)\s*No[.:\s]+(\d[\d\/\-]*)/i) ||
      text.match(/(?:Bill|Voucher)\s*No[.:\s]+([A-Z0-9][A-Z0-9\/\-]*)(?=\s|$)/i);
    if (billNoMatch) result.billNo = billNoMatch[1].trim();

    // --- DDO Code --- (Fix 2 applied: allow hyphens)
    const ddoMatch =
      text.match(/DDO\s*Code[:\s]+([A-Z0-9][A-Z0-9\-]*)/i) ||
      text.match(/\bDDO[:\s]+([A-Z0-9][A-Z0-9\-]*)/i);
    if (ddoMatch) result.ddoCode = ddoMatch[1].trim();

    // --- Department / Office --- (Fix 3 applied)
    result.department = _extractDeptBims(text);

    // --- Head of Account (space-separated: 4 2 3 2 2 2 2) ---
    const hoaMatch = text.match(/\b(\d{4})\s+(\d{2})\s+(\d{3})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/);
    if (hoaMatch) {
      const parts = [hoaMatch[1], hoaMatch[2], hoaMatch[3], hoaMatch[4], hoaMatch[5], hoaMatch[6], hoaMatch[7]];
      result.hoa = parseBimsHoA(parts.join(" "));
      result.rawHoA = parts.join(" ");
    }

    // --- Net Amount --- (decimal already optional; Fix 4 pattern used in multi-HoA path)
    const netMatch = text.match(/Net\s*Amount[:\s]+([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (netMatch) result.netAmount = parseAmount(netMatch[1]);

    return result.hoa ? result : null;
  }

  /**
   * Internal helper: extract department/office name from BiMS text.
   * BiMS bills tend to use "Office" or "Department"; "Name of Office" included too.
   *
   * @param {string} text
   * @returns {string}
   */
  function _extractDeptBims(text) {
    const labelPatterns = [
      /\bDepartment[:\s]+([^\n\r]+)/i,
      /\bName\s+of\s+Office[:\s]+([^\n\r]+)/i,
      /\bOffice\s+Name[:\s]+([^\n\r]+)/i,
      /\bOffice[:\s]+([^\n\r]+)/i,
      /\bDept[:\s]+([^\n\r]+)/i,
    ];

    for (const pattern of labelPatterns) {
      const m = text.match(pattern);
      if (m) {
        let val = m[1].trim();
        val = val
          .replace(/\s*\b(?:Bill\s*(?:No|Number)|Voucher\s*No|DDO\s*Code|Head\s*of\s*Account|Net\s*Amount|Major\s*Head)\b.*$/i, "")
          .trim();
        if (val) return val;
      }
    }
    return "";
  }

  // ── Multi-HoA support ─────────────────────────────────────────────────────
  // A single bill PDF may contain multiple Heads of Account.
  // We extract all of them and their corresponding sub-amounts.

  /**
   * Extract multiple HoA entries from SPARK text.
   * Returns array of { hoa, rawHoA, netAmount }
   */
  function _extractMultipleHoAsFromSpark(text) {
    const results = [];
    // FIX 1 (HoA regex): use negative lookbehind/ahead for hyphens so adjacent
    // HoA segments do not bleed into each other.
    const hoaPattern = /(?<![0-9-])(\d{4}-\d{2}-\d{3}-\d{2}-\d{2}-\d{2}-\d{2})(?![0-9-])/g;
    let match;

    while ((match = hoaPattern.exec(text)) !== null) {
      const hoaStr = match[1];
      const hoa = parseSparkHoA(hoaStr);

      // FIX 4: use the improved _extractAmountFromSlice (decimal optional, ≥1000 filter)
      const slice = text.slice(match.index, match.index + 250);
      const netAmount = _extractAmountFromSlice(slice);

      results.push({ hoa, rawHoA: hoaStr, netAmount });
    }

    return results;
  }

  /**
   * Extract multiple HoA entries from BiMS text.
   */
  function _extractMultipleHoAsFromBims(text) {
    const results = [];
    const hoaPattern = /\b(\d{4})\s+(\d{2})\s+(\d{3})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/g;
    let match;

    while ((match = hoaPattern.exec(text)) !== null) {
      const parts = [match[1], match[2], match[3], match[4], match[5], match[6], match[7]];
      const hoaStr = parts.join(" ");
      const hoa = parseBimsHoA(hoaStr);

      // FIX 4: improved amount extractor
      const slice = text.slice(match.index, match.index + 250);
      const netAmount = _extractAmountFromSlice(slice);

      results.push({ hoa, rawHoA: hoaStr, netAmount });
    }

    return results;
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  /**
   * Parse a PDF File object. Returns an array of bill row objects.
   * One PDF may produce multiple rows (one per HoA).
   *
   * Each row:
   * {
   *   billType, billNo, ddoCode, department, netAmount,
   *   MJH, SMJH, MIH, SBHLH, SHLH, VOH, SOH, rawHoA, canonicalHoA
   * }
   */
  async function parsePdf(file) {
    const text = await extractPdfText(file);
    const billType = detectBillType(text);

    if (!billType) {
      throw new Error(
        `Could not determine bill type from "${file.name}". ` +
        `Expected "Net Sal" (SPARK) or "Net Amount" (BiMS) in the PDF text.`
      );
    }

    let parsed;
    let multiHoas;

    if (billType === "SPARK") {
      parsed = parseSparkBill(text);
      multiHoas = _extractMultipleHoAsFromSpark(text);
    } else {
      parsed = parseBimsBill(text);
      multiHoas = _extractMultipleHoAsFromBims(text);
    }

    if (!parsed) {
      throw new Error(`Failed to extract required fields from "${file.name}".`);
    }

    // If multiple HoAs found, produce one row per HoA
    const baseRow = {
      billType:   parsed.billType,
      billNo:     parsed.billNo,
      ddoCode:    parsed.ddoCode,
      department: parsed.department,
    };

    if (multiHoas.length > 1) {
      return multiHoas.map(h => ({
        ...baseRow,
        netAmount:     h.netAmount,
        rawHoA:        h.rawHoA,
        canonicalHoA:  canonicalHoA(h.hoa),
        ...h.hoa,
      }));
    }

    // Single HoA
    const hoa = parsed.hoa;
    return [{
      ...baseRow,
      netAmount:    parsed.netAmount,
      rawHoA:       parsed.rawHoA,
      canonicalHoA: canonicalHoA(hoa),
      ...hoa,
    }];
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    parsePdf,
    parseAmount,
    canonicalHoA,
    parseSparkHoA,
    parseBimsHoA,
    detectBillType,
  };
})();
