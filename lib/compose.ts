import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import type { AdSpec, TextElement } from "./adspec";

/**
 * The "editing" core. Given a generated photoreal background, the original ad
 * (for lifting brand assets), and the AdSpec, produce the final rebuilt ad:
 *   1. cover-fit the background to the original dimensions
 *   2. lift brand assets (logos/badges/script) pixel-exact from the original
 *   3. re-render plain informational text as crisp layers
 *
 * Text is rasterized with @resvg/resvg-js using bundled TTF font files. We use
 * resvg (not sharp/librsvg) for text because librsvg ignores embedded fonts and
 * relies on system fonts, which don't exist on serverless platforms (Vercel),
 * producing tofu boxes. resvg loads fonts directly from `fontFiles`.
 */

// Bundled static TTFs that ship with the app (see assets/fonts).
function fontsDir(): string {
  return path.join(process.cwd(), "assets", "fonts");
}

function fontFiles(): string[] {
  try {
    return fs
      .readdirSync(fontsDir())
      .filter((f) => f.toLowerCase().endsWith(".ttf"))
      .map((f) => path.join(fontsDir(), f));
  } catch {
    return [];
  }
}

// Map an element's hint/weight to a bundled font family name.
function fontFamily(el: TextElement): string {
  switch (el.font_hint) {
    case "condensed-sans":
      return "Anton";
    case "serif":
    case "sans":
    case "mono":
    case "script":
    default:
      return "PT Sans";
  }
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

// Rough per-glyph width factor relative to font size, used to keep a line from
// overflowing its box when the re-rendered font is wider than the original.
function widthFactor(family: string): number {
  return family === "Anton" ? 0.46 : 0.55;
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
 * Font size is driven by the box height, then capped so the estimated line
 * width fits the box, keeping the layout faithful across fonts.
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
      const family = fontFamily(el);

      // Start from height, then shrink to fit the box width if needed.
      let fontSize = Math.max(8, boxH * 0.82);
      const estWidth = el.text.length * widthFactor(family) * fontSize;
      if (estWidth > boxW && estWidth > 0) {
        fontSize = Math.max(8, fontSize * (boxW / estWidth));
      }
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

      return `<text x="${x.toFixed(1)}" y="${baseline.toFixed(
        1
      )}" text-anchor="${anchor}" font-family="${family}" font-weight="${fontWeightNumber(
        el
      )}" font-size="${fontSize.toFixed(1)}" fill="${fill}">${escapeXml(
        el.text
      )}</text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${layers}
</svg>`;
}

// Rasterize the text SVG into a transparent PNG using bundled fonts.
function rasterizeText(spec: AdSpec): Buffer {
  const svg = buildTextSvg(spec);
  const resvg = new Resvg(svg, {
    font: {
      loadSystemFonts: false,
      fontFiles: fontFiles(),
      defaultFontFamily: "PT Sans",
    },
  });
  return Buffer.from(resvg.render().asPng());
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
  const originalPng = await sharp(originalBuffer)
    .resize(W, H, { fit: "fill" })
    .png()
    .toBuffer();
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

  // 3. Re-render plain text as one rasterized layer on top.
  composites.push({ input: rasterizeText(spec), top: 0, left: 0 });

  return base.composite(composites).png().toBuffer();
}
