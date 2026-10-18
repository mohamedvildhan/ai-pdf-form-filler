// Standalone geometry detector. Runs outside Next/Turbopack so @napi-rs/canvas
// native addons load normally.
//
// Usage: node scripts/detect-geometry.mjs <pagesDir>
// pagesDir must contain meta.json + page-N.png (from render-pages.mjs).
// Prints JSON: { candidates: [...] }

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const pagesDir = process.argv[2];
if (!pagesDir) {
  console.error("Usage: node scripts/detect-geometry.mjs <pagesDir>");
  process.exit(1);
}

/** Higher res → tighter blank edges when scaled back to page coords. */
const MAX_DETECT_WIDTH = 1600;
/** Slight inset so overlays sit inside the printed border, not on the ink. */
const INSET_FRAC = 0.02;
const MAX_GEOMETRY_PAGES = 3;

const meta = JSON.parse(readFileSync(path.join(pagesDir, "meta.json"), "utf8"));
const pages = (meta.pages || []).slice(0, MAX_GEOMETRY_PAGES);

const out = [];
let seq = 0;

for (const page of pages) {
  const pageIndex = Math.max(0, page.pageNumber - 1);
  const pngPath = path.join(pagesDir, page.file);
  const png = readFileSync(pngPath);
  const rects = await findFieldRects(png);
  const merged = mergeCombRows(rects, page.width, page.height);

  for (const r of merged) {
    const kind =
      Array.isArray(r.cells) && r.cells.length >= 6 ? "comb" : classifyRect(r);
    const insetX = r.w * INSET_FRAC;
    const insetY = r.h * Math.min(INSET_FRAC * 1.5, 0.2);
    const x = r.x + insetX;
    const y = r.y + insetY;
    const w = Math.max(2, r.w - insetX * 2);
    const h = Math.max(2, r.h - insetY * 2);
    const entry = {
      id: `g_${pageIndex}_${seq++}`,
      page: pageIndex,
      kind,
      xNorm: clamp01(x / page.width),
      yNorm: clamp01(y / page.height),
      wNorm: clamp01(w / page.width),
      hNorm: clamp01(h / page.height),
    };
    if (Array.isArray(r.cells) && r.cells.length >= 4) {
      const cellInset = 0.12;
      entry.cells = r.cells.map((c) => {
        const cx = c.x + c.w * cellInset;
        const cy = c.y + c.h * cellInset;
        const cw = Math.max(1, c.w * (1 - cellInset * 2));
        const ch = Math.max(1, c.h * (1 - cellInset * 2));
        return {
          xNorm: clamp01(cx / page.width),
          yNorm: clamp01(cy / page.height),
          wNorm: clamp01(cw / page.width),
          hNorm: clamp01(ch / page.height),
        };
      });
    }
    out.push(entry);
  }
}

out.sort((a, b) => {
  if (a.page !== b.page) return a.page - b.page;
  const dy = a.yNorm - b.yNorm;
  if (Math.abs(dy) > 0.008) return dy;
  return a.xNorm - b.xNorm;
});

const result = { candidates: out };
writeFileSync(path.join(pagesDir, "geometry.json"), JSON.stringify(result));
process.stdout.write(JSON.stringify(result));

async function findFieldRects(png) {
  const img = await loadImage(png);
  const srcW = img.width;
  const srcH = img.height;
  const scale = Math.min(1, MAX_DETECT_WIDTH / srcW);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const gray = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = g;
    sum += g;
  }
  const mean = sum / gray.length;
  // Slightly more sensitive so light grey form lines still count as ink.
  const inkCut = Math.min(mean - 12, mean * 0.9);

  const ink = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    ink[i] = gray[i] < inkCut ? 1 : 0;
  }

  const hSegs = horizontalSegments(ink, w, h);
  const fromPairs = rectanglesFromSegments(hSegs, ink, w, h);
  // Underlines are snap targets only (vision owns which fields exist).
  const fromUnderlines = underlineRects(hSegs, w, h);
  const rectsSmall = [...fromPairs, ...fromUnderlines];
  const inv = 1 / scale;
  const rects = rectsSmall.map((r) => ({
    x: r.x * inv,
    y: r.y * inv,
    w: r.w * inv,
    h: r.h * inv,
  }));
  return dedupeRects(rects, srcW, srcH);
}

