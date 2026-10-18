// Form inspection, AI value mapping, AcroForm filling and flat-PDF overlay.

import {
  LineCapStyle,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  TextAlignment,
  rgb,
  type PDFFont,
} from "pdf-lib";
import {
  geminiGenerateJson,
  type GeminiPart,
  type GeminiSchema,
} from "@/lib/gemini";
import {
  detectFormGeometry,
  type GeomCandidate,
} from "@/lib/form-geometry";
import {
  isDateFragmentValue,
  isDigitDateField,
  looksLikeDateBox,
  toDigitDate,
} from "@/lib/dates";
import {
  box2dDirective,
  containsThaana,
  languageFillDirective,
  languageUserBanner,
  valueSemanticsDirective,
} from "@/lib/language";
import { renderPdfToImages } from "@/lib/pdf-render";
import {
  extractFacts,
  factsToText,
  type SourceFile,
} from "@/lib/sources";
import { embedThaanaFont } from "@/lib/thaana-font";
import type {
  AcroFieldSpec,
  AcroFieldType,
  Fact,
  FillFontFamily,
  FillLanguage,
  FillStyle,
  OverlayPlacement,
} from "@/lib/types";
import { DEFAULT_FILL_STYLE, isThaanaFont } from "@/lib/types";

export { isDigitDateField, looksLikeDateBox, toDigitDate };

