// Enrich already-detected fields from additional sources — no geometry re-detect.
// Keeps box positions; only fills empty values from new facts.

import { NextResponse } from "next/server";
import { MissingApiKeyError } from "@/lib/gemini";
import { proposeFieldValues } from "@/lib/pdf-fill";
import {
  buildFilledPdf,
  computeNeededInfo,
  renderFilledPreviews,
} from "@/lib/preview";
import { extractFacts, type SourceFile } from "@/lib/sources";
import type {
  AcroFieldSpec,
  FillMode,
  FillStyle,
  OverlayPlacement,
} from "@/lib/types";
import { DEFAULT_FILL_STYLE } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";

interface EnrichPayload {
  mode: FillMode;
  fields?: AcroFieldSpec[];
  placements?: OverlayPlacement[];
  style?: FillStyle;
  instructions?: string;
}

async function fileToSource(file: File): Promise<SourceFile> {
  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

/** Fill empty fields from proposed values; never move boxes or clear filled text. */
function mergeFieldValues(
  existing: AcroFieldSpec[],
  proposed: AcroFieldSpec[],
): AcroFieldSpec[] {
  const byName = new Map(proposed.map((p) => [p.name, p]));
  return existing.map((f) => {
    const p = byName.get(f.name);
    if (!p) return f;
    const next = (p.value ?? "").trim();
    if (!next) return f;
    if (f.type === "checkbox") {
      if (next.toLowerCase() === "true") {
        return { ...f, value: "true", reason: p.reason ?? f.reason };
      }
      return f;
    }
    if ((f.value ?? "").trim()) return f;
    return { ...f, value: next, reason: p.reason ?? f.reason };
  });
}

function mergePlacementValues(
  existing: OverlayPlacement[],
  proposed: AcroFieldSpec[],
): OverlayPlacement[] {
  const byId = new Map(proposed.map((p) => [p.name, p]));
  return existing.map((pl) => {
    const p = byId.get(pl.id);
    if (!p) return pl;
    const next = (p.value ?? "").trim();
    if (!next || (pl.value ?? "").trim()) return pl;
    return { ...pl, value: next, reason: p.reason ?? pl.reason };
  });
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const formFile = formData.get("form");
    const payloadRaw = formData.get("payload");

    if (!(formFile instanceof File)) {
      return NextResponse.json({ error: "Missing 'form' file." }, { status: 400 });
    }
    if (typeof payloadRaw !== "string") {
      return NextResponse.json({ error: "Missing 'payload'." }, { status: 400 });
    }

    const payload = JSON.parse(payloadRaw) as EnrichPayload;
    const style = { ...DEFAULT_FILL_STYLE, ...(payload.style ?? {}) };
    const language = style.language ?? "en";
    const instructions = payload.instructions?.trim() || "";

    const sourceEntries = formData
      .getAll("sources")
      .filter((e): e is File => e instanceof File);
    const sourceText =
      (formData.get("sourceText") as string | null)?.trim() || "";

    if (sourceEntries.length === 0 && !sourceText) {
      return NextResponse.json(
        { error: "Add at least one source file or some pasted text." },
        { status: 400 },
      );
    }

    const sources = await Promise.all(sourceEntries.map(fileToSource));
    if (sourceText) {
      sources.push({
        name: "pasted-notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(sourceText),
      });
    }

    const formBytes = new Uint8Array(await formFile.arrayBuffer());
    const facts = await extractFacts(sources);
    let fields = payload.fields ?? [];
    let placements = payload.placements ?? [];

    switch (payload.mode) {
      case "acroform":
      case "created-acroform": {
        const proposed = await proposeFieldValues(
          fields,
          facts,
          instructions ||
            "Prefer filling empty fields. Do not invent values. Leave already-correct values alone by returning empty for those.",
          language,
          formBytes,
        );
        fields = mergeFieldValues(fields, proposed);
        break;
      }
      case "overlay": {
        const asSpecs: AcroFieldSpec[] = placements.map((p) => ({
          name: p.id,
          type: "text",
          label: p.label,
          value: p.value,
        }));
        const proposed = await proposeFieldValues(
          asSpecs,
          facts,
          instructions ||
            "Prefer filling empty fields. Do not invent values.",
          language,
          formBytes,
        );
        placements = mergePlacementValues(placements, proposed);
        break;
      }
      default: {
        const _exhaustive: never = payload.mode;
        throw new Error(`Unknown mode: ${String(_exhaustive)}`);
      }
    }

    const neededInfo = computeNeededInfo(fields, placements);

    // Skip filled-PDF re-render for flat/live-overlay modes — client draws values.
    let filledPreviews: string[] | undefined;
    if (payload.mode === "acroform") {
      const formBytes = new Uint8Array(await formFile.arrayBuffer());
      const filled = await buildFilledPdf(
        formBytes,
        payload.mode,
        fields,
        placements,
        true,
        style,
      );
      filledPreviews = await renderFilledPreviews(filled);
    }

    return NextResponse.json({
      facts,
      fields,
      placements,
      filledPreviews,
      neededInfo,
    });
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[api/enrich]", error);
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