function horizontalSegments(ink, w, h) {
  const segs = [];
  const minLen = Math.max(8, Math.floor(w * 0.02));
  for (let y = 0; y < h; y++) {
    let x = 0;
    const row = y * w;
    while (x < w) {
      while (x < w && !ink[row + x]) x++;
      if (x >= w) break;
      const x0 = x;
      while (x < w && ink[row + x]) x++;
      const x1 = x - 1;
      if (x1 - x0 + 1 >= minLen) segs.push({ y, x0, x1 });
    }
  }
  return segs;
}

function rectanglesFromSegments(segs, ink, w, h) {
  const rects = [];
  const minW = Math.max(10, Math.floor(w * 0.025));
  const minH = Math.max(6, Math.floor(h * 0.008));
  const maxH = Math.floor(h * 0.12);
  const maxW = Math.floor(w * 0.95);

  for (let i = 0; i < segs.length; i++) {
    const top = segs[i];
    const topLen = top.x1 - top.x0 + 1;
    if (topLen < minW || topLen > maxW) continue;

    for (let j = i + 1; j < segs.length; j++) {
      const bot = segs[j];
      const height = bot.y - top.y;
      if (height < minH) continue;
      if (height > maxH) break;

      const botLen = bot.x1 - bot.x0 + 1;
      const overlap0 = Math.max(top.x0, bot.x0);
      const overlap1 = Math.min(top.x1, bot.x1);
      const overlap = overlap1 - overlap0 + 1;
      if (overlap < minW * 0.7) continue;
      if (Math.abs(topLen - botLen) > topLen * 0.25) continue;

      const x0 = overlap0;
      const x1 = overlap1;
      const boxW = x1 - x0 + 1;
      const boxH = height;

      const leftInk = verticalInkRatio(ink, w, x0, top.y, bot.y);
      const rightInk = verticalInkRatio(ink, w, x1, top.y, bot.y);
      const closed = leftInk > 0.28 && rightInk > 0.28;
      const underlinePair = boxH <= Math.max(12, h * 0.022) && overlap > minW;
      if (!closed && !underlinePair) continue;

      const fill = interiorInkRatio(ink, w, x0 + 1, top.y + 1, x1 - 1, bot.y - 1);
      // Allow a bit of printed hint text inside; reject dense filled regions.
      if (fill > 0.42) continue;

      rects.push({ x: x0, y: top.y, w: boxW, h: boxH });
      break;
    }
  }
  return rects;
}

/** Single underline strokes → shallow text blanks (snap targets for vision). */
function underlineRects(segs, w, h) {
  const rects = [];
  const minW = Math.max(18, Math.floor(w * 0.06));
  // Cap width so full-page table rules are not treated as one field.
  const maxW = Math.floor(w * 0.78);
  const boxH = Math.max(11, Math.floor(h * 0.015));
  for (const s of segs) {
    const len = s.x1 - s.x0 + 1;
    if (len < minW || len > maxW) continue;
    if (s.y < h * 0.05 || s.y > h * 0.95) continue;
    // Skip near-full-width rules (usually table / section separators).
    if (len > w * 0.72 && (s.x0 < w * 0.08 || s.x1 > w * 0.92)) continue;
    const y = Math.max(0, s.y - boxH + 2);
    rects.push({ x: s.x0, y, w: len, h: boxH });
  }
  return rects;
}

function verticalInkRatio(ink, w, x, y0, y1) {
  if (y1 <= y0) return 0;
  let n = 0;
  let inkN = 0;
  for (let y = y0; y <= y1; y++) {
    n++;
    if (ink[y * w + x]) inkN++;
  }
  return inkN / n;
}

function interiorInkRatio(ink, w, x0, y0, x1, y1) {
  if (x1 <= x0 || y1 <= y0) return 1;
  let n = 0;
  let inkN = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      n++;
      if (ink[row + x]) inkN++;
    }
  }
  return n ? inkN / n : 1;
}

