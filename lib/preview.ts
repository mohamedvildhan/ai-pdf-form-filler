// Build a filled PDF preview (page PNGs) and compute what's still needed.

import { PDFDocument } from "pdf-lib";
import {
  createAndFillAcroForm,
  fillAcroForm,
  overlayText,
} from "@/lib/pdf-fill";
import { renderPdfToImages } from "@/lib/pdf-render";
import type {
  AcroFieldSpec,
  FillMode,
  FillStyle,
  NeededInfo,
  OverlayPlacement,
} from "@/lib/types";
import { DEFAULT_FILL_STYLE } from "@/lib/types";

const MAX_PREVIEW_PAGES = 4;
/** Retina-sharp review render (AI still uses the compact JPEG sibling). */
const PREVIEW_SCALE = 2;

export function computeNeededInfo(
  fields?: AcroFieldSpec[],
  placements?: OverlayPlacement[],
): NeededInfo[] {
  const needed: NeededInfo[] = [];

  if (fields) {
    for (const f of fields) {
      if (f.type === "button" || f.type === "unknown") continue;
      const empty = !(f.value ?? "").trim();
      // Unchecked checkbox is a valid answer — only flag text-like empties.
      if (f.type === "checkbox") continue;
      if (empty) {
        needed.push({
          field: f.name,
          label: f.label || f.name,
          reason: "No value found in the information you provided.",
        });
      }
    }
  }

  if (placements) {
    for (const p of placements) {
      if (!(p.value ?? "").trim()) {
        needed.push({
          field: p.id,
          label: p.label || "Untitled field",
          reason: "No value found in the information you provided.",
        });
      }
    }
  }

  return needed;
}

export async function buildFilledPdf(
  formBytes: Uint8Array,
  mode: FillMode,
  fields: AcroFieldSpec[],
  placements: OverlayPlacement[],
  flatten = true,
  style: FillStyle = DEFAULT_FILL_STYLE,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(formBytes, { ignoreEncryption: true });
  switch (mode) {
    case "acroform":
      return fillAcroForm(doc, fields, flatten, style);
    case "created-acroform":
      return createAndFillAcroForm(doc, fields, flatten, style);
    case "overlay":
      return overlayText(doc, placements, style);
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown mode: ${String(_exhaustive)}`);
    }
  }
}

/** Render filled PDF pages as data-URL PNGs for the in-app viewer. */
export async function renderFilledPreviews(
  filledPdf: Uint8Array,
): Promise<string[]> {
  const images = await renderPdfToImages(filledPdf, PREVIEW_SCALE);
  return images
    .slice(0, MAX_PREVIEW_PAGES)
    .map((img) => `data:image/png;base64,${img.png.toString("base64")}`);
}

/** Turn already-rendered blank pages into data-URLs (no second PDF render). */
export function rastersToDataUrls(
  pages: { png: Buffer }[],
): string[] {
  return pages
    .slice(0, MAX_PREVIEW_PAGES)
    .map((img) => `data:image/png;base64,${img.png.toString("base64")}`);
}
