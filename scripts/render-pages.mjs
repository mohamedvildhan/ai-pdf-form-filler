// Standalone PDF → PNG renderer. Invoked as a child process so Next/Turbopack
// never loads pdfjs into its bundle (which breaks the fake worker).
//
// Usage: node scripts/render-pages.mjs <input.pdf> <outDir> [scale]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(pkgDir, "legacy", "build", "pdf.worker.min.mjs"),
).href;

const [input, outDir, scaleArg] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("Usage: node scripts/render-pages.mjs <input.pdf> <outDir> [scale]");
  process.exit(1);
}

const scale = Number(scaleArg || 2);
/** Max width for Gemini vision JPEGs — sharpness for labels/boxes (accuracy first). */
const AI_MAX_WIDTH = 3200;
/** JPEG quality 0–1; higher = clearer Thaana/small print for the model. */
const AI_JPEG_QUALITY = 0.95;
mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(readFileSync(input));
const doc = await pdfjs.getDocument({ data, verbosity: 0, useSystemFonts: true }).promise;
const meta = { pages: [] };

for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    canvas,
  }).promise;
  const file = `page-${i}.png`;
  writeFileSync(path.join(outDir, file), canvas.toBuffer("image/png"));

  // High-res JPEG for AI (full PNG stays for the live preview UI).
  const aiScale = Math.min(1, AI_MAX_WIDTH / width);
  const aiW = Math.max(1, Math.round(width * aiScale));
  const aiH = Math.max(1, Math.round(height * aiScale));
  const aiCanvas = createCanvas(aiW, aiH);
  const aiCtx = aiCanvas.getContext("2d");
  aiCtx.fillStyle = "#fff";
  aiCtx.fillRect(0, 0, aiW, aiH);
  aiCtx.drawImage(canvas, 0, 0, aiW, aiH);
  const aiFile = `page-${i}-ai.jpg`;
  writeFileSync(
    path.join(outDir, aiFile),
    aiCanvas.toBuffer("image/jpeg", AI_JPEG_QUALITY),
  );

  meta.pages.push({
    pageNumber: i,
    file,
    width,
    height,
    aiFile,
    aiWidth: aiW,
    aiHeight: aiH,
  });
  page.cleanup();
}

writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta));
console.log(JSON.stringify(meta));