function dedupeRects(rects, pageW, pageH) {
  const filtered = rects.filter(
    (r) =>
      r.w >= pageW * 0.02 &&
      r.h >= pageH * 0.006 &&
      r.w <= pageW * 0.98 &&
      r.h <= pageH * 0.15,
  );
  filtered.sort((a, b) => a.y - b.y || a.x - b.x);
  const kept = [];
  for (const r of filtered) {
    if (!kept.some((k) => iou(r, k) > 0.55)) kept.push(r);
  }
  return kept;
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function mergeCombRows(rects, pageW, pageH) {
  if (rects.length === 0) return [];
  const maxCell = Math.max(28, Math.min(pageW, pageH) * 0.05);
  const byRow = [];
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const r of sorted) {
    const row = byRow.find(
      (group) => Math.abs(group[0].y - r.y) < Math.max(4, r.h * 0.45),
    );
    if (row) row.push(r);
    else byRow.push([r]);
  }

  const out = [];
  for (const row of byRow) {
    row.sort((a, b) => a.x - b.x);
    let i = 0;
    while (i < row.length) {
      const start = row[i];
      const cellish =
        start.w < start.h * 2.4 &&
        start.h < start.w * 2.4 &&
        start.w <= maxCell &&
        start.h <= maxCell;
      if (!cellish) {
        out.push(start);
        i++;
        continue;
      }
      let j = i + 1;
      let x1 = start.x + start.w;
      while (j < row.length) {
        const n = row[j];
        const similar =
          Math.abs(n.w - start.w) < start.w * 0.45 &&
          Math.abs(n.h - start.h) < start.h * 0.45 &&
          n.w <= maxCell &&
          n.h <= maxCell;
        const gap = n.x - x1;
        // Bridge DD | MM | YYYY group gaps (printed labels / spacing between groups).
        if (!similar || gap > start.w * 4.5) break;
        x1 = n.x + n.w;
        j++;
      }
      const count = j - i;
      // Prefer 8-cell DDMMYYYY; accept 6–10 digit grids.
      if (count >= 6 && count <= 12) {
        let cells = row.slice(i, j);
        // If we picked 9–12, keep the tightest 8 consecutive by gap sum.
        if (cells.length > 8) {
          cells = bestEightCells(cells);
        }
        const y = Math.min(...cells.map((c) => c.y));
        const bottom = Math.max(...cells.map((c) => c.y + c.h));
        const x0 = cells[0].x;
        const xRight = cells[cells.length - 1].x + cells[cells.length - 1].w;
        out.push({
          x: x0,
          y,
          w: xRight - x0,
          h: bottom - y,
          cells: cells.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
        });
        i = j;
      } else if (count >= 4) {
        const cells = row.slice(i, j);
        const y = Math.min(...cells.map((c) => c.y));
        const bottom = Math.max(...cells.map((c) => c.y + c.h));
        out.push({
          x: cells[0].x,
          y,
          w: x1 - cells[0].x,
          h: bottom - y,
          cells: cells.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
        });
        i = j;
      } else {
        out.push(start);
        i++;
      }
    }
  }
  return out;
}

/** Prefer 8 consecutive digit cells with the smallest internal gaps. */
function bestEightCells(cells) {
  if (cells.length <= 8) return cells;
  let best = cells.slice(0, 8);
  let bestGap = Infinity;
  for (let s = 0; s <= cells.length - 8; s++) {
    const slice = cells.slice(s, s + 8);
    let gap = 0;
    for (let k = 1; k < slice.length; k++) {
      gap += Math.max(0, slice[k].x - (slice[k - 1].x + slice[k - 1].w));
    }
    if (gap < bestGap) {
      bestGap = gap;
      best = slice;
    }
  }
  return best;
}

function classifyRect(r) {
  const aspect = r.w / Math.max(1, r.h);
  if (aspect < 1.35 && aspect > 0.65 && r.w < 36 && r.h < 36) return "checkbox";
  if (aspect > 4 && r.h < 40 && r.w / r.h > 5) {
    const approxCells = r.w / Math.max(1, r.h);
    if (approxCells >= 5 && approxCells <= 14) return "comb";
  }
  return "text";
}

function clamp01(n) {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
