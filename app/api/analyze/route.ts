// Analyze a form + source files, fill what we can, and return a reviewable
// result. Accuracy first: facts + render in parallel, then a careful AI
// correct+fill pass. Client shows live overlays (no filled-PDF re-render).

import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { MissingApiKeyError } from "@/lib/gemini";
import {
  detectAndMapFlatFields,
  extractFactsAndFillAcroForm,
  fillableFields,
  inspectForm,
  mergeVisionWithGeometry,
  proposePlacementsFromPdf,
  refineDateDigitBoxes,
} from "@/lib/pdf-fill";
import { detectFormGeometry } from "@/lib/form-geometry";
import { renderPdfToImages } from "@/lib/pdf-render";
import {
  buildFilledPdf,
  computeNeededInfo,
  rastersToDataUrls,
  renderFilledPreviews,
} from "@/lib/preview";
import { extractFacts, type SourceFile } from "@/lib/sources";
import type {
  AcroFieldSpec,
  AnalyzeResult,
  FillMode,
  FillStyle,
  OverlayPlacement,
  PageSize,
} from "@/lib/types";
import { DEFAULT_FILL_STYLE } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";

async function fileToSource(file: File): Promise<SourceFile> {
  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

/** AcroForm path still needs a filled raster (no geometry blank pages). */
async function withFilledRender(
  formBytes: Uint8Array,
  base: Omit<AnalyzeResult, "neededInfo" | "filledPreviews">,
  style: FillStyle,
): Promise<AnalyzeResult> {
  const fields = base.fields ?? [];
  const placements = base.placements ?? [];
  const neededInfo = computeNeededInfo(fields, placements);
  let filledPreviews: string[] = [];
  try {
    const filled = await buildFilledPdf(
      formBytes,
      base.mode,
      fields,
      placements,
      true,
      style,
    );
    filledPreviews = await renderFilledPreviews(filled);
  } catch (err) {
    console.warn("[api/analyze] filled preview failed:", err);
  }
  return { ...base, neededInfo, filledPreviews };
}

export async function POST(request: Request) {
  const started = Date.now();
  try {
    const formData = await request.formData();
    const formFile = formData.get("form");
    if (!(formFile instanceof File)) {
      return NextResponse.json(
        { error: "Upload the PDF form to fill under the 'form' field." },
        { status: 400 },
      );
    }

    const sourceEntries = formData
      .getAll("sources")
      .filter((e): e is File => e instanceof File);

    const sourceText = (formData.get("sourceText") as string | null)?.trim() || "";
    const instructions = (formData.get("instructions") as string | null)?.trim() || "";
    let style: FillStyle = DEFAULT_FILL_STYLE;
    const styleRaw = formData.get("style");
    if (typeof styleRaw === "string" && styleRaw.trim()) {
      try {
        style = { ...DEFAULT_FILL_STYLE, ...(JSON.parse(styleRaw) as FillStyle) };
      } catch {
        // keep defaults
      }
    }

    const formBytes = new Uint8Array(await formFile.arrayBuffer());
    const doc = await PDFDocument.load(formBytes, { ignoreEncryption: true });

    const pages: PageSize[] = doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { width, height };
    });

    const sources = await Promise.all(sourceEntries.map(fileToSource));
    if (sourceText) {
      sources.push({
        name: "pasted-notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(sourceText),
      });
    }

    const specs = inspectForm(doc);
    const hasFillableFields = fillableFields(specs).length > 0;
    const language = style.language ?? "en";

    if (hasFillableFields) {
      console.log("[api/analyze] acroform: single AI extract+fill…");
      const { facts, fields } = await extractFactsAndFillAcroForm(
        specs,
        sources,
        instructions,
        language,
        formBytes,
      );
      const result = await withFilledRender(
        formBytes,
        {
          mode: "acroform",
          facts,
          pages,
          fields,
          notes: `Filled ${fillableFields(fields).filter((f) => f.value.trim()).length} of ${fillableFields(fields).length} form fields.`,
        },
        style,
      );
      console.log(`[api/analyze] done in ${Date.now() - started}ms (acroform)`);
      return NextResponse.json(result);
    }

    // Flat forms: restore the original vision-first path (best quality).
    // Geometry-first was worse — it caged the model into bad candidate boxes.
    console.log("[api/analyze] flat: facts + pages in parallel…");
    const tParallel = Date.now();
    const [facts, rasters] = await Promise.all([
      extractFacts(sources),
      renderPdfToImages(formBytes, 2),
    ]);
    console.log(
      `[api/analyze] facts=${facts.length} pages=${rasters.length} in ${Date.now() - tParallel}ms`,
    );

    let mode: FillMode;
    let fields: AcroFieldSpec[] | undefined;
    let placements: OverlayPlacement[] | undefined;
    let notes: string;
    let pagePreviews: string[] | undefined;
    let filledPreviews: string[];

    // Vision owns field list + labels (incl. empty blanks). Geometry only
    // snaps checkbox/date boxes — never invents unlabeled shells.
    console.log("[api/analyze] vision fields + geometry snap…");
    const tFill = Date.now();
    const [visionPlacements, geomCandidates] = await Promise.all([
      proposePlacementsFromPdf(
        formBytes,
        pages.length,
        facts,
        instructions,
        language,
        rasters,
      ),
      detectFormGeometry(rasters).catch((err) => {
        console.warn("[api/analyze] geometry failed:", err);
        return [] as Awaited<ReturnType<typeof detectFormGeometry>>;
      }),
    ]);
    console.log(
      `[api/analyze] vision=${visionPlacements.length} geom=${geomCandidates.length} in ${Date.now() - tFill}ms`,
    );

    pagePreviews = rastersToDataUrls(rasters);
    filledPreviews = pagePreviews;

    if (visionPlacements.length > 0) {
      mode = "created-acroform";
      fields = mergeVisionWithGeometry(visionPlacements, geomCandidates);
      fields = await refineDateDigitBoxes(formBytes, rasters, fields);
      const filledN = fields.filter((f) =>
        f.type === "checkbox"
          ? f.value.toLowerCase() === "true"
          : !!(f.value ?? "").trim(),
      ).length;
      const emptyN = fields.length - filledN;
      notes = `Filled ${filledN} blanks; ${emptyN} still empty (labeled for you to complete).`;
    } else {
      console.log("[api/analyze] vision empty — geometry AI fallback…");
      const detected = await detectAndMapFlatFields(
        formBytes,
        pages.length,
        facts,
        instructions,
        language,
        rasters,
      );
      // Drop unlabeled geometry noise from fallback too.
      const usable = detected.filter(
        (f) =>
          (f.type === "text" ||
            f.type === "checkbox" ||
            f.type === "signature") &&
          f.label &&
          !/^(field|checkbox|date)(_?\d+)?$/i.test(f.label.trim()),
      );
      if (usable.length > 0) {
        mode = "created-acroform";
        fields = usable;
        notes = `Detected ${usable.length} blanks and filled what your info covers.`;
      } else if (detected.length > 0) {
        // Last resort: only filled ones, never a sea of "Field".
        mode = "created-acroform";
        fields = detected.filter((f) =>
          f.type === "checkbox"
            ? f.value.toLowerCase() === "true"
            : !!(f.value ?? "").trim(),
        );
        notes =
          fields.length > 0
            ? `Filled ${fields.length} blanks from your sources.`
            : "Could not label blanks on this form.";
      } else {
        mode = "overlay";
        placements = [];
        notes = "Could not find fillable blanks on this form.";
      }
    }

    const neededInfo = computeNeededInfo(fields, placements);
    console.log(
      `[api/analyze] done in ${Date.now() - started}ms (${mode})`,
    );
    return NextResponse.json({
      mode,
      facts,
      pages,
      fields,
      placements,
      pagePreviews,
      filledPreviews,
      neededInfo,
      notes,
      liveOverlay: true,
    } satisfies AnalyzeResult & { liveOverlay: true });
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[api/analyze]", error);
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
