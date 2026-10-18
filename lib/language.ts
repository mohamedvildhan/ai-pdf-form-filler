import type { FillLanguage } from "@/lib/types";

/** Thaana block used for Dhivehi. */
export function containsThaana(text: string): boolean {
  return /[\u0780-\u07BF]/.test(text);
}

/**
 * Shared value rules — generic for any form. No form-specific field lists.
 * The model must infer each blank from the uploaded PDF + facts.
 */
export function valueSemanticsDirective(): string {
  return `VALUE RULES (any form):
- Infer every blank from the printed form itself (labels, sections, nearby instructions). No fixed field map.
- Missing/unknown: "". Never invent. No placeholders (@, N/A, empty social URLs, fake emails).
- Checkboxes / tick options: value exactly "true" or "false".
- Mutually exclusive option ticks: "true" on the matching option only.
- Date digit grids: 8 Latin digits DDMMYYYY when the form uses a day/month/year cell row.
- Keep machine identifiers Latin exactly as in facts: numbers, IDs, phones, emails, URLs, codes.
- Match facts by meaning + section context on THIS form (do not swap people/orgs across sections).`;
}

/** Gemini box_2d contract — layout-agnostic. */
export function box2dDirective(): string {
  return `COORDINATES (box_2d):
- [ymin, xmin, ymax, xmax] integers 0–1000 for THAT page, origin top-left.
- Cover the empty write area only (not the printed label).
- Checkbox: only the small tick square. Date grids: the full digit-cell row.
- Slight inset inside borders. Never table outer frames or page borders.`;
}

/**
 * Language instructions — user setting wins; model decides which blanks are prose vs identifiers.
 */
export function languageFillDirective(language: FillLanguage): string {
  switch (language) {
    case "en":
      return `OUTPUT LANGUAGE (user-selected): English (Latin) for free-text values.
- If a fact, pasted note, or current value is Dhivehi (Thaana), TRANSLATE it into clear natural English for free-text blanks.
- If a value is already English prose, keep/improve it in English (do not leave Thaana in free-text).
- Follow this form's own casing when obvious.
- Keep IDs, dates (digits), phones, emails, URLs, codes in Latin as in the facts (never invent translations for those).
- Checkboxes: "true" / "false".`;
    case "dv":
      return `OUTPUT LANGUAGE (user-selected): Dhivehi (Thaana) for free-text values.
- This user setting overrides printed "fill in English" banners for prose blanks.
- If a fact, pasted note, or current value is English (or any non-Thaana prose), TRANSLATE it into natural Thaana for free-text blanks.
- You decide from THIS form which blanks are free-text (Thaana) vs machine identifiers (keep Latin: dates as digits, IDs, phones, emails, URLs, codes, and blanks that clearly ask for a Latin/passport-style name).
- If a value is already Thaana, copy it exactly (do not re-spell).
- SPELLING LOCK (critical): the same person, company, island, or place MUST use the identical Thaana spelling in every field. Never mix letter variants for one name (e.g. do not write ޝ in one blank and ށ in another for the same word). If a SPELLING REFERENCE list is provided, copy those Thaana forms exactly whenever the entity matches.
- Checkboxes: "true" / "false".`;
    default: {
      const _exhaustive: never = language;
      throw new Error(`Unknown language: ${String(_exhaustive)}`);
    }
  }
}

/** Short banner for user-message parts. */
export function languageUserBanner(language: FillLanguage): string {
  switch (language) {
    case "en":
      return "FILL LANGUAGE (user-selected): English for free-text — translate Dhivehi/Thaana values into English. Keep Latin only for identifiers/dates/codes and passport-style Latin name blanks.";
    case "dv":
      return "FILL LANGUAGE (user-selected): Dhivehi (Thaana) for free-text — translate English facts/notes into Thaana. Overrides English-only banners. Keep Latin only for identifiers/dates/codes and passport-style Latin name blanks.";
    default: {
      const _exhaustive: never = language;
      throw new Error(`Unknown language: ${String(_exhaustive)}`);
    }
  }
}
