// Date helpers shared by server fill + client review UI.

/** Labels that clearly mean a DDMMYYYY date field. */
export function isDigitDateField(label: string, name: string): boolean {
  const s = `${label} ${name}`.toLowerCase();
  if (/time|datetime/.test(s)) return false;
  return /date\s*of\s*birth|\bd\.?\s*o\.?\s*b\b|birth\s*date|date\s*of\s*expir|expir(y|ation|es)?|passport.*expir|date\s*from|date\s*to|valid\s*(from|to|until)|issue\s*date|date\s*of\s*issue|^date$|^date_\d+$/i.test(
    s,
  );
}

/** Comb geometry or a clearly labeled date field. */
export function looksLikeDateBox(field: {
  label?: string;
  name: string;
  type?: string;
  geomKind?: string;
  wNorm?: number;
  hNorm?: number;
}): boolean {
  if (field.type === "checkbox") return false;
  if (field.geomKind === "comb") return true;
  if (isDigitDateField(field.label ?? "", field.name)) return true;
  // Wide shallow boxes are usually DDMMYYYY digit grids even without a label.
  const w = field.wNorm ?? 0;
  const h = field.hNorm ?? 0;
  if (w > 0.12 && h > 0 && h < 0.04 && w / h >= 5) return true;
  return false;
}

function looksLikeYear(n: number): boolean {
  return n >= 1900 && n <= 2100;
}

function looksLikeDayMonth(dd: number, mm: number): boolean {
  return dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12;
}

/**
 * Normalize a date-like value to 8 digits DDMMYYYY for combed date boxes.
 * Accepts 04/01/1994, 04-01-1994, 1994-01-04, 04011994, etc.
 */
export function toDigitDate(value: string): string {
  const raw = value.trim();
  if (!raw) return "";

  // Prefer structured parses before raw digit heuristics.
  const iso = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (iso) {
    return iso[3].padStart(2, "0") + iso[2].padStart(2, "0") + iso[1];
  }
  const dmy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) {
    return dmy[1].padStart(2, "0") + dmy[2].padStart(2, "0") + dmy[3];
  }
  const dmy2 = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/);
  if (dmy2) {
    const yy = Number(dmy2[3]);
    const yyyy = yy >= 50 ? `19${dmy2[3]}` : `20${dmy2[3]}`;
    return dmy2[1].padStart(2, "0") + dmy2[2].padStart(2, "0") + yyyy;
  }

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 8) {
    const yFirst = Number(digits.slice(0, 4));
    const dd = Number(digits.slice(0, 2));
    const mm = Number(digits.slice(2, 4));
    // YYYYMMDD → DDMMYYYY
    if (looksLikeYear(yFirst)) {
      return digits.slice(6, 8) + digits.slice(4, 6) + digits.slice(0, 4);
    }
    // Already DDMMYYYY
    if (looksLikeDayMonth(dd, mm)) return digits;
    return digits;
  }
  // Incomplete — do not invent a date from a bare year / DDMM.
  return "";
}

/** True if value looks like a stray year/date fragment that should not sit in text fields. */
export function isDateFragmentValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^\d{4}$/.test(v) && looksLikeYear(Number(v))) return true;
  if (/^\d{6,8}$/.test(v.replace(/\D/g, ""))) return true;
  if (/^\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?$/.test(v)) return true;
  return false;
}

/** Normalize for overlay/PDF — always Latin 0-9 DDMMYYYY (never Thaana digits). */
export function formatCombedDateDisplay(value: string): string {
  const digits = toDigitDate(value) || value.replace(/\D/g, "").slice(0, 8);
  return digits.length === 8 ? digits : value.replace(/[^\d]/g, "").slice(0, 8);
}

/** True when the field must stay Latin LTR (dates, IDs, phones, emails, etc.). */
export function isLatinLockField(label: string, name: string, value = ""): boolean {
  if (looksLikeDateBox({ label, name })) return true;
  const s = `${label} ${name}`.toLowerCase();
  // Machine / contact blanks — keep Latin (not free-text prose).
  if (
    /passport|mobile|phone|tel|email|e-?mail|twitter|facebook|url|http|www\.|reg\.?\s*no|permit|license|licence|id\s*card|\bid\b|number|no\.|code|checkbox|male|female|single|married|gender|sex\b/i.test(
      s,
    )
  ) {
    return true;
  }
  const v = value.trim();
  if (!v) return false;
  // Digit / phone-like strings
  if (/^[\d+\s().\-/]+$/.test(v)) return true;
  // Email / URL
  if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v)) return true;
  if (/^https?:\/\//i.test(v) || /^www\./i.test(v)) return true;
  // Alphanumeric codes that include a digit (e.g. A073047) — not plain English words
  if (/[0-9]/.test(v) && /^[A-Z0-9+/.:@_\-]+$/i.test(v)) return true;
  return false;
}