async function embedFillFont(
  doc: PDFDocument,
  family: FillFontFamily,
): Promise<PDFFont> {
  switch (family) {
    case "helvetica":
      return doc.embedFont(StandardFonts.Helvetica);
    case "helvetica-bold":
      return doc.embedFont(StandardFonts.HelveticaBold);
    case "times":
      return doc.embedFont(StandardFonts.TimesRoman);
    case "times-bold":
      return doc.embedFont(StandardFonts.TimesRomanBold);
    case "courier":
      return doc.embedFont(StandardFonts.Courier);
    case "courier-bold":
      return doc.embedFont(StandardFonts.CourierBold);
    case "bolhu":
    case "faruma":
    case "waheed":
      return embedThaanaFont(doc, family);
    default: {
      const _exhaustive: never = family;
      throw new Error(`Unknown font: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Form inspection
// ---------------------------------------------------------------------------

function fieldType(ctorName: string): AcroFieldType {
  switch (ctorName) {
    case "PDFTextField":
      return "text";
    case "PDFCheckBox":
      return "checkbox";
    case "PDFRadioGroup":
      return "radio";
    case "PDFDropdown":
      return "dropdown";
    case "PDFOptionList":
      return "optionlist";
    case "PDFButton":
      return "button";
    case "PDFSignature":
      return "signature";
    default:
      return "unknown";
  }
}

/** Read the AcroForm fields of a PDF (empty array when the PDF has no form). */
export function inspectForm(doc: PDFDocument): AcroFieldSpec[] {
  const form = doc.getForm();
  return form.getFields().map((field) => {
    const type = fieldType(field.constructor.name);
    const spec: AcroFieldSpec = {
      name: field.getName(),
      type,
      value: "",
    };
    if (
      field instanceof PDFDropdown ||
      field instanceof PDFOptionList ||
      field instanceof PDFRadioGroup
    ) {
      spec.options = field.getOptions();
    }
    return spec;
  });
}

/** Fields that can actually hold a value from the user's data. */
export function fillableFields(specs: AcroFieldSpec[]): AcroFieldSpec[] {
  return specs.filter(
    (s) => s.type !== "button" && s.type !== "signature" && s.type !== "unknown",
  );
}

// ---------------------------------------------------------------------------
// AI: map facts -> AcroForm field values
// ---------------------------------------------------------------------------

const FIELD_VALUES_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: {
        type: "STRING",
        description: "Exact field name from the input list.",
      },
      value: {
        type: "STRING",
        description:
          "Fill value only. Checkbox: exactly 'true' or 'false'. Date comb: 8 Latin digits DDMMYYYY. Choice: exactly one listed option. Unknown: ''.",
      },
      reason: {
        type: "STRING",
        description: "Optional short source-fact key used (omit prose).",
      },
    },
    required: ["name", "value"],
  },
};

function applyProposedValues(
  specs: AcroFieldSpec[],
  proposed: { name: string; value: string; reason?: string }[],
): AcroFieldSpec[] {
  const byName = new Map(proposed.map((p) => [p.name, p]));
  return specs.map((spec) => {
    const p = byName.get(spec.name);
    if (!p) return spec;
    let value = (p.value ?? "").trim();
    if (spec.type === "checkbox") {
      value = /^(true|yes|y|1|checked|on)$/i.test(value) ? "true" : "false";
    } else if (
      value &&
      (spec.geomKind === "comb" || looksLikeDateBox(spec))
    ) {
      const digits = toDigitDate(value);
      value = digits.length === 8 ? digits : value;
    }
    return { ...spec, value, reason: p.reason };
  });
}

const REVIEW_VALUES_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "Exact field name from the input list." },
      label: {
        type: "STRING",
        description:
          "Printed caption, preferably 'SECTION / Field name'. Never bare Field/Checkbox/Date.",
      },
      value: {
        type: "STRING",
        description:
          "Corrected value. Checkbox: true/false. Date comb: 8-digit DDMMYYYY. Unknown: ''.",
      },
      box_ok: {
        type: "BOOLEAN",
        description:
          "true if listed box_2d already covers the empty write area; false if it needs correction.",
      },
      box_2d: {
        type: "ARRAY",
        items: { type: "INTEGER" },
        description:
          "When box_ok=false: corrected [ymin,xmin,ymax,xmax] 0-1000 top-left write area only.",
      },
      issue: {
        type: "STRING",
        description: "Short issue tag if changed (e.g. box_on_label); else ''.",
      },
    },
    required: ["name", "label", "value", "box_ok"],
  },
};

function fieldReviewLine(f: AcroFieldSpec): string {
  const label = (f.label || f.name).trim();
  const val = (f.value ?? "").trim() || "(empty)";
  const page = f.page !== undefined ? ` page=${f.page + 1}` : "";
  let box = "";
  if (
    f.xNorm !== undefined &&
    f.yNorm !== undefined &&
    f.wNorm !== undefined &&
    f.hNorm !== undefined
  ) {
    const ymin = Math.round(f.yNorm * 1000);
    const xmin = Math.round(f.xNorm * 1000);
    const ymax = Math.round((f.yNorm + f.hNorm) * 1000);
    const xmax = Math.round((f.xNorm + f.wNorm) * 1000);
    box = ` box_2d=[${ymin},${xmin},${ymax},${xmax}]`;
  }
  return `- name="${f.name}" label="${label}" type=${f.type}${page}${box} current="${val}"`;
}

type ReviewRow = {
  name: string;
  label: string;
  value: string;
  box_ok: boolean;
  box_2d?: number[];
  issue?: string;
};

type ReviewPages = Awaited<ReturnType<typeof renderPdfToImages>>;

function appendPageRasters(
  parts: GeminiPart[],
  pages: ReviewPages | undefined,
  /** When set, only attach these 0-based page indexes (smaller, faster prompts). */
  onlyPages?: number[],
): void {
  if (!pages?.length) return;
  const indexes =
    onlyPages && onlyPages.length > 0
      ? [...new Set(onlyPages)].filter((i) => i >= 0 && i < pages.length)
      : pages.map((_, i) => i);
  for (const i of indexes) {
    parts.push(...pageRasterPart(pages[i], i, pages.length));
  }
}

/** Run async tasks with a concurrency limit (speeds multi-batch AI without flooding). */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/** One thorough review batch — boxes + values + missing fills. */
async function reviewFieldChunk(args: {
  chunk: AcroFieldSpec[];
  chunkIndex: number;
  chunkCount: number;
  facts: Fact[];
  language: FillLanguage;
  formPdf?: Uint8Array;
  pages?: ReviewPages;
  instructions?: string;
  mode: "full" | "missing";
}): Promise<ReviewRow[]> {
  const {
    chunk,
    chunkIndex,
    chunkCount,
    facts,
    language,
    formPdf,
    pages,
    instructions,
    mode,
  } = args;

  const emptyN = chunk.filter((f) => !(f.value ?? "").trim()).length;
  const instructionBlock = instructions?.trim()
    ? `\nUSER INSTRUCTIONS:\n${instructions.trim()}`
    : "";

  const parts: GeminiPart[] = [];
  if (formPdf && formPdf.length > 0) {
    parts.push({
      text:
        mode === "missing"
          ? `Re-read the form PDF + page images. These blanks are STILL EMPTY after review — fill any the facts support (batch ${chunkIndex + 1}/${chunkCount}).`
          : `Re-read the form PDF + page images. Verify BOX PLACEMENT and VALUES for batch ${chunkIndex + 1}/${chunkCount}. Also fill anything missing.`,
    });
    parts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: Buffer.from(formPdf).toString("base64"),
      },
    });
  }
  const pageIndexes = chunk
    .map((f) => f.page)
    .filter((p): p is number => typeof p === "number");
  appendPageRasters(parts, pages, pageIndexes);

  const modeBlock =
    mode === "missing"
      ? `MODE: missing fills only.
Each listed field is empty. Fill only when a KNOWN FACT clearly matches that blank/section.
Otherwise value "". Still set box_ok / box_2d.`
      : `MODE: audit.
For each field: (1) box_ok + corrected box_2d if needed, (2) fill if empty and a fact matches,
(3) fix wrong values/labels. Do not invent facts.`;

  parts.push({
    text: `QA batch ${chunkIndex + 1}/${chunkCount} (${emptyN} empty).
${modeBlock}

KNOWN FACTS:
${factsToText(facts)}

FIELDS:
${chunk.map(fieldReviewLine).join("\n")}

${valueSemanticsDirective()}
${box2dDirective()}
${languageFillDirective(language)}${instructionBlock}

One JSON row per field name.`,
  });

  const reviewed = await geminiGenerateJson<ReviewRow[]>({
    parts,
    schema: REVIEW_VALUES_SCHEMA,
    system: `You QA PDF form overlays against page images and known facts.
Tasks: correct write-area boxes, fill clearly supported empties, fix wrong values/labels.
Do not invent facts. Do not restyle text.`,
    temperature: 0,
    maxOutputTokens: 16384,
    timeoutMs: 240_000,
    role: "fill",
    thinkingLevel: "medium",
  });

  return Array.isArray(reviewed) ? reviewed : [];
}

function isGenericLabel(label: string | undefined): boolean {
  const t = (label ?? "").trim();
  if (!t) return true;
  return /^(field|checkbox|date|text|label|untitled|unknown)(_?\d+)?$/i.test(t);
}

/** Never replace a real printed label with a generic "Field". */
function pickBetterLabel(current: string | undefined, incoming: string | undefined): string {
  const a = (current ?? "").trim();
  const b = (incoming ?? "").trim();
  if (!b) return a || "Field";
  if (isGenericLabel(b) && a && !isGenericLabel(a)) return a;
  if (!a || isGenericLabel(a)) return b;
  if (b.includes("/") && !a.includes("/")) return b;
  if (b.length >= a.length + 6) return b;
  return a;
}

function applyReviewRows(
  fields: AcroFieldSpec[],
  reviewed: ReviewRow[],
): { fields: AcroFieldSpec[]; changes: number; boxFixes: number; fillFixes: number } {
  const byName = new Map(reviewed.map((r) => [r.name, r]));
  let changes = 0;
  let boxFixes = 0;
  let fillFixes = 0;
  const out = fields.map((f) => {
    const r = byName.get(f.name);
    if (!r) return f;
    const prevVal = (f.value ?? "").trim();
    const nextVal = r.value ?? "";
    const nextLabel = pickBetterLabel(f.label, r.label);
    let next: AcroFieldSpec = {
      ...f,
      label: nextLabel,
      value: nextVal,
      reason: r.issue?.trim() ? `review: ${r.issue.trim()}` : f.reason,
    };
    const shouldFixBox =
      r.box_ok === false &&
      Array.isArray(r.box_2d) &&
      f.xNorm !== undefined &&
      f.yNorm !== undefined &&
      f.wNorm !== undefined &&
      f.hNorm !== undefined;
    if (shouldFixBox) {
      const adj = applySafeAdjust(
        {
          xNorm: f.xNorm!,
          yNorm: f.yNorm!,
          wNorm: f.wNorm!,
          hNorm: f.hNorm!,
        },
        r.box_2d,
      );
      if (adj) {
        next = {
          ...next,
          xNorm: adj.xNorm,
          yNorm: adj.yNorm,
          wNorm: adj.wNorm,
          hNorm: adj.hNorm,
        };
        boxFixes += 1;
      }
    }
    if (!prevVal && (next.value ?? "").trim()) fillFixes += 1;
    if (
      next.value !== (f.value ?? "") ||
      next.label !== f.label ||
      next.xNorm !== f.xNorm ||
      next.yNorm !== f.yNorm ||
      next.wNorm !== f.wNorm ||
      next.hNorm !== f.hNorm
    ) {
      changes += 1;
    }
    return next;
  });
  return { fields: out, changes, boxFixes, fillFixes };
}

/**
 * After fill AI: verify box placement + catch missing fills (batched, with page images).
 */
export async function reviewFilledFields(
  fields: AcroFieldSpec[],
  facts: Fact[],
  language: FillLanguage,
  formPdf?: Uint8Array,
  instructions?: string,
  pages?: ReviewPages,
): Promise<AcroFieldSpec[]> {
  const reviewable = fields.filter(
    (f) => f.type === "text" || f.type === "checkbox" || f.type === "signature",
  );
  if (reviewable.length === 0 || facts.length === 0) return fields;

  const BATCH = 22;
  const chunks = chunkArray(reviewable, BATCH);
  let out = fields;
  let totalChanges = 0;
  let totalRows = 0;
  let totalBoxFixes = 0;
  let totalFillFixes = 0;

  const fullResults = await mapPool(chunks, 2, async (chunk, i) => {
    try {
      const reviewed = await reviewFieldChunk({
        chunk,
        chunkIndex: i,
        chunkCount: chunks.length,
        facts,
        language,
        formPdf,
        pages,
        instructions,
        mode: "full",
      });
      console.log(
        `[ai-review] batch ${i + 1}/${chunks.length}: ${reviewed.length} rows`,
      );
      return reviewed;
    } catch (err) {
      console.warn(`[ai-review] batch ${i + 1}/${chunks.length} failed:`, err);
      return [] as ReviewRow[];
    }
  });
  for (const reviewed of fullResults) {
    totalRows += reviewed.length;
    const applied = applyReviewRows(out, reviewed);
    out = applied.fields;
    totalChanges += applied.changes;
    totalBoxFixes += applied.boxFixes;
    totalFillFixes += applied.fillFixes;
  }

  // Second pass: only remaining empties — catch anything still missing.
  const stillEmpty = out.filter(
    (f) =>
      (f.type === "text" || f.type === "checkbox" || f.type === "signature") &&
      !(f.value ?? "").trim(),
  );
  if (stillEmpty.length > 0) {
    const emptyChunks = chunkArray(stillEmpty, BATCH);
    console.log(
      `[ai-review] missing-pass: ${stillEmpty.length} still empty — rechecking against facts`,
    );
    const missingResults = await mapPool(emptyChunks, 2, async (chunk, i) => {
      try {
        const reviewed = await reviewFieldChunk({
          chunk,
          chunkIndex: i,
          chunkCount: emptyChunks.length,
          facts,
          language,
          formPdf,
          pages,
          instructions,
          mode: "missing",
        });
        console.log(
          `[ai-review] missing batch ${i + 1}/${emptyChunks.length}: ${reviewed.length} rows`,
        );
        return reviewed;
      } catch (err) {
        console.warn(
          `[ai-review] missing batch ${i + 1}/${emptyChunks.length} failed:`,
          err,
        );
        return [] as ReviewRow[];
      }
    });
    for (const reviewed of missingResults) {
      totalRows += reviewed.length;
      const applied = applyReviewRows(out, reviewed);
      out = applied.fields;
      totalChanges += applied.changes;
      totalBoxFixes += applied.boxFixes;
      totalFillFixes += applied.fillFixes;
    }
  }

  const emptyLeft = out.filter(
    (f) =>
      (f.type === "text" || f.type === "checkbox" || f.type === "signature") &&
      !(f.value ?? "").trim(),
  ).length;
  console.log(
    `[ai-review] done: ${totalRows} rows, ${totalChanges} changed (boxes=${totalBoxFixes}, filled-missing=${totalFillFixes}, empty-left=${emptyLeft})`,
  );
  return out;
}

export async function proposeFieldValues(
  specs: AcroFieldSpec[],
  facts: Fact[],
  instructions?: string,
  language: FillLanguage = "en",
  /** When provided, the model reads the actual form PDF before filling. */
  formPdf?: Uint8Array,
): Promise<AcroFieldSpec[]> {
  const fields = fillableFields(specs);
  if (fields.length === 0) return specs;

  const fieldLines = fields
    .map((f) => {
      const opts = f.options?.length ? ` options=[${f.options.join(" | ")}]` : "";
      const label = f.label?.trim() ? ` label="${f.label.trim()}"` : "";
      const page =
        f.page !== undefined ? ` page=${f.page + 1}` : "";
      const kind = f.geomKind ? ` kind=${f.geomKind}` : "";
      return `- name="${f.name}" type=${f.type}${label}${page}${kind}${opts}`;
    })
    .join("\n");

  const system = `${languageUserBanner(language)}

You assign VALUES to already-labeled form fields from known facts.
Do NOT invent boxes, move coordinates, or redesign the form.
Match by each blank's printed label and section on THIS form. Prefer fill when evidence exists; else "".
${valueSemanticsDirective()}
${languageFillDirective(language)}`;

  const instructionBlock = instructions?.trim()
    ? `\n\nUSER INSTRUCTIONS (override defaults):\n${instructions.trim()}`
    : "";

  const parts: GeminiPart[] = [];
  if (formPdf && formPdf.length > 0) {
    parts.push({
      text: "Use this form PDF only for section/label context, then output values.",
    });
    parts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: Buffer.from(formPdf).toString("base64"),
      },
      mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
    });
  }
  parts.push({
    text: `${languageUserBanner(language)}

FIELDS (one value per name):
${fieldLines}

KNOWN FACTS:
${factsToText(facts)}${dateFactsForPrompt(facts)}
${languageFillDirective(language)}${instructionBlock}`,
  });

  const proposed = await geminiGenerateJson<
    { name: string; value: string; reason?: string }[]
  >({
    parts,
    schema: FIELD_VALUES_SCHEMA,
    system,
    temperature: 0,
    maxOutputTokens: 12288,
    timeoutMs: 70_000,
    role: "fill",
    thinkingLevel: "medium",
  });

  return applyProposedValues(specs, proposed);
}

/**
 * Rewrite existing free-text field values into the user-selected language.
 * Keeps boxes/labels; does not invent new fields. Identifiers stay Latin.
 */
export async function rewriteFieldsForLanguage(
  specs: AcroFieldSpec[],
  language: FillLanguage,
  formPdf?: Uint8Array,
  opts?: {
    forceProse?: boolean;
    /** Existing Thaana (or English) spellings to copy exactly for the same entities. */
    spellingContext?: Array<{ label?: string; value: string }>;
  },
): Promise<AcroFieldSpec[]> {
  const fields = fillableFields(specs).filter((f) => {
    if (f.type === "checkbox" || f.type === "signature") return false;
    return !!(f.value ?? "").trim();
  });
  if (fields.length === 0) return specs;

  const fieldLines = fields
    .map((f) => {
      const label = f.label?.trim() ? ` label="${f.label.trim()}"` : "";
      const kind = f.geomKind ? ` kind=${f.geomKind}` : "";
      return `- name="${f.name}" type=${f.type}${label}${kind} current="${(f.value ?? "").replace(/"/g, "'")}"`;
    })
    .join("\n");

  // Prefer longer Thaana forms already on the form / in facts as the canonical spelling.
  const spellingRefs = [
    ...(opts?.spellingContext ?? []),
    ...fields
      .filter((f) => containsThaana(f.value ?? ""))
      .map((f) => ({ label: f.label, value: f.value ?? "" })),
  ]
    .map((r) => ({
      label: (r.label ?? "").trim(),
      value: r.value.trim(),
    }))
    .filter((r) => r.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);

  const seenSpell = new Set<string>();
  const spellingLines = spellingRefs
    .filter((r) => {
      if (seenSpell.has(r.value)) return false;
      seenSpell.add(r.value);
      return true;
    })
    .slice(0, 40)
    .map((r) =>
      r.label
        ? `- (${r.label.replace(/"/g, "'")}) "${r.value.replace(/"/g, "'")}"`
        : `- "${r.value.replace(/"/g, "'")}"`,
    )
    .join("\n");

  const forceProse = opts?.forceProse === true;
  const system = `${languageUserBanner(language)}

You rewrite EXISTING field values into the user-selected fill language (bidirectional).
Do not move boxes. Do not invent new content. Empty stays empty (not listed).
- Free-text / prose: TRANSLATE into the selected language when the current value is in the other language (English ↔ Dhivehi/Thaana).
- If already in the target language, keep the meaning; do not leave the wrong script on free-text blanks.
- Machine identifiers (dates as digits, IDs, phones, emails, URLs, codes): keep Latin as-is.
${
  forceProse
    ? `- USER JUST TYPED THIS VALUE: you MUST translate free-text / job titles / ranks / addresses / names of people or places into the selected language. Do not leave English prose unchanged when the selected language is Dhivehi (or leave Thaana unchanged when English is selected). Only keep Latin for pure digit strings, emails, phones, and ID codes.`
    : `- Passport-style Latin name blanks may stay Latin when the form clearly requires Latin; otherwise translate free-text names.`
}
- SPELLING LOCK: one entity → one Thaana spelling everywhere. Never swap letter variants for the same name (ޝ vs ށ, etc.). When a SPELLING REFERENCE matches the entity, copy that Thaana substring/form exactly.
- Checkboxes are not in this list.
${languageFillDirective(language)}`;

  const parts: GeminiPart[] = [];
  if (formPdf && formPdf.length > 0) {
    parts.push({
      text: "Optional form PDF for label context only. Rewrite values per language rules.",
    });
    parts.push({
      inlineData: {
        mimeType: "application/pdf",
        data: Buffer.from(formPdf).toString("base64"),
      },
      mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
    });
  }
  parts.push({
    text: `${languageUserBanner(language)}

${
  spellingLines
    ? `SPELLING REFERENCES (copy these Thaana forms exactly when the same entity appears):\n${spellingLines}\n\n`
    : ""
}FIELDS TO REWRITE (return one value per name):
${fieldLines}`,
  });

  const proposed = await geminiGenerateJson<
    { name: string; value: string; reason?: string }[]
  >({
    parts,
    schema: FIELD_VALUES_SCHEMA,
    system,
    temperature: 0,
    maxOutputTokens: 12288,
    timeoutMs: 70_000,
    role: "fill",
    thinkingLevel: "medium",
  });

  return applyProposedValues(specs, proposed);
}

