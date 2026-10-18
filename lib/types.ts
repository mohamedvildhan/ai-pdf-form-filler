// Shared types for the PDF form filler.

export type FillMode = "acroform" | "created-acroform" | "overlay";

/** Latin PDF standard fonts (no custom font files needed). */
export type LatinFontFamily =
  | "helvetica"
  | "helvetica-bold"
  | "times"
  | "times-bold"
  | "courier"
  | "courier-bold";

/** Embedded Thaana fonts for Dhivehi text (files in assets/fonts/). */
export type ThaanaFontFamily = "bolhu" | "faruma" | "waheed";

export type FillFontFamily = LatinFontFamily | ThaanaFontFamily;

/** Language used when AI writes fillable text onto the form. */
export type FillLanguage = "en" | "dv";

export function isThaanaFont(family: FillFontFamily): family is ThaanaFontFamily {
  return family === "bolhu" || family === "faruma" || family === "waheed";
}

export interface FillStyle {
  fontFamily: FillFontFamily;
  /**
   * Font size in PDF points. Use 0 (or omit) for auto-fit to the field box.
   */
  fontSize: number;
  /**
   * Output language for AI-filled text values.
   * - en: English (Latin)
   * - dv: Dhivehi (Thaana) — uses an embedded Thaana font on the PDF
   */
  language: FillLanguage;
}

export const DEFAULT_FILL_STYLE: FillStyle = {
  fontFamily: "helvetica",
  fontSize: 0,
  language: "en",
};

export interface Fact {
  key: string;
  value: string;
}

export type AcroFieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "optionlist"
  | "button"
  | "signature"
  | "unknown";

export interface AcroFieldSpec {
  name: string;
  type: AcroFieldType;
  options?: string[];
  /**
   * Proposed value:
   * - text: the string to write
   * - checkbox: "true" | "false"
   * - radio / dropdown / optionlist: the selected option (export value)
   */
  value: string;
  reason?: string;
  /**
   * Geometry for fields we create on a flat PDF (normalized 0..1, origin top-left).
   * Present when mode is "created-acroform".
   */
  page?: number;
  xNorm?: number;
  yNorm?: number;
  wNorm?: number;
  hNorm?: number;
  /** Human label used when we invented the field name. */
  label?: string;
  /** Local geometry classification (comb = 8-cell date grid). */
  geomKind?: "text" | "checkbox" | "comb";
  /**
   * Per-digit cells for date grids (normalized 0..1, top-left).
   * When present, each digit is placed in its own cell (handles DD | MM | YYYY gaps).
   */
  combCells?: Array<{
    xNorm: number;
    yNorm: number;
    wNorm: number;
    hNorm: number;
  }>;
}

export interface OverlayPlacement {
  id: string;
  /** 0-based page index */
  page: number;
  /** Human readable description of what this is, e.g. "Full name" */
  label: string;
  /** Text to write into the blank space */
  value: string;
  /** When set, checkbox draws a tick instead of the word "true". */
  fieldType?: "text" | "checkbox" | "signature";
  /**
   * Target rectangle, normalized 0..1 relative to the page, origin TOP-LEFT
   * (matches the rendered image coordinate space).
   */
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  /** Optional explicit font size in PDF points; otherwise derived from the box height. */
  fontSize?: number;
  reason?: string;
}

export interface PageSize {
  /** PDF page size in points */
  width: number;
  height: number;
}

export interface NeededInfo {
  /** Field name (if known) */
  field?: string;
  /** Human-readable what we still need, e.g. "Date of birth" */
  label: string;
  reason?: string;
}

export interface AnalyzeResult {
  mode: FillMode;
  facts: Fact[];
  pages: PageSize[];
  fields?: AcroFieldSpec[];
  placements?: OverlayPlacement[];
  /**
   * Blank form page images (for positioning overlays). Prefer filledPreviews
   * for the user-facing viewer.
   */
  pagePreviews?: string[];
  /** Filled PDF rendered as page images — what the user should review. */
  filledPreviews?: string[];
  /**
   * When true, filledPreviews are blank form pages and the client draws
   * field values as live overlays (skips slow filled-PDF re-render).
   */
  liveOverlay?: boolean;
  /** Information still missing to complete the form. */
  neededInfo?: NeededInfo[];
  notes?: string;
}
