import type { AdSpec } from "./adspec";

/**
 * Rebuild the ad with Nano Banana (Gemini 2.5 Flash Image). Instead of lifting
 * pixels or re-rendering text with fonts, we hand the model two images — the
 * original ad (reference only) and a real photo (the new background) — and ask
 * it to redraw the text and branding onto the photo. The model "types in" the
 * text and recreates the logo, so nothing is pixel-copied from the original.
 */

export interface ImageInput {
  data: Buffer;
  mime: string;
}

export interface RebuildInput {
  spec: AdSpec;
  original: ImageInput;
  background: ImageInput;
}

function buildInstruction(spec: AdSpec): string {
  const texts = spec.textElements
    .map((t) => `  - "${t.text}"  (${t.role}, ${t.align}, ${t.weight})`)
    .join("\n");
  const assets = spec.assets
    .map((a) => `  - ${a.kind}${a.label ? `: ${a.label}` : ""}`)
    .join("\n");

  return `You are an expert ad designer recreating an advertisement poster.

IMAGE 1 is the ORIGINAL ad. Use it ONLY as a reference for the exact text wording, the logo and branding, the colours, the typography and the layout. DO NOT reuse IMAGE 1's background scene.

IMAGE 2 is a REAL photograph. Use it as the new full-bleed background of the poster.

Rebuild the advertisement on top of IMAGE 2:
- Keep IMAGE 2 as the photographic background, filling the entire poster.
- CRITICAL: reproduce every word and number with 100% EXACT spelling — do not drop, add, or alter any character (e.g. keep dates, distances and URLs character-for-character). Place each text element in a similar position, size, weight and colour as the original:
${texts || "  (none)"}
- Faithfully recreate the brand elements exactly as they appear in IMAGE 1 (same shapes, colours and lettering):
${assets || "  (none)"}
- Match the original's typographic style as closely as you can. Make ALL text crisp, sharp and perfectly legible on the photo — add a subtle drop shadow or a soft darkened scrim behind text only where needed for contrast.
- Output ONE finished portrait poster with the same proportions as the original. Do not add any extra text, captions, borders, or watermarks.`;
}

export async function rebuildAd({
  spec,
  original,
  background,
}: RebuildInput): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    // gemini-3-pro-image renders text + logos far more accurately than flash.
    model: process.env.REBUILD_MODEL || "gemini-3-pro-image",
  });

  const result = await model.generateContent([
    { text: buildInstruction(spec) },
    { inlineData: { mimeType: original.mime, data: original.data.toString("base64") } },
    {
      inlineData: {
        mimeType: background.mime,
        data: background.data.toString("base64"),
      },
    },
  ]);

  const parts = result.response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = (part as { inlineData?: { data: string } }).inlineData;
    if (inline?.data) return Buffer.from(inline.data, "base64");
  }
  throw new Error("Nano Banana returned no image data");
}
