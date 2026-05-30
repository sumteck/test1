/**
 * parser.js
 * =========
 * Client-side PDF text extraction and bill data parsing.
 * Handles two distinct treasury bill formats:
 *   • SPARK bills  — Head of Account hyphenated (e.g. 2210-02-101-97-00-02-01)
 *                   — Net total labelled "Net Sal" / "Total = A - B"
 *   • BiMS bills   — Head of Account space-separated (e.g. 2210 02 198 50 00 00 00)
 *                   — Net total labelled "Net Amount"
 *
 * Depends on: pdf.js (loaded via CDN in HTML)
 *
 * =============================================================================
 * CHANGE LOG — this session
 * =============================================================================
 *
 * FIX A — SPARK Bill No: label-anchored regex fundamentally broken
 * ----------------------------------------------------------------
 * ROOT CAUSE (discovered via block-level PDF analysis):
 *   In Kerala Treasury SPARK PDFs the form is laid out in two columns.
 *   pdf.js processes text items in PDF content-stream order (not reading
 *   order). In this particular bill the "Bill No:" LABEL is content-stream
 *   item #166 but the VALUE "26915589" is item #253 — separated by ~87
 *   other items including "Head of Account", the HoA number, the abstract
 *   table, and eventually "Spark Code : 99648 96273...".
 *
 *   Any regex that anchors on "Bill No:" and then tries to capture the
 *   immediately following token will NEVER find the value; it will capture
 *   "Head" (next word) or nothing at all.
 *
 * FIX: Replace the single label-anchored regex with a four-strategy cascade:
 *   1. "(\d+) Digitally signed"  — the bill number is printed immediately
 *      before the digital signature stamp (always present, always adjacent).
 *   2. After 4×5-digit employee Spark Codes — "Spark Code : NNNNN NNNNN
 *      NNNNN NNNNN XXXXXXXX" where XXXXXXXX is the bill number.
 *   3. Label-based fallback — for any PDF layout where the value IS adjacent
 *      to the label (future formats, other treasuries).
 *   4. 8-digit standalone number fallback — SPARK bill numbers are always
 *      8 digits; last resort.
 *
 * FIX B — SPARK Net Amount: wrong value extracted (year / zero)
 * -------------------------------------------------------------
 * ROOT CAUSE (two interacting bugs):
 *
 *   BUG B-1 — Date year "2026" contaminating _extractAmountFromSlice:
 *     _extractMultipleHoAsFromSpark takes a 250-char slice starting at each
 *     HoA match position. For the FIRST occurrence of the HoA (page 1), the
 *     slice contains "...Received for the Period:(From) 01/05/2026 (To)
 *     31/05/2026...". The filter requires values ≥ 1000; "2026" passes because
 *     the lookbehind (?<![0-9-]) sees "/" before "2026" — slash is not in the
 *     exclusion set. So _extractAmountFromSlice returned "2026" as the amount.
 *
 *   BUG B-2 — Duplicate HoA occurrences creating phantom rows:
 *     The same canonical HoA "2210-02-101-97-00-01-01" appears on THREE pages
 *     of the PDF (page 1 header, page 2 summary, page 3 detail). The scanner
 *     found 2 matches (both for the same HoA value). Because multiHoas.length
 *     > 1, parsePdf entered the multi-HoA branch and produced two table rows
 *     instead of one. Amounts were [2026, 0] → screenshot showing "2,026.00"
 *     and "0.00".
 *
 * FIX:
 *   1. _extractMultipleHoAsFromSpark now DEDUPLICATES by canonical HoA key.
 *      The same HoA seen a second time is skipped. This eliminates phantom
 *      rows from repeated headings across pages.
 *   2. parseSparkBill extracts Net Amount with a prioritised cascade that
 *      targets the DEFINITIVE locations in SPARK bills:
 *        P1: "Total = A - B : XXXXXX"  (abstract section, page 1)
 *        P2: "Net Sal XXXXXX"           (summary row, page 2)
 *        P3: "Received ` XXXXXX"        (receipt section, page 1)
 *      These patterns reference the final net-pay figure directly, not a
 *      slice near the HoA, so no date contamination is possible.
 *   3. _extractAmountFromSlice updated to also exclude "/" from the
 *      lookbehind/lookahead (fixes date-year leak for any remaining slice-
 *      based calls in genuinely multi-HoA bills).
 */