/**
 * AcroForm path: extract facts → one AI fill → user Review & edit.
 */
export async function extractFactsAndFillAcroForm(
  specs: AcroFieldSpec[],
  sources: SourceFile[],
  instructions?: string,
  language: FillLanguage = "en",
  formPdf?: Uint8Array,
): Promise<{ facts: Fact[]; fields: AcroFieldSpec[] }> {
  const fields = fillableFields(specs);
  if (fields.length === 0) {
    return { facts: [], fields: specs };
  }
  if (sources.length === 0) {
    return { facts: [], fields: specs };
  }

  const facts = await extractFacts(sources);
  const filled = await proposeFieldValues(
    specs,
    facts,
    instructions,
    language,
    formPdf,
  );
  return { facts, fields: filled };
}

// ---------------------------------------------------------------------------
// Fill an AcroForm
// ---------------------------------------------------------------------------

function sanitizeWinAnsi(text: string): string {
  // Helvetica (the default appearance font) only supports Latin-1.
  return text.replace(/[^\x00-\xFF]/g, "");
}

/** Keep printable text; allow Thaana when drawing with an embedded Unicode font. */
function sanitizeDrawText(text: string, unicodeFont: boolean): string {
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (unicodeFont || containsThaana(cleaned)) return cleaned;
  return sanitizeWinAnsi(cleaned);
}

/**
 * Pick a font size that fits inside a box (with padding), matching pdf-lib's
 * appearance layout so text neither overflows nor looks oversized.
 */
function fitFontSize(
  font: PDFFont,
  text: string,
  boxWidth: number,
  boxHeight: number,
  preferred = 0,
): number {
  const padX = Math.max(2, boxWidth * 0.04);
  const padY = Math.max(1.5, boxHeight * 0.12);
  const maxW = Math.max(4, boxWidth - padX * 2);
  const maxH = Math.max(4, boxHeight - padY * 2);

  // Cap by height first (≈0.72 of inner height looks centered and neat).
  const heightCap = Math.max(5, maxH * 0.72);
  let size = preferred > 0 ? Math.min(preferred, heightCap) : heightCap;
  size = Math.min(size, 18);

  const clean = text.trim() || " ";
  while (size > 5) {
    const width = font.widthOfTextAtSize(clean, size);
    const height = font.heightAtSize(size, { descender: false });
    if (width <= maxW && height <= maxH) break;
    size -= 0.25;
  }
  return Math.round(size * 100) / 100;
}

function widgetSize(field: PDFTextField): { width: number; height: number } | null {
  try {
    const widgets = field.acroField.getWidgets();
    const rect = widgets[0]?.getRectangle();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { width: rect.width, height: rect.height };
  } catch {
    return null;
  }
}

export async function fillAcroForm(
  doc: PDFDocument,
  specs: AcroFieldSpec[],
  flatten: boolean,
  style: FillStyle = DEFAULT_FILL_STYLE,
): Promise<Uint8Array> {
  const form = doc.getForm();
  const needsThaana =
    style.language === "dv" ||
    specs.some((s) => containsThaana(s.value ?? ""));
  const font = needsThaana
    ? await embedThaanaFont(doc, style.fontFamily)
    : await embedFillFont(doc, style.fontFamily);

  for (const spec of specs) {
    const value = (spec.value ?? "").trim();
    try {
      const field = form.getField(spec.name);
      if (field instanceof PDFTextField) {
        const dateField = isDigitDateField(spec.label ?? "", spec.name);
        let text = sanitizeDrawText(value, needsThaana);
        if (dateField) {
          text = toDigitDate(text);
          try {
            field.setMaxLength(8);
            field.enableCombing();
          } catch {
            // Some fields reject combing; still write digits.
          }
        }
        field.setText(text);
        field.setAlignment(
          dateField
            ? TextAlignment.Center
            : containsThaana(text)
              ? TextAlignment.Right
              : TextAlignment.Left,
        );

        // Prefer the real widget rectangle (most accurate); fall back to
        // detected norms when the field has no widgets yet.
        const widget = widgetSize(field);
        let boxW = widget?.width;
        let boxH = widget?.height;
        if ((!boxW || !boxH) && spec.wNorm !== undefined && spec.page !== undefined) {
          const pageSize = doc.getPage(spec.page).getSize();
          boxW = Math.max(spec.wNorm * pageSize.width, 8);
          boxH = Math.max(spec.hNorm! * pageSize.height, 8);
        }

        if (boxW && boxH && text) {
          // Combed dates: size from cell width (total/8), not full string width.
          const size = dateField
            ? fitFontSize(font, "0", boxW / 8, boxH, style.fontSize || 0)
            : fitFontSize(font, text, boxW, boxH, style.fontSize);
          try {
            field.setFontSize(size);
          } catch {
            // Some legacy fields reject DA updates.
          }
        } else if (style.fontSize > 0) {
          try {
            field.setFontSize(style.fontSize);
          } catch {
            // keep default
          }
        }
      } else if (field instanceof PDFCheckBox) {
        if (value.toLowerCase() === "true") field.check();
        else field.uncheck();
      } else if (
        field instanceof PDFDropdown ||
        field instanceof PDFRadioGroup ||
        field instanceof PDFOptionList
      ) {
        if (value) field.select(value);
      }
    } catch {
      // Ignore individual field errors (wrong option, locked field, etc.)
      // so one bad field never blocks the whole document.
    }
  }

  // Some forms embed a deprecated XFA layer; Adobe would render that (showing
  // blank fields) instead of our AcroForm values. Dropping it makes the values
  // appear everywhere.
  try {
    if (form.hasXFA()) form.deleteXFA();
  } catch {
    // Not all documents expose XFA helpers; ignore.
  }

  try {
    form.updateFieldAppearances(font);
  } catch {
    // Appearance refresh is best-effort; values are still stored.
  }

  if (flatten) {
    try {
      form.flatten();
    } catch {
      // Some malformed forms can't be flattened; keep them interactive.
    }
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// Flat PDF → geometry boxes → one AI correct+fill pass (fast path)
// ---------------------------------------------------------------------------

/** Layout-only: label + box align against listed geometry ids (no values). */
const GEOM_LAYOUT_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING", description: "Exact candidate id from the input list." },
      action: {
        type: "STRING",
        enum: ["keep", "adjust", "delete"],
        description: "keep=candidate OK; adjust=supply box_2d; delete=not a real blank",
      },
      box_2d: {
        type: "ARRAY",
        items: { type: "INTEGER" },
        description:
          "When action=adjust: [ymin,xmin,ymax,xmax] 0-1000 write area only",
      },
      label: {
        type: "STRING",
        description:
          "Printed caption, preferably 'SECTION / Field name'. Never bare Field/Checkbox/Date.",
      },
      field_type: {
        type: "STRING",
        enum: ["text", "checkbox", "signature"],
      },
    },
    required: ["id", "action", "label", "field_type"],
  },
};

/** Geometry id → label/adjust/value (index-matched candidates). */
const GEOM_ENHANCE_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING", description: "Exact candidate id from the input list." },
      action: {
        type: "STRING",
        enum: ["keep", "adjust", "delete"],
        description: "keep=candidate OK; adjust=supply box_2d; delete=not a real blank",
      },
      box_2d: {
        type: "ARRAY",
        items: { type: "INTEGER" },
        description:
          "When action=adjust: [ymin,xmin,ymax,xmax] 0-1000 write area only",
      },
      label: {
        type: "STRING",
        description:
          "Printed caption, preferably 'SECTION / Field name'. Never bare Field/Checkbox/Date.",
      },
      field_type: {
        type: "STRING",
        enum: ["text", "checkbox", "signature"],
      },
      value: {
        type: "STRING",
        description:
          "From facts or ''. Checkbox: true/false. Date comb: 8-digit DDMMYYYY.",
      },
    },
    required: ["id", "action", "label", "field_type", "value"],
  },
};

