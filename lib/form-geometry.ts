/**
 * Acrobat-style form field geometry detection from page rasters.
 * Runs in a child process so @napi-rs/canvas never enters the Next/Turbopack bundle.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RenderedPage } from "@/lib/pdf-render";

export type GeomKind = "text" | "checkbox" | "comb";

export interface GeomCell {
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
}

export interface GeomCandidate {
  id: string;
  /** 0-based page index */
  page: number;
  kind: GeomKind;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  /** Individual digit cells when kind=comb (usually 8 for DDMMYYYY). */
  cells?: GeomCell[];
}

const MAX_GEOMETRY_PAGES = 3;

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
      else {
        reject(
          new Error(
            `Geometry detect failed (exit ${code}): ${stderr || stdout}`,
          ),
        );
      }
    });
  });
}

/** Detect fillable blanks on rendered PDF pages (local, no AI). */
export async function detectFormGeometry(
  pages: RenderedPage[],
): Promise<GeomCandidate[]> {
  const slice = pages.slice(0, MAX_GEOMETRY_PAGES);
  if (slice.length === 0) return [];

  const workDir = await mkdtemp(path.join(tmpdir(), "pdf-geom-"));
  try {
    const meta = {
      pages: slice.map((p) => ({
        pageNumber: p.pageNumber,
        file: `page-${p.pageNumber}.png`,
        width: p.width,
        height: p.height,
      })),
    };
    await writeFile(path.join(workDir, "meta.json"), JSON.stringify(meta));
    await Promise.all(
      slice.map((p) =>
        writeFile(path.join(workDir, `page-${p.pageNumber}.png`), p.png),
      ),
    );

    const script = path.join(process.cwd(), "scripts", "detect-geometry.mjs");
    const { stdout } = await run(process.execPath, [script, workDir]);
    const parsed = JSON.parse(stdout) as { candidates?: GeomCandidate[] };
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
