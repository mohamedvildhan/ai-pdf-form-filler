// Render a PDF to PNG(s) for visual verification.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(pkgDir, "legacy", "build", "pdf.worker.min.mjs"),
).href;

const [input, outPrefix] = process.argv.slice(2);
const data = new Uint8Array(readFileSync(input));
const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    canvas,
  }).promise;
  const out = `${outPrefix}-p${i}.png`;
  writeFileSync(out, canvas.toBuffer("image/png"));
  console.log("wrote", out);
}