interface GeomEnhanceRow {
  id: string;
  action: "keep" | "adjust" | "delete";
  box_2d?: number[];
  label: string;
  field_type: "text" | "checkbox" | "signature";
  value?: string;
}

/**
 * Apply an AI box_2d. Geometry often sits on labels; the model must be able to
 * slide onto the real write area. Only reject absurd sizes / page jumps.
 */
function applySafeAdjust(
  c: { xNorm: number; yNorm: number; wNorm: number; hNorm: number },
  box2d: number[] | undefined,
): { xNorm: number; yNorm: number; wNorm: number; hNorm: number } | null {
  if (!Array.isArray(box2d) || box2d.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = box2d;
  if (![ymin, xmin, ymax, xmax].every((n) => Number.isFinite(n))) return null;
  const xNorm = clamp01(xmin / 1000);
  const yNorm = clamp01(ymin / 1000);
  const wNorm = clamp01((xmax - xmin) / 1000);
  const hNorm = clamp01((ymax - ymin) / 1000);
  if (wNorm < 0.008 || hNorm < 0.003 || wNorm > 0.96 || hNorm > 0.35) {
    return null;
  }
  const ocx = c.xNorm + c.wNorm / 2;
  const ocy = c.yNorm + c.hNorm / 2;
  const ncx = xNorm + wNorm / 2;
  const ncy = yNorm + hNorm / 2;
  // Allow large local corrections (label → blank). Reject only total page jumps
  // that usually mean the model mixed up field ids.
  if (Math.abs(ncx - ocx) > 0.55 || Math.abs(ncy - ocy) > 0.45) return null;
  return { xNorm, yNorm, wNorm, hNorm };
}

/**
 * After AI: scrub only — clear date fragments dumped into non-date fields,
 * normalize full DDMMYYYY the model already wrote. No fact→field backfill.
 */
function repairFieldsAfterAi(fields: AcroFieldSpec[]): AcroFieldSpec[] {
  const out = fields.map((f) => ({ ...f }));

  for (const f of out) {
    if (looksLikeDateBox(f)) continue;
    const v = (f.value ?? "").trim();
    if (isDateFragmentValue(v)) {
      f.value = "";
      continue;
    }
    // Strip empty social placeholders the model sometimes invents.
    if (
      /^https?:\/\/(www\.)?facebook\.com\/?$/i.test(v) ||
      /^https?:\/\/(www\.)?twitter\.com\/?$/i.test(v) ||
      /^https?:\/\/(www\.)?x\.com\/?$/i.test(v) ||
      v === "@"
    ) {
      f.value = "";
    }
  }

  for (const f of out) {
    if (!looksLikeDateBox(f)) continue;
    const digits = toDigitDate(f.value ?? "");
    if (digits.length === 8) {
      f.value = digits;
    } else if (digits.length > 0) {
      f.value = ""; // incomplete junk like "0401" — AI must supply full dates
    }
  }

  return out;
}

function slugFieldName(label: string, index: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `${base || "field"}_${index}`;
}

function candidatesToSpecs(candidates: GeomCandidate[]): AcroFieldSpec[] {
  return candidates.map((c, i) => ({
    name: `${c.kind}_${i}`,
    type: (c.kind === "checkbox" ? "checkbox" : "text") as AcroFieldType,
    label: c.kind === "comb" ? "Date" : c.kind === "checkbox" ? "Checkbox" : "Field",
    value: "",
    page: c.page,
    xNorm: c.xNorm,
    yNorm: c.yNorm,
    wNorm: c.wNorm,
    hNorm: c.hNorm,
    geomKind: c.kind,
  }));
}

/** Surface date-like facts so the model can place them into date blanks on any form. */
function dateFactsForPrompt(facts: Fact[]): string {
  const lines: string[] = [];
  for (const f of facts) {
    const digits = toDigitDate(f.value);
    if (digits.length !== 8) continue;
    lines.push(`- ${f.key}: ${f.value} → if this form uses a date grid, write ${digits} (DDMMYYYY)`);
  }
  if (lines.length === 0) return "";
  return `\nDATE-LIKE FACTS (use only where this form's labels ask for them):\n${lines.join("\n")}\n`;
}

function defaultKindLabel(kind: GeomCandidate["kind"]): string {
  switch (kind) {
    case "comb":
      return "Date";
    case "checkbox":
      return "Checkbox";
    case "text":
      return "Field";
    default: {
      const _exhaustive: never = kind;
      return String(_exhaustive);
    }
  }
}

function aiLabelOrFallback(
  raw: string | undefined,
  kind: GeomCandidate["kind"],
): string {
  const t = (raw ?? "").trim();
  if (!t || isGenericLabel(t)) return defaultKindLabel(kind);
  return t;
}

function rowCenter(row: GeomEnhanceRow): { x: number; y: number } | null {
  if (!Array.isArray(row.box_2d) || row.box_2d.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = row.box_2d;
  return { x: (xmin + xmax) / 2000, y: (ymin + ymax) / 2000 };
}

function findEnhanceRow(
  c: GeomCandidate,
  byId: Map<string, GeomEnhanceRow>,
  unused: Set<string>,
): GeomEnhanceRow | undefined {
  const direct = byId.get(c.id);
  if (direct && unused.has(c.id)) {
    unused.delete(c.id);
    return direct;
  }
  // Id mismatch fallback: nearest unused AI row on the same page.
  const cx = c.xNorm + c.wNorm / 2;
  const cy = c.yNorm + c.hNorm / 2;
  let best: GeomEnhanceRow | undefined;
  let bestDist = Infinity;
  for (const id of unused) {
    const row = byId.get(id);
    if (!row) continue;
    const center = rowCenter(row);
    if (!center) continue;
    const dist = Math.hypot(center.x - cx, center.y - cy);
    if (dist < bestDist && dist < 0.08) {
      bestDist = dist;
      best = row;
    }
  }
  if (best) {
    unused.delete(best.id);
    return best;
  }
  return undefined;
}

function geomRowsToFields(
  forAi: GeomCandidate[],
  candidates: GeomCandidate[],
  enhanced: GeomEnhanceRow[],
  maxAi: number,
): AcroFieldSpec[] {
  const byId = new Map<string, GeomEnhanceRow>();
  for (const r of enhanced) {
    if (r?.id) byId.set(r.id, r);
  }
  const unused = new Set(byId.keys());
  const usedNames = new Set<string>();
  const fields: AcroFieldSpec[] = [];

  forAi.forEach((c, i) => {
    const row = findEnhanceRow(c, byId, unused);
    if (row?.action === "delete") return;

    let xNorm = c.xNorm;
    let yNorm = c.yNorm;
    let wNorm = c.wNorm;
    let hNorm = c.hNorm;

    if (row?.action === "adjust") {
      const adj = applySafeAdjust(c, row.box_2d);
      if (adj) {
        xNorm = adj.xNorm;
        yNorm = adj.yNorm;
        wNorm = adj.wNorm;
        hNorm = adj.hNorm;
      }
    }

    const label = aiLabelOrFallback(row?.label, c.kind);
    const type: AcroFieldType =
      row?.field_type === "checkbox" || c.kind === "checkbox"
        ? "checkbox"
        : row?.field_type === "signature"
          ? "signature"
          : "text";

    let name = slugFieldName(label, i);
    while (usedNames.has(name)) name = `${name}_x`;
    usedNames.add(name);

    let value = (row?.value ?? "").trim();
    if (type === "checkbox") {
      value = /^(true|yes|y|1|checked|on)$/i.test(value) ? "true" : "false";
    } else if (
      type === "text" &&
      value &&
      (c.kind === "comb" ||
        looksLikeDateBox({ label, name, geomKind: c.kind }))
    ) {
      const digits = toDigitDate(value);
      value = digits.length === 8 ? digits : "";
    } else if (type === "text" && value && isDateFragmentValue(value)) {
      if (!looksLikeDateBox({ label, name, geomKind: c.kind })) {
        value = "";
      }
    }

    fields.push({
      name,
      type,
      label,
      value,
      page: c.page,
      xNorm,
      yNorm,
      wNorm,
      hNorm,
      geomKind: c.kind,
    });
  });

  for (let i = maxAi; i < candidates.length; i++) {
    const c = candidates[i];
    fields.push({
      name: `${c.kind}_${i}`,
      type: c.kind === "checkbox" ? "checkbox" : "text",
      label: defaultKindLabel(c.kind),
      value: "",
      page: c.page,
      xNorm: c.xNorm,
      yNorm: c.yNorm,
      wNorm: c.wNorm,
      hNorm: c.hNorm,
      geomKind: c.kind,
    });
  }

  return fields;
}

const LABEL_ONLY_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: { type: "STRING", description: "Exact field name from the input list." },
      label: {
        type: "STRING",
        description:
          "Printed caption only, preferably 'SECTION / Field name'. Never bare Field/Checkbox/Date.",
      },
    },
    required: ["name", "label"],
  },
};

/**
 * Restore real form labels for any blanks still stuck on generic "Field".
 * Runs after fill so the corrections panel shows proper names again.
 */