const TbrParser = (() => {

  // ── PDF text extraction via pdf.js ────────────────────────────────────────

  /**
   * Extract raw text from all pages of a PDF File object.
   * Returns page texts joined with "\n" (one newline per page boundary).
   * Within each page, text items are space-joined and multi-spaces collapsed,
   * which is the exact behaviour of pdf.js getTextContent().
   */
  async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    const pdf = await pdfjsLib.getDocument({ data: uint8 }).promise;
    const pageTexts = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const pageStr = content.items
        .map(item => item.str)
        .join(" ")
        .replace(/\s{2,}/g, " ");
      pageTexts.push(pageStr);
    }

    return pageTexts.join("\n");
  }

  // ── Bill type detection ───────────────────────────────────────────────────

  /**
   * Detect whether a PDF text belongs to SPARK or BiMS.
   * Returns "SPARK" | "BiMS" | null
   */
  function detectBillType(text) {
    const t = text.toLowerCase();
    if (t.includes("net sal")) return "SPARK";
    if (t.includes("net amount")) return "BiMS";
    return null;
  }

  // ── Head of Account normalisers ───────────────────────────────────────────

  function _mapHoaParts(parts) {
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

  function parseSparkHoA(hoaStr) {
    return _mapHoaParts(hoaStr.trim().split("-"));
  }

  function parseBimsHoA(hoaStr) {
    return _mapHoaParts(hoaStr.trim().split(/\s+/));
  }

  function canonicalHoA(hoaObj) {
    return [hoaObj.MJH, hoaObj.SMJH, hoaObj.MIH, hoaObj.SBHLH,
            hoaObj.SHLH, hoaObj.VOH, hoaObj.SOH].join("-");
  }

  // ── Number helpers ────────────────────────────────────────────────────────

  function parseAmount(str) {
    if (!str) return 0;
    const cleaned = String(str).replace(/,/g, "").replace(/\s/g, "");
    const val = parseFloat(cleaned);
    return isNaN(val) ? 0 : val;
  }

  /**
   * Extract the most likely currency amount from a text slice.
   *
   * Used for GENUINELY multi-HoA bills where we need per-HoA amounts from
   * their individual salary rows. For single-HoA bills this function is not
   * called — the global net amount from parseSparkBill/parseBimsBill is used.
   *
   * FIX B-1: "/" added to lookbehind/lookahead exclusion set so date
   * components like "2026" in "01/05/2026" are no longer matched.
   */
  function _extractAmountFromSlice(slice) {
    // Exclude numbers that are part of dates (preceded/followed by "/"),
    // part of HoA strings (preceded/followed by "-"), or comma-grouped
    // continuations. Require value ≥ 1000 to skip 2–3 digit HoA segments.
    const pattern = /(?<![0-9\-\/])([1-9][0-9]*(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?)(?![0-9\-\/,])/g;
    const allMatches = [...slice.matchAll(pattern)];
    const validMatches = allMatches.filter(m => {
      const raw = parseFloat(m[1].replace(/,/g, "")) || 0;
      return raw >= 1000;
    });
    if (validMatches.length === 0) return 0;
    const last = validMatches[validMatches.length - 1][1];
    return parseFloat(last.replace(/,/g, "")) || 0;
  }

  // ── SPARK Bill No extractor ───────────────────────────────────────────────

  /**
   * FIX A — Extract the SPARK bill number from the full PDF text.
   *
   * WHY LABEL-ANCHORED REGEX FAILS:
   *   pdf.js processes PDF text items in content-stream order. In Kerala
   *   Treasury SPARK bills the form is two-column. The "Bill No:" label and
   *   its numeric value are in different PDF content blocks, so pdf.js places
   *   ~87 other items between them in the joined string. The value never
   *   appears immediately after the label in the text stream.
   *
   * STRATEGY CASCADE (first match wins):
   *   1. "(\d+) Digitally signed" — the bill number is physically stamped
   *      immediately before the digital signature block on page 1. This is
   *      always the last standalone number before "Digitally signed".
   *   2. After 4×5-digit employee Spark Codes — the summary Spark Code line
   *      "Spark Code : NNNNN NNNNN NNNNN NNNNN XXXXXXXX" where XXXXXXXX is
   *      the bill's own Spark (bill) number.
   *   3. Label-adjacent fallback — catches any PDF where the value IS next
   *      to the label (other treasuries / future format changes).
   *   4. 8-digit number fallback — SPARK bill numbers are always 8 digits.
   *
   * @param {string} text  Full PDF text (all pages joined).
   * @returns {string}
   */
  function _extractSparkBillNo(text) {
    // Strategy 1: number immediately before "Digitally signed" (most reliable)
    let m = text.match(/(\d[\d\-\/]*\d|\d)\s+Digitally\s+signed/i);
    if (m) return m[1].trim();

    // Strategy 2: after 4 groups of 5-digit employee Spark Codes
    // "Spark Code : 99648 96273 94738 95866 26915589"
    m = text.match(/Spark\s*Code\s*:\s*(?:\d{5}\s+){3}\d{5}\s+(\d+)/i);
    if (m) return m[1].trim();

    // Strategy 3: label-adjacent (works when pdf.js keeps label+value together)
    m = text.match(/Bill\s*(?:No|Number)\s*[.:\s]\s*(\d[\d\/\-]*\d|\d)(?=\s|$)/i);
    if (m) return m[1].trim();

    // Strategy 4: standalone 8-digit number (SPARK bill numbers are always 8 digits)
    m = text.match(/(?<!\d)(\d{8})(?!\d)/);
    if (m) return m[1].trim();

    return "";
  }

  // ── SPARK Net Amount extractor ────────────────────────────────────────────

  /**
   * FIX B-2 — Extract the net pay amount from the full SPARK bill text.
   *
   * Uses a prioritised cascade targeting the two definitive locations in
   * every SPARK bill. This avoids any HoA-slice-based extraction and is
   * therefore immune to date-contamination and multi-page repetition.
   *
   * Priority order:
   *   1. "Total = A - B : XXXXXX"  — the abstract section total (page 1)
   *   2. "Net Sal XXXXXX"          — last column of the summary table (page 2)
   *   3. "Received ` XXXXXX"       — the receipt acknowledgement line (page 1)
   *
   * @param {string} text  Full PDF text.
   * @returns {number}
   */
  function _extractSparkNetAmount(text) {
    // Priority 1: "Total = A - B : 100973"  (abstract section)
    let m = text.match(/Total\s*=\s*A\s*[-–]\s*B\s*:\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
    if (m) return parseAmount(m[1]);

    // Priority 2: "Net Sal" column — the number that follows the last "Net Sal"
    // heading in the table (appears on page 2 as the final column value).
    // The table row ends: "...Tot Ded  Net Sal\nTotal ... 29895  100973"
    // We match the number that comes immediately after the last "Net Sal" label
    // when followed by digits (i.e., inline value, not just a column header).
    m = text.match(/Net\s*Sal\s+([0-9,]+(?:\.[0-9]{1,2})?)/i);
    if (m) return parseAmount(m[1]);

    // Priority 3: "Received ` 100973"  (page 1 receipt line)
    m = text.match(/Received\s+`\s+([0-9,]+(?:\.[0-9]{1,2})?)/i);
    if (m) return parseAmount(m[1]);

    return 0;
  }

  // ── SPARK parser ──────────────────────────────────────────────────────────

  /**
   * Parse a SPARK bill text and extract structured data.
   *
   * @param {string} text  Full concatenated PDF text.
   * @returns {Object|null}
   */
  function parseSparkBill(text) {
    const result = {
      billType:   "SPARK",
      billNo:     "",
      ddoCode:    "",
      department: "",
      netAmount:  0,
      hoa:        null,
    };

    // FIX A: use cascade extractor instead of broken label-anchored regex
    result.billNo = _extractSparkBillNo(text);

    // DDO Code (allow hyphens: "0602-320-004")
    const ddoMatch =
      text.match(/DDO\s*Code[:\s]+([A-Z0-9][A-Z0-9\-]*)/i) ||
      text.match(/\bDDO[:\s]+([A-Z0-9][A-Z0-9\-]*)/i);
    if (ddoMatch) result.ddoCode = ddoMatch[1].trim();

    // Department / Name of Office
    result.department = _extractDeptSpark(text);

    // Head of Account (hyphenated 4-2-3-2-2-2-2)
    const hoaMatch = text.match(/(?<![0-9-])(\d{4}-\d{2}-\d{3}-\d{2}-\d{2}-\d{2}-\d{2})(?![0-9-])/);
    if (hoaMatch) {
      result.hoa    = parseSparkHoA(hoaMatch[1]);
      result.rawHoA = hoaMatch[1];
    }

    // FIX B: use dedicated net-amount extractor
    result.netAmount = _extractSparkNetAmount(text);

    return result.hoa ? result : null;
  }

  /**
   * Extract department/office name from SPARK text.
   * Tries label alternatives in priority order, captures to end-of-line,
   * then strips any trailing field labels that slipped onto the same line.
   */
  function _extractDeptSpark(text) {
    const labelPatterns = [
      /\bDepartment[:\s]+([^\n\r]+)/i,
      /\bName\s+of\s+Office[:\s]+([^\n\r]+)/i,
      /\bOffice\s+Name[:\s]+([^\n\r]+)/i,
      /\bDept[:\s]+([^\n\r]+)/i,
    ];
    for (const pattern of labelPatterns) {
      const m = text.match(pattern);
      if (m) {
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
   * @param {string} text
   * @returns {Object|null}
   */
  function parseBimsBill(text) {
    const result = {
      billType:   "BiMS",
      billNo:     "",
      ddoCode:    "",
      department: "",
      netAmount:  0,
      hoa:        null,
    };

    // Bill / Voucher Number — two-stage (digit-anchored, then alphanumeric)
    const billNoMatch =
      text.match(/(?:Bill|Voucher)\s*No[.:\s]+(\d[\d\/\-]*)/i) ||
      text.match(/(?:Bill|Voucher)\s*No[.:\s]+([A-Z0-9][A-Z0-9\/\-]*)(?=\s|$)/i);
    if (billNoMatch) result.billNo = billNoMatch[1].trim();

    // DDO Code
    const ddoMatch =
      text.match(/DDO\s*Code[:\s]+([A-Z0-9][A-Z0-9\-]*)/i) ||
      text.match(/\bDDO[:\s]+([A-Z0-9][A-Z0-9\-]*)/i);
    if (ddoMatch) result.ddoCode = ddoMatch[1].trim();

    // Department / Office
    result.department = _extractDeptBims(text);

    // Head of Account (space-separated 4-2-3-2-2-2-2)
    const hoaMatch = text.match(/\b(\d{4})\s+(\d{2})\s+(\d{3})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/);
    if (hoaMatch) {
      const parts = [hoaMatch[1], hoaMatch[2], hoaMatch[3],
                     hoaMatch[4], hoaMatch[5], hoaMatch[6], hoaMatch[7]];
      result.hoa    = parseBimsHoA(parts.join(" "));
      result.rawHoA = parts.join(" ");
    }

    // Net Amount (decimal optional)
    const netMatch = text.match(/Net\s*Amount[:\s]+([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (netMatch) result.netAmount = parseAmount(netMatch[1]);

    return result.hoa ? result : null;
  }

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

  /**
   * Extract UNIQUE Head of Account entries from SPARK text.
   *
   * FIX B-2: Deduplicates by canonical HoA key. In SPARK bills the same
   * HoA string appears in the page-1 header, page-2 summary table, and
   * page-3 detail table. Without deduplication the scanner returned 2–3
   * items for what is actually a single-HoA bill, sending parsePdf into the
   * multi-HoA branch and producing phantom rows with wrong amounts.
   *
   * For genuinely multi-HoA bills (different canonical keys), each unique
   * HoA is kept and its per-HoA amount is extracted from the 250-char slice
   * following its first occurrence (using the date-safe _extractAmountFromSlice).
   *
   * @param {string} text
   * @returns {Array<{hoa, rawHoA, netAmount}>}
   */
  function _extractMultipleHoAsFromSpark(text) {
    const results = [];
    const seen = new Set();   // canonical key → skip duplicates
    const hoaPattern = /(?<![0-9-])(\d{4}-\d{2}-\d{3}-\d{2}-\d{2}-\d{2}-\d{2})(?![0-9-])/g;
    let match;

    while ((match = hoaPattern.exec(text)) !== null) {
      const hoaStr = match[1];
      const hoa    = parseSparkHoA(hoaStr);
      const key    = canonicalHoA(hoa);

      if (seen.has(key)) continue;   // same HoA from a different page — skip
      seen.add(key);

      // Per-HoA amount from the 250-char window following this occurrence.
      // For single-HoA bills this value is unused (parsePdf uses parsed.netAmount).
      // For multi-HoA bills this gives the individual sub-total.
      const slice     = text.slice(match.index, match.index + 250);
      const netAmount = _extractAmountFromSlice(slice);

      results.push({ hoa, rawHoA: hoaStr, netAmount });
    }

    return results;
  }

  /**
   * Extract UNIQUE Head of Account entries from BiMS text.
   */
  function _extractMultipleHoAsFromBims(text) {
    const results = [];
    const seen = new Set();
    const hoaPattern = /\b(\d{4})\s+(\d{2})\s+(\d{3})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/g;
    let match;

    while ((match = hoaPattern.exec(text)) !== null) {
      const parts  = [match[1], match[2], match[3], match[4], match[5], match[6], match[7]];
      const hoaStr = parts.join(" ");
      const hoa    = parseBimsHoA(hoaStr);
      const key    = canonicalHoA(hoa);

      if (seen.has(key)) continue;
      seen.add(key);

      const slice     = text.slice(match.index, match.index + 250);
      const netAmount = _extractAmountFromSlice(slice);

      results.push({ hoa, rawHoA: hoaStr, netAmount });
    }

    return results;
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  /**
   * Parse a PDF File object. Returns an array of bill row objects.
   * One PDF normally produces one row; a bill with multiple distinct Heads
   * of Account produces one row per unique HoA.
   *
   * Each row:
   * { billType, billNo, ddoCode, department, netAmount,
   *   MJH, SMJH, MIH, SBHLH, SHLH, VOH, SOH, rawHoA, canonicalHoA }
   */
  async function parsePdf(file) {
    const text     = await extractPdfText(file);
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
      parsed    = parseSparkBill(text);
      multiHoas = _extractMultipleHoAsFromSpark(text);   // already deduplicated
    } else {
      parsed    = parseBimsBill(text);
      multiHoas = _extractMultipleHoAsFromBims(text);
    }

    if (!parsed) {
      throw new Error(`Failed to extract required fields from "${file.name}".`);
    }

    const baseRow = {
      billType:   parsed.billType,
      billNo:     parsed.billNo,
      ddoCode:    parsed.ddoCode,
      department: parsed.department,
    };

    // If there are genuinely multiple DIFFERENT HoAs, produce one row per HoA.
    // Thanks to deduplication, multiHoas.length === 1 for single-HoA bills
    // regardless of how many times the HoA appears across pages.
    if (multiHoas.length > 1) {
      return multiHoas.map(h => ({
        ...baseRow,
        netAmount:    h.netAmount,
        rawHoA:       h.rawHoA,
        canonicalHoA: canonicalHoA(h.hoa),
        ...h.hoa,
      }));
    }

    // Single unique HoA — use the authoritative net amount from parseSparkBill
    const hoa = parsed.hoa;
    return [{
      ...baseRow,
      netAmount:    parsed.netAmount,
      rawHoA:       parsed.rawHoA,
      canonicalHoA: canonicalHoA(hoa),
      ...hoa,
    }];
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    parsePdf,
    parseAmount,
    canonicalHoA,
    parseSparkHoA,
    parseBimsHoA,
    detectBillType,
  };
})();
