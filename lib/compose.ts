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

// A padded pixel rectangle for an asset, clamped to the canvas. Padding recovers
// letters the vision model may have cropped (e.g. the "l" in "Gravel") and gives
// a background margin for the cut-out to feather into.
function paddedRect(
  bbox: { x: number; y: number; w: number; h: number },
  W: number,
  H: number,
  fx: number,
  fy: number
): { left: number; top: number; width: number; height: number } {
  const px = bbox.w * fx;
  const py = bbox.h * fy;
  const x0 = Math.max(0, bbox.x - px);
  const y0 = Math.max(0, bbox.y - py);
  const x1 = Math.min(1, bbox.x + bbox.w + px);
  const y1 = Math.min(1, bbox.y + bbox.h + py);
  return {
    left: Math.round(x0 * W),
    top: Math.round(y0 * H),
    width: Math.max(1, Math.round((x1 - x0) * W)),
    height: Math.max(1, Math.round((y1 - y0) * H)),
  };
}

/**
 * "Cut out" a lifted asset so it blends onto the new photo instead of sitting in
 * a rectangular box. Strategy:
 *   1. Flood-fill from the crop's border (which, thanks to padding, is
 *      background) growing through locally-similar pixels. This removes the
 *      surrounding scene — sky, clouds, road texture — and stops at the sharp
 *      edges of the logo/text. Works for gradients and textured backgrounds.
 *   2. A global color key against the border background color cleans up any
 *      enclosed background (e.g. sky showing inside letter holes).
 *   3. Blur the alpha channel slightly to soften anti-aliased halos.
 */
async function cutoutAsset(crop: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(crop)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels; // 4 (RGBA)
  const idx = (x: number, y: number) => (y * w + x) * ch;

  // Representative background color = median of border pixels.
  const samples: Array<[number, number, number]> = [];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 40));
  const push = (x: number, y: number) => {
    const i = idx(x, y);
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let x = 0; x < w; x += step) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y += step) {
    push(0, y);
    push(w - 1, y);
  }
  const median = (c: number) => {
    const arr = samples.map((s) => s[c]).sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)] ?? 0;
  };
  const bg: [number, number, number] = [median(0), median(1), median(2)];

  const dist2 = (i: number, r: number, g: number, b: number) => {
    const dr = data[i] - r;
    const dg = data[i + 1] - g;
    const db = data[i + 2] - b;
    return dr * dr + dg * dg + db * db;
  };

  // 1. Region-growing flood fill from background-colored border pixels. Seeds
  //    are gated to the background color so a dark element touching the crop
  //    edge can't seed removal of the logo itself.
  const localTol = 30 * 30; // neighbor-to-neighbor similarity (squared)
  const seedTol = 70 * 70; // border pixel must be near bg to seed
  const removed = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const p = y * w + x;
    if (!removed[p] && dist2(p * ch, bg[0], bg[1], bg[2]) < seedTol) {
      removed[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop() as number;
    const px = p % w;
    const py = (p - px) / w;
    const pi = p * ch;
    const tryN = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const np = ny * w + nx;
      if (removed[np]) return;
      if (dist2(np * ch, data[pi], data[pi + 1], data[pi + 2]) < localTol) {
        removed[np] = 1;
        stack.push(np);
      }
    };
    tryN(px - 1, py);
    tryN(px + 1, py);
    tryN(px, py - 1);
    tryN(px, py + 1);
  }

  // 2. Global key for enclosed background (e.g. sky inside letter holes).
  const globalTol = 62 * 62;
  for (let p = 0; p < w * h; p++) {
    if (!removed[p] && dist2(p * ch, bg[0], bg[1], bg[2]) < globalTol) {
      removed[p] = 1;
    }
  }

  for (let p = 0; p < w * h; p++) {
    if (removed[p]) data[p * ch + 3] = 0;
  }

  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
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

  // 2. Lift brand assets from the original ad, padded so no letters are cropped,
  //    then cut out their background so they blend onto the new photo.
  const originalPng = await sharp(originalBuffer)
    .resize(W, H, { fit: "fill" })
    .png()
    .toBuffer();
  for (const asset of spec.assets) {
    const rect = paddedRect(asset.bbox, W, H, 0.06, 0.12);
    rect.width = Math.min(W - rect.left, rect.width);
    rect.height = Math.min(H - rect.top, rect.height);
    if (rect.width <= 0 || rect.height <= 0) continue;
    const crop = await sharp(originalPng).extract(rect).png().toBuffer();
    const cut = await cutoutAsset(crop);
    composites.push({ input: cut, left: rect.left, top: rect.top });
  }

  // 3. Re-render plain text as one rasterized layer on top.
  composites.push({ input: rasterizeText(spec), top: 0, left: 0 });

  return base.composite(composites).png().toBuffer();
}
