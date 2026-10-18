import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";
import type { FillFontFamily, ThaanaFontFamily } from "@/lib/types";
import { isThaanaFont } from "@/lib/types";

const FONT_FILES: Record<ThaanaFontFamily, string> = {
  bolhu: "bolhu.ttf",
  faruma: "faruma.ttf",
  waheed: "waheed.otf",
};

const cache = new Map<ThaanaFontFamily, Uint8Array>();

async function loadThaanaBytes(family: ThaanaFontFamily): Promise<Uint8Array> {
  const hit = cache.get(family);
  if (hit) return hit;
  const filePath = path.join(process.cwd(), "assets", "fonts", FONT_FILES[family]);
  const bytes = new Uint8Array(await readFile(filePath));
  cache.set(family, bytes);
  return bytes;
}

export function resolveThaanaFamily(family: FillFontFamily): ThaanaFontFamily {
  return isThaanaFont(family) ? family : "bolhu";
}

/** Embed a Thaana font for Dhivehi text. Registers fontkit once per document. */
export async function embedThaanaFont(
  doc: PDFDocument,
  family: FillFontFamily = "bolhu",
): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  const thaana = resolveThaanaFamily(family);
  const bytes = await loadThaanaBytes(thaana);
  return doc.embedFont(bytes, { subset: true });
}
