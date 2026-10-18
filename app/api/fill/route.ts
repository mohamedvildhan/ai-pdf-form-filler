// Generate the final filled PDF from reviewed values / placements.

import { NextResponse } from "next/server";
import { buildFilledPdf } from "@/lib/preview";
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

interface FillPayload {
  mode: FillMode;
  flatten?: boolean;
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

    const payload = JSON.parse(payloadRaw) as FillPayload;
    const formBytes = new Uint8Array(await formFile.arrayBuffer());
    const style = { ...DEFAULT_FILL_STYLE, ...(payload.style ?? {}) };

    const filled = await buildFilledPdf(
      formBytes,
      payload.mode,
      payload.fields ?? [],
      payload.placements ?? [],
      payload.flatten ?? true,
      style,
    );

    const outName = formFile.name.replace(/\.pdf$/i, "") + "-filled.pdf";
    const body = new Uint8Array(filled);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${outName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[api/fill]", error);
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