async function relabelGenericFields(
  fields: AcroFieldSpec[],
  formPdf: Uint8Array,
  pages?: ReviewPages,
): Promise<AcroFieldSpec[]> {
  const needs = fields.filter((f) => isGenericLabel(f.label));
  if (needs.length === 0) return fields;

  const BATCH = 28;
  const chunks = chunkArray(needs, BATCH);
  let out = fields;

  const labelResults = await mapPool(chunks, 2, async (chunk, i) => {
    try {
      const parts: GeminiPart[] = [
        {
          text: `Label-only task (batch ${i + 1}/${chunks.length}).
For each blank, return the printed caption (prefer "SECTION / Field name").
Do not fill values. Do not move boxes.`,
        },
        {
          inlineData: {
            mimeType: "application/pdf",
            data: Buffer.from(formPdf).toString("base64"),
          },
          mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
        },
      ];
      const pageIndexes = chunk
        .map((f) => f.page)
        .filter((p): p is number => typeof p === "number");
      appendPageRasters(parts, pages, pageIndexes);
      parts.push({
        text: `BLANKS NEEDING LABELS:\n${chunk
          .map((f) => {
            const page = f.page !== undefined ? ` page=${f.page + 1}` : "";
            let box = "";
            if (
              f.xNorm !== undefined &&
              f.yNorm !== undefined &&
              f.wNorm !== undefined &&
              f.hNorm !== undefined
            ) {
              const ymin = Math.round(f.yNorm * 1000);
              const xmin = Math.round(f.xNorm * 1000);
              const ymax = Math.round((f.yNorm + f.hNorm) * 1000);
              const xmax = Math.round((f.xNorm + f.wNorm) * 1000);
              box = ` box_2d=[${ymin},${xmin},${ymax},${xmax}]`;
            }
            return `- name="${f.name}" kind=${f.geomKind ?? f.type}${page}${box} current_label="${f.label}"`;
          })
          .join("\n")}`,
      });

      const labeled = await geminiGenerateJson<{ name: string; label: string }[]>(
        {
          parts,
          schema: LABEL_ONLY_SCHEMA,
          system: `You assign printed labels to form blanks. No values, no coordinates.
Never return bare Field, Checkbox, or Date.`,
          temperature: 0,
          maxOutputTokens: 8192,
          timeoutMs: 120_000,
          role: "fill",
          thinkingLevel: "low",
        },
      );
      console.log(
        `[ai-label] batch ${i + 1}/${chunks.length}: ${Array.isArray(labeled) ? labeled.length : 0} labels`,
      );
      return Array.isArray(labeled) ? labeled : [];
    } catch (err) {
      console.warn(`[ai-label] batch ${i + 1} failed:`, err);
      return [] as { name: string; label: string }[];
    }
  });

  for (const labeled of labelResults) {
    const byName = new Map(labeled.map((r) => [r.name, r.label]));
    out = out.map((f) => {
      const next = byName.get(f.name);
      if (!next?.trim() || isGenericLabel(next)) return f;
      const label = pickBetterLabel(f.label, next);
      if (label === f.label) return f;
      return { ...f, label };
    });
  }

  const left = out.filter((f) => isGenericLabel(f.label)).length;
  console.log(`[ai-label] done: ${left} still generic of ${out.length}`);
  return out;
}

