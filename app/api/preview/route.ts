// Re-render a filled PDF preview after the user corrects field values.

import { NextResponse } from "next/server";
import {
  buildFilledPdf,
  computeNeededInfo,
  renderFilledPreviews,
} from "@/lib/preview";
import type {
  AcroFieldSpec,
  FillMode,
  FillStyle,
  OverlayPlacement,
} from "@/lib/types";
import { DEFAULT_FILL_STYLE } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface PreviewPayload {
  mode: FillMode;
  fields?: AcroFieldSpec[];
  placements?: OverlayPlacement[];
  style?: FillStyle;
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

    const payload = JSON.parse(payloadRaw) as PreviewPayload;
    const formBytes = new Uint8Array(await formFile.arrayBuffer());
    const fields = payload.fields ?? [];
    const placements = payload.placements ?? [];
    const style = { ...DEFAULT_FILL_STYLE, ...(payload.style ?? {}) };

    const filled = await buildFilledPdf(
      formBytes,
      payload.mode,
      fields,
      placements,
      true,
      style,
    );
    const filledPreviews = await renderFilledPreviews(filled);
    const neededInfo = computeNeededInfo(fields, placements);

    return NextResponse.json({ filledPreviews, neededInfo });
  } catch (error) {
    console.error("[api/preview]", error);
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
