import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { AdSpec, TextElement } from "./adspec";

/**
 * The "editing" core. Given a generated photoreal background, the original ad
 * (for lifting brand assets), and the AdSpec, produce the final rebuilt ad:
 *   1. cover-fit the background to the original dimensions
 *   2. lift brand assets (logos/badges/script) pixel-exact from the original
 *   3. re-render plain informational text as crisp SVG layers
 */

interface BundledFont {
  family: string;
  file: string; // filename inside public/fonts
  weight: number;
}

// Optional bundled fonts. If the files are present they are embedded into the
// SVG via @font-face; otherwise we fall back to generic families so the
// pipeline always works (e.g. with no network to fetch fonts).
const BUNDLED_FONTS: BundledFont[] = [
  { family: "Anton", file: "Anton-Regular.ttf", weight: 400 },
  { family: "Oswald", file: "Oswald-Bold.ttf", weight: 700 },
  { family: "Inter", file: "Inter-Regular.ttf", weight: 400 },
  { family: "Inter", file: "Inter-Bold.ttf", weight: 700 },
];

function fontsDir(): string {
  return path.join(process.cwd(), "public", "fonts");
}

function availableFonts(): BundledFont[] {
  return BUNDLED_FONTS.filter((f) =>
    fs.existsSync(path.join(fontsDir(), f.file))
  );
}

// Build @font-face declarations for whichever bundled fonts exist on disk.
function fontFaceCss(): string {
  return availableFonts()
    .map((f) => {
      const data = fs.readFileSync(path.join(fontsDir(), f.file));
      const b64 = data.toString("base64");
      return `@font-face{font-family:'${f.family}';font-weight:${f.weight};src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
    })
    .join("\n");
}

// Pick a font-family stack for an element. Prefer a bundled font matching the
// hint; always include a generic fallback so text renders regardless.
function fontFamily(el: TextElement): string {
  const have = new Set(availableFonts().map((f) => f.family));
  const heavy = el.weight === "bold" || el.weight === "black";
  if (el.font_hint === "condensed-sans") {
    if (have.has("Anton")) return "'Anton', 'Oswald', sans-serif";
    if (have.has("Oswald")) return "'Oswald', sans-serif";
    return "sans-serif";
  }
  if (el.font_hint === "serif") return "'Georgia', serif";
  if (el.font_hint === "mono") return "monospace";
  if (el.font_hint === "script") return "'Brush Script MT', cursive";
  // default sans
  if (have.has("Inter")) return "'Inter', sans-serif";
  return heavy ? "sans-serif" : "sans-serif";
}

function fontWeightNumber(el: TextElement): number {
  switch (el.weight) {
    case "black":
      return 900;
    case "bold":
      return 700;
    case "medium":
      return 500;
    default:
      return 400;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a full-canvas SVG with every text element positioned at its bbox.
 * We use textLength + lengthAdjust so each line fills its original box width,
 * which keeps the layout faithful even when the re-rendered font differs.
 */
export function buildTextSvg(spec: AdSpec): string {
  const W = spec.width;
  const H = spec.height;

  const layers = spec.textElements
    .map((el) => {
      const boxX = el.bbox.x * W;
      const boxY = el.bbox.y * H;
      const boxW = el.bbox.w * W;
      const boxH = el.bbox.h * H;
      // Font size driven by the box height; baseline near the box bottom.
      const fontSize = Math.max(8, boxH * 0.82);
      const baseline = boxY + boxH * 0.82;

      let anchor = "start";
      let x = boxX;
      if (el.align === "center") {
        anchor = "middle";
        x = boxX + boxW / 2;
      } else if (el.align === "right") {
        anchor = "end";
        x = boxX + boxW;
      }

      const fill = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(el.colorHex)
        ? el.colorHex
        : "#ffffff";

      return `<text x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" textLength="${boxW.toFixed(
        1
      )}" lengthAdjust="spacingAndGlyphs" text-anchor="${anchor}" font-family="${fontFamily(
        el
      )}" font-weight="${fontWeightNumber(el)}" font-size="${fontSize.toFixed(
        1
      )}" fill="${fill}">${escapeXml(el.text)}</text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${fontFaceCss()}</style>
${layers}
</svg>`;
}

export interface ComposeInput {
  backgroundBuffer: Buffer;
  originalBuffer: Buffer;
  spec: AdSpec;
}

export async function composeAd({
  backgroundBuffer,
  originalBuffer,
  spec,
}: ComposeInput): Promise<Buffer> {
  const W = spec.width;
  const H = spec.height;

  // 1. Cover-fit the generated background to the original canvas size.
  const base = sharp(backgroundBuffer).resize(W, H, { fit: "cover" });

  const composites: sharp.OverlayOptions[] = [];

  // 2. Lift brand assets pixel-exact from the original ad.
  const original = sharp(originalBuffer).resize(W, H, { fit: "fill" });
  const originalPng = await original.png().toBuffer();
  for (const asset of spec.assets) {
    const left = Math.max(0, Math.round(asset.bbox.x * W));
    const top = Math.max(0, Math.round(asset.bbox.y * H));
    const width = Math.min(W - left, Math.round(asset.bbox.w * W));
    const height = Math.min(H - top, Math.round(asset.bbox.h * H));
    if (width <= 0 || height <= 0) continue;
    const crop = await sharp(originalPng)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
    composites.push({ input: crop, left, top });
  }

  // 3. Re-render plain text as one SVG layer on top.
  const svg = buildTextSvg(spec);
  composites.push({ input: Buffer.from(svg), top: 0, left: 0 });

  return base.composite(composites).png().toBuffer();
}
