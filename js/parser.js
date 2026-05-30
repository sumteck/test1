/**
 * parser.js
 * =========
 * Client-side PDF text extraction and bill data parsing.
 * Handles two distinct treasury bill formats:
 * • SPARK bills  — Head of Account hyphenated (e.g. 2210-02-101-97-00-02-01)
 * — Total labelled "Net Sal"
 * • BiMS bills   — Head of Account space-separated (e.g. 2210 02 198 50 00 00 00)
 * — Total labelled "Net Amount"
 *
 * Depends on: pdf.js (loaded via CDN in HTML)
 */

const TbrParser = (() => {

  // ── PDF text extraction via pdf.js ────────────────────────────────────────

  /**
   * Extract raw text from all pages of a PDF File object.
   * Preserves newlines between items that have a significant Y-gap.
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
      let lastY = null;
      const parts = [];
      
      content.items.forEach(item => {
        // item.transform[5] is the Y coordinate
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 5) {
          parts.push("\n"); // new line for significant Y change
        }
        parts.push(item.str);
        lastY = y;
      });
      
      const pageStr = parts.join(" ").replace(/ {2,}/g, " ").trim();
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
    // "net sal" as a standalone label (not "net salary breakdown" etc.)
    if (/\bnet\s+sal\b/.test(t) && !/\bnet\s+sal[a-z]/.test(t)) return "SPARK";
    if (/\bnet\s+amount\b/.test(t)) return "BiMS";
    
    // Structural fallback: SPARK has hyphenated HoA, BiMS has space-separated
    if (/\d{4}-\d{2}-\d{3}/.test(text)) return "SPARK";
    if (/\d{4}\s+\d{2}\s+\d{3}/.test(text)) return "BiMS";
    return null;
  }

  // ── Head of Account normalisers ───────────────────────────────────────────

  /**
   * Map segments of a Head of Account string to the column variables.
   * A standard 7-part HoA: MJH-SMJH-MIH-SBHLH-SHLH-VOH-SOH
   */
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
   */
  function canonicalHoA(hoaObj) {
    return [hoaObj.MJH, hoaObj.SMJH, hoaObj.MIH, hoaObj.SBHLH, hoaObj.SHLH, hoaObj.VOH, hoaObj.SOH].join("-");
  }

  // ── Number helpers ────────────────────────────────────────────────────────

  /**
   * Strip commas, spaces, and parse as float.
   */
  function parseAmount(str) {
    if (!str) return 0;
    const cleaned = String(str).replace(/,/g, "").replace(/\s/g, "");
    const val = parseFloat(cleaned);
    return isNaN(val) ? 0 : val;
  }

  /**
   * Helper to extract the last valid currency amount inside the text slice
   * to avoid capturing leading digits belonging to the HoA itself.
   */
  function _extractAmountFromSlice(slice) {
    const allMatches = [...slice.matchAll(/([0-9]{1,3}(?:,[0-9]{2,3})*\.[0-9]{2})/g)];
    if (allMatches.length === 0) return 0;
    return parseAmount(allMatches[allMatches.length - 1][1]);
  }

  // ── SPARK parser ──────────────────────────────────────────────────────────

  /**
   * Parse a SPARK bill text and extract structured data.
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

    // --- Bill Number ---
    const billNoMatch = text.match(/Bill\s*No[.:\s]+([A-Z0-9\-\/]+)/i);
    if (billNoMatch) result.billNo = billNoMatch[1].trim();

    // --- DDO Code ---
    const ddoMatch = text.match(/DDO\s*Code[:\s]+([A-Z0-9]+)/i)
                  || text.match(/DDO[:\s]+([A-Z0-9]+)/i);
    if (ddoMatch) result.ddoCode = ddoMatch[1].trim();

    // --- Department ---
    const deptMatch = text.match(/Dept(?:artment)?[:\s]+([A-Za-z &]+?)(?:\s{2,}|\n|Bill|DDO)/i);
    if (deptMatch) result.department = deptMatch[1].trim();

    // --- Head of Account (Stricter regex lookaround to handle line endings) ---
    const hoaMatch = text.match(/(?<![0-9-])(\d{4}-\d{2}-\d{3}-\d{2}-\d{2}-\d{2}-\d{2})(?![0-9-])/);
    if (hoaMatch) {
      result.hoa = parseSparkHoA(hoaMatch[1]);
      result.rawHoA = hoaMatch[1];
    }

    // --- Net Sal ---
    const netSalMatch = text.match(/Net\s*Sal[:\s*]+([0-9,]+(?:\.\d{1,2})?)/i);
    if (netSalMatch) result.netAmount = parseAmount(netSalMatch[1]);

    return result.hoa ? result : null;
  }

  // ── BiMS parser ───────────────────────────────────────────────────────────

  /**
   * Parse a BiMS bill text and extract structured data.
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
    const billNoMatch = text.match(/(?:Bill|Voucher)\s*No[.:\s]+([A-Z0-9\-\/]+)/i);
    if (billNoMatch) result.billNo = billNoMatch[1].trim();

    // --- DDO Code ---
    const ddoMatch = text.match(/DDO\s*Code[:\s]+([A-Z0-9]+)/i)
                  || text.match(/DDO[:\s]+([A-Z0-9]+)/i);
    if (ddoMatch) result.ddoCode = ddoMatch[1].trim();

    // --- Department / Office ---
    const deptMatch = text.match(/(?:Dept|Department|Office)[:\s]+([A-Za-z &]+?)(?:\s{2,}|\n|DDO|Bill)/i);
    if (deptMatch) result.department = deptMatch[1].trim();

    // --- Head of Account (space-separated: 4 2 3 2 2 2 2) ---
    const hoaMatch = text.match(/\b(\d{4})\s+(\d{2})\s+(\d{3})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/);
    if (hoaMatch) {
      const parts = [hoaMatch[1], hoaMatch[2], hoaMatch[3], hoaMatch[4], hoaMatch[5], hoaMatch[6], hoaMatch[7]];
      result.hoa = parseBimsHoA(parts.join(" "));
      result.rawHoA = parts.join(" ");
    }

    // --- Net Amount ---
    const netMatch = text.match(/Net\s*Amount[:\s*]+([0-9,]+(?:\.\d{1,2})?)/i);
    if (netMatch) result.netAmount = parseAmount(netMatch[1]);

    return result.hoa ? result : null;
  }

  // ── Multi-HoA support ─────────────────────────────────────────────────────

  /**
   * Extract multiple HoA entries from SPARK text.
   */
  function _extractMultipleHoAsFromSpark(text) {
    const results = [];
    const hoaPattern = /(?<![0-9-])(\d{4}-\d{2}-\d{3}-\d{2}-\d{2}-\d{2}-\d{2})(?![0-9-])/g;
    let match;

    while ((match = hoaPattern.exec(text)) !== null) {
      const hoaStr = match[1];
      const hoa = parseSparkHoA(hoaStr);

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

      const slice = text.slice(match.index, match.index + 250);
      const netAmount = _extractAmountFromSlice(slice);

      results.push({ hoa, rawHoA: hoaStr, netAmount });
    }

    return results;
  }

  // ── Main entry point ──────────────────────────────────────────────────────

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