function candidateLine(c: GeomCandidate): string {
  const ymin = Math.round(c.yNorm * 1000);
  const xmin = Math.round(c.xNorm * 1000);
  const ymax = Math.round((c.yNorm + c.hNorm) * 1000);
  const xmax = Math.round((c.xNorm + c.wNorm) * 1000);
  const combNote =
    c.kind === "comb"
      ? " ← segmented date cells: one value = full date digits for the whole control"
      : "";
  return `- id=${c.id} kind=${c.kind} page=${c.page + 1} box_2d=[${ymin},${xmin},${ymax},${xmax}]${combNote}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function pageRasterPart(
  page: Awaited<ReturnType<typeof renderPdfToImages>>[number],
  pageIndex: number,
  pageCount: number,
): GeminiPart[] {
  const parts: GeminiPart[] = [
    {
      text: `--- Form page ${pageIndex + 1} of ${pageCount} (focus on blanks on THIS page; box_2d is 0-1000 for THIS page only) ---`,
    },
  ];
  if (page.aiJpeg && page.aiJpeg.length > 0) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: page.aiJpeg.toString("base64"),
      },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    });
  } else {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: page.png.toString("base64"),
      },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    });
  }
  return parts;
}

/**
 * Label + fill one chunk of blanks. Smaller batches avoid truncated JSON that
 * left later fields as unlabeled "Field" with empty values.
 */
async function enhanceCandidateChunk(args: {
  formPdf: Uint8Array;
  page: Awaited<ReturnType<typeof renderPdfToImages>>[number];
  pageIndex: number;
  pageCount: number;
  chunk: GeomCandidate[];
  chunkIndex: number;
  chunkCount: number;
  facts: Fact[];
  language: FillLanguage;
  instructions?: string;
}): Promise<GeomEnhanceRow[]> {
  const {
    formPdf,
    page,
    pageIndex,
    pageCount,
    chunk,
    chunkIndex,
    chunkCount,
    facts,
    language,
    instructions,
  } = args;

  const instructionBlock = instructions?.trim()
    ? `\nUSER INSTRUCTIONS:\n${instructions.trim()}`
    : "";

  const system = `You map listed geometry candidate ids on ONE page: label, optional box adjust, and value.
Work ONLY on the listed ids (index matching). Prefer action=keep; use adjust only when the candidate is off the write area.
${valueSemanticsDirective()}
${box2dDirective()}
${languageFillDirective(language)}`;

  const rows = await geminiGenerateJson<GeomEnhanceRow[]>({
    parts: [
      {
        text: `Page ${pageIndex + 1}/${pageCount}, batch ${chunkIndex + 1}/${chunkCount}.
For EACH listed id: label + action + value ("" if unknown).`,
      },
      {
        inlineData: {
          mimeType: "application/pdf",
          data: Buffer.from(formPdf).toString("base64"),
        },
        mediaResolution: "MEDIA_RESOLUTION_HIGH",
      },
      ...pageRasterPart(page, pageIndex, pageCount),
      {
        text: `CANDIDATE IDS:
${chunk.map(candidateLine).join("\n")}

KNOWN FACTS:
${factsToText(facts)}
${dateFactsForPrompt(facts)}
${instructionBlock}`,
      },
    ],
    schema: GEOM_ENHANCE_SCHEMA,
    system,
    temperature: 0,
    maxOutputTokens: 16384,
    timeoutMs: 180_000,
    role: "fill",
    thinkingLevel: "medium",
  });

  return Array.isArray(rows) ? rows : [];
}

/**
 * Label + align boxes on one page (no values). Smaller JSON → better accuracy.
 */
async function layoutPageCandidates(args: {
  formPdf: Uint8Array;
  page: Awaited<ReturnType<typeof renderPdfToImages>>[number];
  pageIndex: number;
  pageCount: number;
  chunk: GeomCandidate[];
  language: FillLanguage;
  instructions?: string;
}): Promise<GeomEnhanceRow[]> {
  const { formPdf, page, pageIndex, pageCount, chunk, language, instructions } =
    args;
  if (chunk.length === 0) return [];

  const instructionBlock = instructions?.trim()
    ? `\nUSER INSTRUCTIONS:\n${instructions.trim()}`
    : "";

  const system = `Layout-only: map each listed geometry id to a printed label and box action.
Do NOT fill values. Prefer action=keep; adjust only when the candidate is not on the write area; delete false positives.
Labels: prefer "SECTION / Field name". Never bare Field/Checkbox/Date.
${box2dDirective()}
${languageFillDirective(language)}`;

  const rows = await geminiGenerateJson<GeomEnhanceRow[]>({
    parts: [
      {
        text: `Page ${pageIndex + 1}/${pageCount}: label + align only (no values). One row per id.`,
      },
      {
        inlineData: {
          mimeType: "application/pdf",
          data: Buffer.from(formPdf).toString("base64"),
        },
        mediaResolution: "MEDIA_RESOLUTION_HIGH",
      },
      ...pageRasterPart(page, pageIndex, pageCount),
      {
        text: `CANDIDATE IDS:
${chunk.map(candidateLine).join("\n")}
${instructionBlock}`,
      },
    ],
    schema: GEOM_LAYOUT_SCHEMA,
    system,
    temperature: 0,
    maxOutputTokens: 12288,
    timeoutMs: 55_000,
    role: "fill",
    thinkingLevel: "medium",
  });

  return Array.isArray(rows) ? rows : [];
}

/**
 * Flat-form path — accurate + ~90–120s:
 * 1) Local geometry detects blank rectangles
 * 2) AI layout (per page, parallel): label + align boxes only
 * 3) AI fill: map facts → labeled fields (no geometry noise)
 * 4) Light scrub — user Review & edit for anything left
 */
export async function detectAndMapFlatFields(
  formPdf: Uint8Array,
  pageCount: number,
  facts: Fact[],
  instructions?: string,
  language: FillLanguage = "en",
  /** Pre-rendered pages — avoids a second render when caller already has them. */
  preRendered?: Awaited<ReturnType<typeof renderPdfToImages>>,
): Promise<AcroFieldSpec[]> {
  const t0 = Date.now();
  const pages = preRendered ?? (await renderPdfToImages(formPdf, 2));
  const candidates = await detectFormGeometry(pages);
  console.log(
    `[geometry] ${candidates.length} boxes in ${Date.now() - t0}ms (pages=${pages.length})`,
  );

  if (candidates.length === 0) {
    return [];
  }

  // Layout per page in parallel — focused job, smaller JSON, better boxes/labels.
  const byPage = new Map<number, GeomCandidate[]>();
  for (const c of candidates) {
    const list = byPage.get(c.page) ?? [];
    list.push(c);
    byPage.set(c.page, list);
  }

  const layoutRows: GeomEnhanceRow[] = [];
  try {
    const pageJobs = [...byPage.entries()].map(async ([pageIndex, chunk]) => {
      const page = pages[pageIndex];
      if (!page) return [] as GeomEnhanceRow[];
      try {
        const rows = await layoutPageCandidates({
          formPdf,
          page,
          pageIndex,
          pageCount: pages.length,
          chunk,
          language,
          instructions,
        });
        console.log(
          `[layout] page ${pageIndex + 1}: ${rows.length}/${chunk.length} rows in ${Date.now() - t0}ms`,
        );
        return rows;
      } catch (err) {
        console.warn(`[layout] page ${pageIndex + 1} failed:`, err);
        return [] as GeomEnhanceRow[];
      }
    });
    for (const rows of await Promise.all(pageJobs)) {
      layoutRows.push(...rows);
    }
  } catch (err) {
    console.warn("[detectAndMapFlatFields] layout failed:", err);
    return repairFieldsAfterAi(candidatesToSpecs(candidates));
  }

  let fields = repairFieldsAfterAi(
    geomRowsToFields(candidates, candidates, layoutRows, candidates.length),
  );
  const labeledN = fields.filter((f) => !isGenericLabel(f.label)).length;
  console.log(
    `[layout] ${fields.length} fields, ${labeledN} labeled, ${layoutRows.length} AI rows in ${Date.now() - t0}ms`,
  );

  // Fill pass: facts → values only (labels/boxes already set).
  if (facts.length > 0) {
    try {
      fields = repairFieldsAfterAi(
        await proposeFieldValues(
          fields,
          facts,
          instructions,
          language,
          formPdf,
        ),
      );
    } catch (err) {
      console.warn("[detectAndMapFlatFields] fill pass failed:", err);
    }
  }

  const filledN = fields.filter((f) => (f.value ?? "").trim()).length;
  console.log(
    `[geometry+ai] layout+fill ${fields.length} fields, ${labeledN} labeled, ${filledN} filled in ${Date.now() - t0}ms`,
  );
  return fields;
}

/**
 * Fill a flat PDF by drawing transparent text / checkmarks at detected boxes.
 * We intentionally avoid AcroForm widgets here — pdf-lib paints white field
 * backgrounds that look wrong on grey/scanned forms.
 */
export async function createAndFillAcroForm(
  doc: PDFDocument,
  specs: AcroFieldSpec[],
  _flatten: boolean,
  style: FillStyle = DEFAULT_FILL_STYLE,
): Promise<Uint8Array> {
  const latinFont = await embedFillFont(
    doc,
    isThaanaFont(style.fontFamily) ? "helvetica" : style.fontFamily,
  );
  const needsThaana =
    style.language === "dv" ||
    specs.some((s) => containsThaana(s.value ?? ""));
  const thaanaFont = needsThaana
    ? await embedThaanaFont(doc, style.fontFamily)
    : null;
  const pages = doc.getPages();
  const ink = rgb(0.05, 0.07, 0.2);

  for (const spec of specs) {
    if (
      spec.page === undefined ||
      spec.xNorm === undefined ||
      spec.yNorm === undefined ||
      spec.wNorm === undefined ||
      spec.hNorm === undefined
    ) {
      continue;
    }
    const page = pages[spec.page];
    if (!page) continue;

    const { width, height } = page.getSize();
    const pad = 1.5;
    const boxW = Math.max(spec.wNorm * width - pad * 2, 8);
    const boxH = Math.max(spec.hNorm * height - pad * 2, 6);
    const boxLeft = spec.xNorm * width + pad;
    const boxTopFromTop = spec.yNorm * height + pad;
    const boxBottomPdf = height - (boxTopFromTop + boxH);

    if (spec.type === "checkbox") {
      if (!isCheckedValue(spec.value)) continue;
      drawCheckboxMark(page, boxLeft, boxBottomPdf, boxW, boxH, ink);
      continue;
    }

    if (spec.type !== "text" && spec.type !== "signature") continue;

    const rawValue = (spec.value ?? "").trim();
    if (!rawValue) continue;

    const dateField = looksLikeDateBox(spec);
    if (dateField) {
      const digits =
        toDigitDate(rawValue) || rawValue.replace(/\D/g, "").slice(0, 8);
      drawCombedDigits(
        page,
        latinFont,
        digits,
        boxLeft,
        boxBottomPdf,
        boxW,
        boxH,
        style.fontSize,
        ink,
        height,
        spec.combCells,
      );
      continue;
    }

    drawBoxText(
      page,
      rawValue,
      boxLeft,
      boxBottomPdf,
      boxW,
      boxH,
      style.fontSize,
      latinFont,
      thaanaFont,
      ink,
    );
  }

  return doc.save();
}

function isCheckedValue(value: string): boolean {
  return /^(true|yes|y|1|checked|on)$/i.test((value ?? "").trim());
}

/**
 * Draw a checkmark with lines — StandardFonts are WinAnsi-only and cannot
 * encode "✓", which previously made checked boxes vanish (and aborted fill).
 */
function drawCheckboxMark(
  page: ReturnType<PDFDocument["getPages"]>[number],
  boxLeft: number,
  boxBottom: number,
  boxW: number,
  boxH: number,
  color: ReturnType<typeof rgb>,
): void {
  const side = Math.min(boxW, boxH);
  const left = boxLeft + (boxW - side) / 2;
  const bottom = boxBottom + (boxH - side) / 2;
  const thickness = Math.max(1.2, side * 0.14);

  // Short stroke + long stroke forming a ✓ (no Unicode — WinAnsi fonts can't encode it)
  page.drawLine({
    start: { x: left + side * 0.18, y: bottom + side * 0.48 },
    end: { x: left + side * 0.42, y: bottom + side * 0.22 },
    thickness,
    color,
    lineCap: LineCapStyle.Round,
  });
  page.drawLine({
    start: { x: left + side * 0.42, y: bottom + side * 0.22 },
    end: { x: left + side * 0.82, y: bottom + side * 0.78 },
    thickness,
    color,
    lineCap: LineCapStyle.Round,
  });
}

/** Draw date digits — prefer real per-cell boxes when available (DD|MM|YYYY gaps). */
function drawCombedDigits(
  page: ReturnType<PDFDocument["getPages"]>[number],
  font: PDFFont,
  digits: string,
  boxLeft: number,
  boxBottom: number,
  boxW: number,
  boxH: number,
  preferredSize: number,
  color: ReturnType<typeof rgb>,
  pageHeight: number,
  combCells?: AcroFieldSpec["combCells"],
): void {
  const padded = (toDigitDate(digits) || digits.replace(/\D/g, ""))
    .padEnd(8, " ")
    .slice(0, 8);

  if (combCells && combCells.length >= 6) {
    const pageW = page.getSize().width;
    const n = Math.min(8, combCells.length);
    for (let i = 0; i < n; i++) {
      const ch = padded[i];
      if (!ch || ch === " ") continue;
      const cell = combCells[i];
      const cellW = Math.max(4, cell.wNorm * pageW);
      const cellH = Math.max(4, cell.hNorm * pageHeight);
      const cellLeft = cell.xNorm * pageW;
      const cellBottom = pageHeight - (cell.yNorm * pageHeight + cellH);
      const size = fitFontSize(font, "0", cellW * 0.82, cellH * 0.88, preferredSize);
      const textHeight = font.heightAtSize(size, { descender: false });
      const tw = font.widthOfTextAtSize(ch, size);
      page.drawText(ch, {
        x: cellLeft + (cellW - tw) / 2,
        y: cellBottom + (cellH - textHeight) / 2,
        size,
        font,
        color,
      });
    }
    return;
  }

  const cells = 8;
  const cellW = boxW / cells;
  const size = fitFontSize(font, "0", cellW * 0.85, boxH * 0.9, preferredSize);
  const textHeight = font.heightAtSize(size, { descender: false });
  const baseline = boxBottom + (boxH - textHeight) / 2;

  for (let i = 0; i < cells; i++) {
    const ch = padded[i];
    if (!ch || ch === " ") continue;
    const tw = font.widthOfTextAtSize(ch, size);
    page.drawText(ch, {
      x: boxLeft + i * cellW + (cellW - tw) / 2,
      y: baseline,
      size,
      font,
      color,
    });
  }
}

// ---------------------------------------------------------------------------
// AI: locate where to write on a flat (field-less) page (overlay fallback)
// ---------------------------------------------------------------------------

const PLACEMENTS_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      page: {
        type: "INTEGER",
        description: "1-based page index for this blank.",
      },
      label: {
        type: "STRING",
        description:
          "Printed caption, preferably 'SECTION / Field name'. Never bare Field/Checkbox/Date.",
      },
      value: {
        type: "STRING",
        description:
          "From facts, or ''. Checkbox: 'true'|'false'. Date comb: 8 Latin digits DDMMYYYY when known.",
      },
      field_type: {
        type: "STRING",
        enum: ["text", "checkbox", "signature"],
        description:
          "checkbox = small tick square. text = write-in or date digit row. signature = sign line.",
      },
      box_2d: {
        type: "ARRAY",
        description:
          "[ymin,xmin,ymax,xmax] integers 0-1000 top-left of THIS page; empty write area only.",
        items: { type: "INTEGER" },
      },
    },
    required: ["page", "label", "value", "field_type", "box_2d"],
  },
};

interface RawPlacement {
  page: number;
  label: string;
  value: string;
  field_type?: "text" | "checkbox" | "signature";
  box_2d: number[];
}

const DATE_DIGIT_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name: {
        type: "STRING",
        description: "Exact field name from the input list.",
      },
      box_2d: {
        type: "ARRAY",
        items: { type: "INTEGER" },
        description:
          "Outer [ymin,xmin,ymax,xmax] 0-1000 covering all 8 digit cells only (not DD/MM/YYYY captions).",
      },
      digit_boxes: {
        type: "ARRAY",
        description:
          "Exactly 8 boxes left→right (D,D,M,M,Y,Y,Y,Y). Each [ymin,xmin,ymax,xmax] 0-1000 on that page.",
        items: {
          type: "ARRAY",
          items: { type: "INTEGER" },
        },
      },
    },
    required: ["name", "box_2d", "digit_boxes"],
  },
};

/**
 * Focused AI pass: stare at each date grid and return the 8 digit-cell boxes.
 * Geometry cells win when already present; this fills gaps / corrects misses.
 */
export async function refineDateDigitBoxes(
  formPdf: Uint8Array,
  pages: Awaited<ReturnType<typeof renderPdfToImages>>,
  fields: AcroFieldSpec[],
): Promise<AcroFieldSpec[]> {
  const dates = fields.filter(
    (f) =>
      f.page !== undefined &&
      (f.geomKind === "comb" || looksLikeDateBox(f)) &&
      (toDigitDate(f.value ?? "").length === 8 || f.geomKind === "comb"),
  );
  if (dates.length === 0) return fields;

  const lines = dates
    .map((f) => {
      const ymin = Math.round((f.yNorm ?? 0) * 1000);
      const xmin = Math.round((f.xNorm ?? 0) * 1000);
      const ymax = Math.round(((f.yNorm ?? 0) + (f.hNorm ?? 0.02)) * 1000);
      const xmax = Math.round(((f.xNorm ?? 0) + (f.wNorm ?? 0.1)) * 1000);
      const digits = toDigitDate(f.value ?? "");
      return `- name="${f.name}" label="${f.label ?? ""}" value="${digits}" approx_box_2d=[${ymin},${xmin},${ymax},${xmax}] cells=${f.combCells?.length ?? 0}`;
    })
    .join("\n");

  const pageIndexes = [...new Set(dates.map((f) => f.page!).filter((p) => p >= 0))];
  const parts: GeminiPart[] = [
    {
      text: `Date-grid geometry only. For each listed field name, return outer box_2d and exactly 8 digit_boxes (left→right DDMMYYYY cells). No values, no labels.`,
    },
    {
      inlineData: {
        mimeType: "application/pdf",
        data: Buffer.from(formPdf).toString("base64"),
      },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    },
  ];
  for (const pi of pageIndexes) {
    const page = pages[pi];
    if (page) parts.push(...pageRasterPart(page, pi, pages.length));
  }
  parts.push({ text: `DATE FIELDS:\n${lines}` });

  try {
    const rows = await geminiGenerateJson<
      { name: string; box_2d: number[]; digit_boxes: number[][] }[]
    >({
      parts,
      schema: DATE_DIGIT_SCHEMA,
      system: `You locate printed date digit cells only.
digit_boxes length MUST be 8, left-to-right (D D M M Y Y Y Y), one writable square each.
Ignore DD/MM/YYYY captions. No fill values.
${box2dDirective()}`,
      temperature: 0,
      maxOutputTokens: 8192,
      timeoutMs: 55_000,
      role: "fill",
      thinkingLevel: "medium",
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    });

    if (!Array.isArray(rows) || rows.length === 0) return fields;
    const byName = new Map(rows.map((r) => [r.name, r]));

    return fields.map((f) => {
      const row = byName.get(f.name);
      if (!row) return f;
      const digitBoxes = Array.isArray(row.digit_boxes) ? row.digit_boxes : [];
      // Need a full 8-cell row; otherwise keep geometry cells.
      if (digitBoxes.length < 8) return f;

      const cells = digitBoxes.slice(0, 8).map((b) => {
        const [ymin, xmin, ymax, xmax] = b;
        return {
          xNorm: clamp01(xmin / 1000),
          yNorm: clamp01(ymin / 1000),
          wNorm: clamp01((xmax - xmin) / 1000),
          hNorm: clamp01((ymax - ymin) / 1000),
        };
      });

      // Reject absurd tiny/huge cells.
      const ok = cells.every(
        (c) =>
          c.wNorm >= 0.004 &&
          c.hNorm >= 0.004 &&
          c.wNorm <= 0.08 &&
          c.hNorm <= 0.06,
      );
      if (!ok) return f;

      // Cells must be left→right ordered on roughly one row.
      for (let i = 1; i < cells.length; i++) {
        if (cells[i].xNorm + 0.002 < cells[i - 1].xNorm) return f;
      }

      const x0 = Math.min(...cells.map((c) => c.xNorm));
      const y0 = Math.min(...cells.map((c) => c.yNorm));
      const x1 = Math.max(...cells.map((c) => c.xNorm + c.wNorm));
      const y1 = Math.max(...cells.map((c) => c.yNorm + c.hNorm));

      return {
        ...f,
        xNorm: x0,
        yNorm: y0,
        wNorm: Math.max(0.01, x1 - x0),
        hNorm: Math.max(0.008, y1 - y0),
        geomKind: "comb" as const,
        combCells: cells,
      };
    });
  } catch (err) {
    console.warn("[refineDateDigitBoxes] failed:", err);
    return fields;
  }
}

function parsePlacementRows(
  raw: RawPlacement[],
  pageCount: number,
  /** When set, force all rows onto this 0-based page (page-scoped calls). */
  forcePageIndex?: number,
): OverlayPlacement[] {
  const out: OverlayPlacement[] = [];
  raw.forEach((r, i) => {
    if (!Array.isArray(r.box_2d) || r.box_2d.length !== 4) return;
    const label = (r.label ?? "").trim();
    if (!label || isGenericLabel(label)) return;
    const [ymin, xmin, ymax, xmax] = r.box_2d;
    if (![ymin, xmin, ymax, xmax].every((n) => Number.isFinite(n))) return;

    let pageIndex: number;
    if (forcePageIndex !== undefined) {
      pageIndex = forcePageIndex;
    } else if (Number.isFinite(r.page)) {
      pageIndex =
        r.page >= 1 ? Math.min(pageCount - 1, r.page - 1) : Math.max(0, r.page);
    } else {
      return;
    }

    const wNorm = clamp01((xmax - xmin) / 1000);
    const hNorm = clamp01((ymax - ymin) / 1000);
    if (wNorm < 0.008 || hNorm < 0.004 || wNorm > 0.92 || hNorm > 0.2) return;
    if (wNorm * hNorm > 0.12 && r.field_type !== "text") return;

    let value = scrubPlaceholderValue((r.value ?? "").trim());
    if (r.field_type === "checkbox") {
      value = value ? (isCheckedValue(value) ? "true" : "false") : "false";
    }
    out.push({
      id: `p${pageIndex}-${i}`,
      page: pageIndex,
      label,
      value,
      fieldType: r.field_type,
      xNorm: clamp01(xmin / 1000),
      yNorm: clamp01(ymin / 1000),
      wNorm,
      hNorm,
    });
  });
  return out;
}

/**
 * Place blanks on one page raster — tighter box_2d than whole-document calls.
 */
async function proposePlacementsForPage(args: {
  formPdf: Uint8Array;
  page: Awaited<ReturnType<typeof renderPdfToImages>>[number];
  pageIndex: number;
  pageCount: number;
  facts: Fact[];
  instructions?: string;
  language: FillLanguage;
}): Promise<OverlayPlacement[]> {
  const { formPdf, page, pageIndex, pageCount, facts, instructions, language } =
    args;
  const instructionBlock = instructions?.trim()
    ? `\n\nUSER INSTRUCTIONS:\n${instructions.trim()}`
    : "";

  const system = `${languageUserBanner(language)}

You propose semantic placements for ONE form page: real blanks + values from facts.
Downstream code may snap boxes to local geometry — still return tight write-area box_2d.
Do not OCR sources (facts are already extracted). Do not invent blanks that are not on the page.
page MUST be ${pageIndex + 1}.
${valueSemanticsDirective()}
${box2dDirective()}
${languageFillDirective(language)}`;

  const rows = await geminiGenerateJson<RawPlacement[]>({
    parts: [
      {
        text: `Page ${pageIndex + 1}/${pageCount}: list every real writable blank on THIS page with label, field_type, value, box_2d.`,
      },
      {
        inlineData: {
          mimeType: "application/pdf",
          data: Buffer.from(formPdf).toString("base64"),
        },
        mediaResolution: "MEDIA_RESOLUTION_HIGH",
      },
      ...pageRasterPart(page, pageIndex, pageCount),
      {
        text: `${languageUserBanner(language)}

KNOWN FACTS:
${factsToText(facts)}${dateFactsForPrompt(facts)}
${languageFillDirective(language)}${instructionBlock}`,
      },
    ],
    schema: PLACEMENTS_SCHEMA,
    system,
    role: "fill",
    thinkingLevel: "medium",
    mediaResolution: "MEDIA_RESOLUTION_HIGH",
    maxOutputTokens: 12288,
    timeoutMs: 70_000,
  });

  return parsePlacementRows(
    Array.isArray(rows) ? rows : [],
    pageCount,
    pageIndex,
  );
}

/**
 * Vision placements: page-scoped calls (sharper boxes) + high media resolution.
 * Geometry later snaps boxes to printed lines — does not invent fields.
 */
export async function proposePlacementsFromPdf(
  formPdf: Uint8Array,
  pageCount: number,
  facts: Fact[],
  instructions?: string,
  language: FillLanguage = "en",
  pageRasters?: Awaited<ReturnType<typeof renderPdfToImages>>,
): Promise<OverlayPlacement[]> {
  // Prefer per-page vision — much more accurate box_2d than one whole-PDF call.
  if (pageRasters && pageRasters.length > 0) {
    const pageJobs = pageRasters.map(async (page, pageIndex) => {
      try {
        const rows = await proposePlacementsForPage({
          formPdf,
          page,
          pageIndex,
          pageCount: pageRasters.length,
          facts,
          instructions,
          language,
        });
        console.log(
          `[vision] page ${pageIndex + 1}: ${rows.length} placements`,
        );
        return rows;
      } catch (err) {
        console.warn(`[vision] page ${pageIndex + 1} failed:`, err);
        return [] as OverlayPlacement[];
      }
    });
    const nested = await Promise.all(pageJobs);
    return nested.flat();
  }

  const instructionBlock = instructions?.trim()
    ? `\n\nUSER INSTRUCTIONS (follow these, they override defaults):\n${instructions.trim()}`
    : "";

  const system = `${languageUserBanner(language)}

You propose semantic placements for a flat PDF form from known facts.
Facts are pre-extracted — do not re-derive unrelated OCR. List real blanks only.
${valueSemanticsDirective()}
${box2dDirective()}
${languageFillDirective(language)}`;

  const raw = await geminiGenerateJson<RawPlacement[]>({
    parts: [
      {
        text: `Form PDF (${pageCount} page(s)): return every real blank with field_type, label, value, box_2d.`,
      },
      {
        inlineData: {
          mimeType: "application/pdf",
          data: Buffer.from(formPdf).toString("base64"),
        },
        mediaResolution: "MEDIA_RESOLUTION_HIGH",
      },
      {
        text: `${languageUserBanner(language)}

KNOWN FACTS:
${factsToText(
  facts,
)}${dateFactsForPrompt(facts)}
${languageFillDirective(language)}${instructionBlock}`,
      },
    ],
    schema: PLACEMENTS_SCHEMA,
    system,
    role: "fill",
    thinkingLevel: "medium",
    mediaResolution: "MEDIA_RESOLUTION_HIGH",
    maxOutputTokens: 16384,
    timeoutMs: 100_000,
  });

  return parsePlacementRows(Array.isArray(raw) ? raw : [], pageCount);
}

function scrubPlaceholderValue(value: string): string {
  const v = value.trim();
  if (
    v === "@" ||
    /^https?:\/\/(www\.)?facebook\.com\/?$/i.test(v) ||
    /^https?:\/\/(www\.)?twitter\.com\/?$/i.test(v) ||
    /^https?:\/\/(www\.)?x\.com\/?$/i.test(v)
  ) {
    return "";
  }
  return v;
}

function rectIou(
  a: { xNorm: number; yNorm: number; wNorm: number; hNorm: number },
  b: { xNorm: number; yNorm: number; wNorm: number; hNorm: number },
): number {
  const ax1 = a.xNorm + a.wNorm;
  const ay1 = a.yNorm + a.hNorm;
  const bx1 = b.xNorm + b.wNorm;
  const by1 = b.yNorm + b.hNorm;
  const x0 = Math.max(a.xNorm, b.xNorm);
  const y0 = Math.max(a.yNorm, b.yNorm);
  const x1 = Math.min(ax1, bx1);
  const y1 = Math.min(ay1, by1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter <= 0) return 0;
  const union = a.wNorm * a.hNorm + b.wNorm * b.hNorm - inter;
  return union > 0 ? inter / union : 0;
}

function centerDist(
  a: { xNorm: number; yNorm: number; wNorm: number; hNorm: number },
  b: { xNorm: number; yNorm: number; wNorm: number; hNorm: number },
): number {
  return Math.hypot(
    a.xNorm + a.wNorm / 2 - (b.xNorm + b.wNorm / 2),
    a.yNorm + a.hNorm / 2 - (b.yNorm + b.hNorm / 2),
  );
}

function isCheckboxPlacement(
  p: Pick<OverlayPlacement, "label" | "value" | "fieldType" | "wNorm" | "hNorm">,
): boolean {
  if (p.fieldType === "checkbox") return true;
  if (/^(true|false|yes|no|y|n|1|0|checked|unchecked)$/i.test(p.value.trim())) {
    return true;
  }
  const aspect = p.wNorm / Math.max(p.hNorm, 0.001);
  if (p.wNorm < 0.045 && p.hNorm < 0.045 && aspect > 0.55 && aspect < 1.8) {
    return true;
  }
  return /checkbox|tick\s*box|\b(yes|no|male|female|single|married|visa)\b/i.test(
    p.label,
  ) && p.wNorm < 0.08;
}

/** Convert vision placements into editable field specs for Review & edit. */
export function placementsToFields(
  placements: OverlayPlacement[],
): AcroFieldSpec[] {
  const used = new Set<string>();
  const out: AcroFieldSpec[] = [];
  placements.forEach((p, i) => {
    const label = (p.label || "").trim();
    if (!label || isGenericLabel(label)) return;
    let name = slugFieldName(label, i);
    while (used.has(name)) name = `${name}_x`;
    used.add(name);
    let value = scrubPlaceholderValue(p.value ?? "");
    const checkbox = isCheckboxPlacement(p);
    if (checkbox) {
      value = isCheckedValue(value) ? "true" : "false";
      out.push({
        name,
        type: "checkbox",
        label,
        value,
        page: p.page,
        xNorm: p.xNorm,
        yNorm: p.yNorm,
        wNorm: p.wNorm,
        hNorm: p.hNorm,
        geomKind: "checkbox",
      });
      return;
    }
    const looksDate =
      looksLikeDateBox({
        label,
        name,
        wNorm: p.wNorm,
        hNorm: p.hNorm,
      }) || /^\d{8}$/.test(value.replace(/\D/g, ""));
    if (looksDate) {
      const digits = toDigitDate(value);
      if (digits.length === 8) value = digits;
    }
    out.push({
      name,
      type: "text",
      label,
      value,
      page: p.page,
      xNorm: p.xNorm,
      yNorm: p.yNorm,
      wNorm: p.wNorm,
      hNorm: p.hNorm,
      geomKind:
        looksDate || (p.wNorm > 0.12 && p.hNorm < 0.04 && p.wNorm / p.hNorm >= 5)
          ? "comb"
          : "text",
    });
  });
  return out;
}

/**
 * Vision owns labels/values. Geometry snaps EVERY box to the nearest printed
 * blank (text line, checkbox, or date grid) — never invents new unlabeled fields.
 */
export function mergeVisionWithGeometry(
  placements: OverlayPlacement[],
  candidates: GeomCandidate[],
): AcroFieldSpec[] {
  const vision = placementsToFields(placements).filter(
    (f) => f.label && !isGenericLabel(f.label),
  );
  if (vision.length === 0) return [];
  if (candidates.length === 0) return vision;

  const usedGeom = new Set<string>();

  const snapped = vision.map((v) => {
    let out: AcroFieldSpec = { ...v };
    if (v.xNorm === undefined || v.yNorm === undefined) return out;

    const wantComb = looksLikeDateBox(v) || v.geomKind === "comb";
    const wantCheck = v.type === "checkbox";

    let best: GeomCandidate | undefined;
    let bestScore = 0;
    for (const c of candidates) {
      if (usedGeom.has(c.id)) continue;
      if (c.page !== v.page) continue;
      if (wantComb && c.kind !== "comb" && c.kind !== "text") continue;
      if (wantCheck && c.kind !== "checkbox") continue;
      if (!wantComb && !wantCheck && c.kind === "checkbox") continue;

      const a = {
        xNorm: v.xNorm,
        yNorm: v.yNorm,
        wNorm: v.wNorm ?? 0.02,
        hNorm: v.hNorm ?? 0.02,
      };
      const iou = rectIou(a, c);
      const dist = centerDist(a, c);
      // Prefer same vertical band (same line) for text underlines.
      const sameRow = Math.abs(a.yNorm + a.hNorm / 2 - (c.yNorm + c.hNorm / 2)) < 0.025;
      const score =
        iou * 3 +
        (dist < 0.12 ? (1 - dist / 0.12) * (sameRow ? 1.4 : 1) : 0) +
        (wantComb && c.kind === "comb" ? 0.5 : 0) +
        (wantCheck && c.kind === "checkbox" ? 0.5 : 0);
      const maxDist = wantCheck ? 0.06 : wantComb ? 0.1 : 0.09;
      if (score > bestScore && (iou > 0.04 || dist < maxDist)) {
        bestScore = score;
        best = c;
      }
    }

    if (!best) return out;
    usedGeom.add(best.id);

    if (wantCheck || best.kind === "checkbox") {
      const next: AcroFieldSpec = {
        ...out,
        type: "checkbox",
        geomKind: "checkbox",
        xNorm: best.xNorm,
        yNorm: best.yNorm,
        wNorm: best.wNorm,
        hNorm: best.hNorm,
        value: isCheckedValue(out.value) ? "true" : "false",
      };
      return next;
    }

    if (wantComb || best.kind === "comb") {
      const digits = toDigitDate(out.value ?? "");
      const next: AcroFieldSpec = {
        ...out,
        geomKind: "comb",
        xNorm: best.xNorm,
        yNorm: best.yNorm,
        wNorm: best.wNorm,
        hNorm: best.hNorm,
        combCells: best.cells?.length ? best.cells : out.combCells,
        value: digits.length === 8 ? digits : out.value,
      };
      return next;
    }

    // Text: snap to printed underline / box (geometry is more precise than vision).
    const next: AcroFieldSpec = {
      ...out,
      geomKind: "text",
      xNorm: best.xNorm,
      yNorm: best.yNorm,
      wNorm: best.wNorm,
      hNorm: best.hNorm,
    };
    return next;
  });

  snapped.sort((a, b) => {
    const ap = a.page ?? 0;
    const bp = b.page ?? 0;
    if (ap !== bp) return ap - bp;
    const dy = (a.yNorm ?? 0) - (b.yNorm ?? 0);
    if (Math.abs(dy) > 0.008) return dy;
    return (a.xNorm ?? 0) - (b.xNorm ?? 0);
  });

  return snapped;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Overlay text onto a flat PDF
// ---------------------------------------------------------------------------

export async function overlayText(
  doc: PDFDocument,
  placements: OverlayPlacement[],
  style: FillStyle = DEFAULT_FILL_STYLE,
): Promise<Uint8Array> {
  const latinFont = await embedFillFont(
    doc,
    isThaanaFont(style.fontFamily) ? "helvetica" : style.fontFamily,
  );
  const needsThaana =
    style.language === "dv" ||
    placements.some((p) => containsThaana(p.value ?? ""));
  const thaanaFont = needsThaana
    ? await embedThaanaFont(doc, style.fontFamily)
    : null;
  const pages = doc.getPages();
  const ink = rgb(0.05, 0.07, 0.2);

  for (const p of placements) {
    const page = pages[p.page];
    if (!page) continue;
    const rawValue = (p.value ?? "").trim();
    if (!rawValue) continue;

    const { width, height } = page.getSize();
    const pad = 1.5;
    const boxLeft = p.xNorm * width + pad;
    const boxTopFromTop = p.yNorm * height + pad;
    const boxW = Math.max(p.wNorm * width - pad * 2, 8);
    const boxH = Math.max(p.hNorm * height - pad * 2, 6);
    const boxBottomPdf = height - (boxTopFromTop + boxH);
    const preferred = style.fontSize > 0 ? style.fontSize : (p.fontSize ?? 0);

    if (looksLikeDateBox({ label: p.label, name: p.id, wNorm: p.wNorm, hNorm: p.hNorm })) {
      drawCombedDigits(
        page,
        latinFont,
        toDigitDate(rawValue) || rawValue.replace(/\D/g, "").slice(0, 8),
        boxLeft,
        boxBottomPdf,
        boxW,
        boxH,
        preferred,
        ink,
        height,
      );
      continue;
    }

    drawBoxText(
      page,
      rawValue,
      boxLeft,
      boxBottomPdf,
      boxW,
      boxH,
      preferred,
      latinFont,
      thaanaFont,
      ink,
    );
  }

  return doc.save();
}

/**
 * Draw text into a box.
 *
 * Thaana is stored in logical Unicode order (base letter + fili). pdf-lib paints
 * left-to-right and has no bidi engine — reversing graphemes mangles words
 * (fili land on the wrong consonants). We keep logical order and right-align
 * Thaana runs so they sit on the correct side of the field.
 */
function drawBoxText(
  page: ReturnType<PDFDocument["getPages"]>[number],
  value: string,
  boxLeft: number,
  boxBottom: number,
  boxW: number,
  boxH: number,
  preferredSize: number,
  latinFont: PDFFont,
  thaanaFont: PDFFont | null,
  color: ReturnType<typeof rgb>,
): void {
  const thaana = containsThaana(value) && thaanaFont;
  const font = thaana ? thaanaFont : latinFont;
  const raw = sanitizeDrawText(value, Boolean(thaanaFont));
  if (!raw) return;

  const fontSize = fitFontSize(font, raw, boxW, boxH, preferredSize);
  const textHeight = font.heightAtSize(fontSize, { descender: false });
  const textWidth = font.widthOfTextAtSize(raw, fontSize);
  const baseline = boxBottom + (boxH - textHeight) / 2;
  // Right-align Thaana; Latin stays left-aligned.
  const x = thaana ? boxLeft + Math.max(0, boxW - textWidth) : boxLeft;

  page.drawText(raw, {
    x,
    y: baseline,
    size: fontSize,
    font,
    color,
  });
}
