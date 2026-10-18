// Render PDF pages to PNG by shelling out to a standalone Node script.
//
// pdfjs-dist's fake worker breaks under Next.js Turbopack with
// "Cannot transfer object of unsupported type". Running the renderer in a
// plain Node child process avoids that entirely.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface RenderedPage {
  /** 1-based page number */
  pageNumber: number;
  png: Buffer;
  /** Compact JPEG for Gemini (much smaller than PNG). */
  aiJpeg?: Buffer;
  /** rendered pixel size */
  width: number;
  height: number;
}

interface RenderMeta {
  pages: {
    pageNumber: number;
    file: string;
    width: number;
    height: number;
    aiFile?: string;
    aiWidth?: number;
    aiHeight?: number;
  }[];
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`PDF render failed (exit ${code}): ${stderr || stdout}`));
    });
  });
}

/** Render every page of a PDF to a PNG buffer. */
export async function renderPdfToImages(
  data: Uint8Array,
  scale = 2,
): Promise<RenderedPage[]> {
  const workDir = await mkdtemp(path.join(tmpdir(), "pdf-filler-"));
  const inputPath = path.join(workDir, "input.pdf");
  const outDir = path.join(workDir, "pages");

  try {
    await writeFile(inputPath, Buffer.from(data));
    const script = path.join(process.cwd(), "scripts", "render-pages.mjs");
    await run(process.execPath, [script, inputPath, outDir, String(scale)]);

    const meta = JSON.parse(
      await readFile(path.join(outDir, "meta.json"), "utf8"),
    ) as RenderMeta;

    const pages: RenderedPage[] = [];
    for (const page of meta.pages) {
      const png = await readFile(path.join(outDir, page.file));
      let aiJpeg: Buffer | undefined;
      if (page.aiFile) {
        try {
          aiJpeg = await readFile(path.join(outDir, page.aiFile));
        } catch {
          aiJpeg = undefined;
        }
      }
      pages.push({
        pageNumber: page.pageNumber,
        png,
        aiJpeg,
        width: page.width,
        height: page.height,
      });
    }
    return pages;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
