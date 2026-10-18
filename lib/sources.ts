// Turn arbitrary source files (images, PDFs, Word docs, text) into a clean set
// of facts that can be used to fill a form.
//
// PDFs are sent straight to Gemini as application/pdf — Gemini reads both
// digital and scanned PDFs natively, so we never need pdfjs for extraction.
//
// This module ONLY extracts facts. It does not place form boxes or fill fields.

import mammoth from "mammoth";
import { geminiGenerateJson, type GeminiPart, type GeminiSchema } from "@/lib/gemini";
import type { Fact } from "@/lib/types";

export interface SourceFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|bmp|tiff?)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|csv))/i;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function normalizeImageMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  return m;
}

/** Build Gemini parts describing a single source file. */
async function partsForSource(source: SourceFile): Promise<GeminiPart[]> {
  const { name, mimeType, bytes } = source;
  const parts: GeminiPart[] = [];

  if (IMAGE_MIME.test(mimeType)) {
    parts.push({ text: `--- Source image: ${name} ---` });
    parts.push({
      inlineData: {
        mimeType: normalizeImageMime(mimeType),
        data: toBase64(bytes),
      },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    });
    return parts;
  }

  if (mimeType === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    parts.push({ text: `--- Source PDF: ${name} ---` });
    parts.push({
      inlineData: { mimeType: "application/pdf", data: toBase64(bytes) },
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
    });
    return parts;
  }

  if (DOCX_MIME === mimeType || name.toLowerCase().endsWith(".docx")) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    parts.push({ text: `--- Source document: ${name} ---\n${value.trim()}` });
    return parts;
  }

  if (TEXT_MIME.test(mimeType) || /\.(txt|md|csv|json|xml)$/i.test(name)) {
    const text = new TextDecoder().decode(bytes).trim();
    parts.push({ text: `--- Source document: ${name} ---\n${text}` });
    return parts;
  }

  const text = new TextDecoder()
    .decode(bytes)
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  parts.push({
    text: `--- Source file: ${name} (unrecognized type ${mimeType}) ---\n${text.slice(0, 5000)}`,
  });
  return parts;
}

const FACTS_SCHEMA: GeminiSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      key: {
        type: "STRING",
        description:
          "Clear English key invented from the source content (e.g. what the document calls this fact).",
      },
      value: {
        type: "STRING",
        description:
          "Exact value from the source. Preserve original script. Do not invent.",
      },
    },
    required: ["key", "value"],
  },
};

/**
 * Fact extraction ONLY — no form layout, no coordinates, no filling.
 * Downstream models map these facts onto form blanks.
 */
const FACTS_SYSTEM = `You extract structured facts from identity/supporting documents.

TASK (single): Read every source thoroughly and return a flat JSON array of {key, value} facts.
Do NOT fill forms, propose boxes, translate for output language, or invent values.

RULES:
- Cover all pages / both sides of IDs / stamps / handwritten notes when present.
- Keys: short English labels you invent from what the document shows (be specific).
- Split compound identity fields when the source clearly separates them (e.g. given vs family name).
- Values: copy exactly as written. Do not translate. Preserve Thaana/other scripts exactly.
- Extract every concrete reusable fact the sources contain (identity, contacts, orgs, dates, IDs, status, etc.).
- If a fact is absent, omit it. De-dupe to the most complete value.
- If the same fact appears in Latin and Thaana, emit both with distinct keys when useful.`;

/** Build Gemini multimodal parts for all sources (PDFs, images, text). */
export async function buildSourceParts(
  sources: SourceFile[],
): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];
  const ordered = [...sources].sort((a, b) => a.bytes.length - b.bytes.length);
  for (const source of ordered) {
    parts.push(...(await partsForSource(source)));
  }
  return parts;
}

/** Drop empties and de-dupe on key+value. */
export function sanitizeFacts(facts: Fact[] | null | undefined): Fact[] {
  if (!Array.isArray(facts)) return [];
  const seen = new Set<string>();
  return facts.filter((f) => {
    if (!f?.key || !f?.value) return false;
    const id = `${f.key}::${f.value}`.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Extract a flat list of facts from all provided source files. Returns an empty
 * list when no sources are given.
 */
export async function extractFacts(sources: SourceFile[]): Promise<Fact[]> {
  if (sources.length === 0) return [];

  const parts: GeminiPart[] = [
    {
      text: `Extract facts from the sources below into the JSON schema.
Do not fill any form. Do not return coordinates.
If a detail is not in the sources, skip it.`,
    },
    ...(await buildSourceParts(sources)),
  ];

  const facts = await geminiGenerateJson<Fact[]>({
    parts,
    schema: FACTS_SCHEMA,
    system: FACTS_SYSTEM,
    temperature: 0,
    maxOutputTokens: 8192,
    timeoutMs: 180_000,
    role: "extract",
    thinkingLevel: "medium",
    mediaResolution: "MEDIA_RESOLUTION_HIGH",
  });

  return sanitizeFacts(facts);
}

export { FACTS_SCHEMA, FACTS_SYSTEM };

/** Render facts as a compact text block for downstream prompts. */
export function factsToText(facts: Fact[]): string {
  if (facts.length === 0) return "(no source information provided)";
  return facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
}
