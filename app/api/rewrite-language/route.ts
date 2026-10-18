// Rewrite existing free-text field values into the selected fill language (EN ↔ DV).
// Used from Review & edit when the user changes Fill language or edits a value.

import { NextResponse } from "next/server";
import { MissingApiKeyError } from "@/lib/gemini";
import { rewriteFieldsForLanguage } from "@/lib/pdf-fill";
import { computeNeededInfo } from "@/lib/preview";
import type { AcroFieldSpec, FillStyle, OverlayPlacement } from "@/lib/types";
import { DEFAULT_FILL_STYLE } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface RewritePayload {
  fields?: AcroFieldSpec[];
  placements?: OverlayPlacement[];
  style?: FillStyle;
  /** When true, force translating free-text prose (user blur / single-field edit). */
  forceProse?: boolean;
  /** Other filled values (esp. Thaana) to keep spellings consistent. */
  spellingContext?: Array<{ label?: string; value: string }>;
}

async function parseBody(request: Request): Promise<{
  payload: RewritePayload;
  formBytes?: Uint8Array;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await request.json()) as RewritePayload;
    return { payload };
  }

  const formData = await request.formData();
  const payloadRaw = formData.get("payload");
  if (typeof payloadRaw !== "string") {
    throw new Error("Missing 'payload'.");
  }
  const payload = JSON.parse(payloadRaw) as RewritePayload;
  const formFile = formData.get("form");
  const formBytes =
    formFile instanceof File
      ? new Uint8Array(await formFile.arrayBuffer())
      : undefined;
  return { payload, formBytes };
}

export async function POST(request: Request) {
  try {
    const { payload, formBytes } = await parseBody(request);
    const style = { ...DEFAULT_FILL_STYLE, ...(payload.style ?? {}) };
    const language = style.language ?? "en";

    let fields = payload.fields ?? [];
    let placements = payload.placements ?? [];
    const forceProse = payload.forceProse === true;
    const spellingContext = payload.spellingContext ?? [];

    if (fields.length > 0) {
      fields = await rewriteFieldsForLanguage(fields, language, formBytes, {
        forceProse,
        spellingContext,
      });
    }

    if (placements.length > 0) {
      const asFields: AcroFieldSpec[] = placements.map((p) => ({
        name: p.id,
        type: "text" as const,
        label: p.label,
        value: p.value,
        page: p.page,
        xNorm: p.xNorm,
        yNorm: p.yNorm,
        wNorm: p.wNorm,
        hNorm: p.hNorm,
      }));
      const rewritten = await rewriteFieldsForLanguage(
        asFields,
        language,
        formBytes,
        { forceProse, spellingContext },
      );
      const byName = new Map(rewritten.map((f) => [f.name, f.value]));
      placements = placements.map((p) => ({
        ...p,
        value: byName.get(p.id) ?? p.value,
      }));
    }

    return NextResponse.json({
      fields,
      placements,
      neededInfo: computeNeededInfo(fields, placements),
      notes: `Rewrote free-text values for language: ${language}.`,
    });
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[api/rewrite-language]", error);
    const message =
      error instanceof Error ? error.message : "Could not rewrite language.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
