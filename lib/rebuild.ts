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

  return `You are an expert ad designer. You will design a brand-new poster FROM SCRATCH on a photo.

IMAGE 2 is a REAL photograph. It is your CANVAS: it must fill the ENTIRE poster, edge to edge, as the one and only background.

IMAGE 1 is the ORIGINAL ad, provided ONLY as a reference for the wording, the logo artwork, the colours and the typographic style. It is NOT to appear in the output.

ABSOLUTELY DO NOT:
- Do NOT paste, embed, inset, frame, or place IMAGE 1 (or any portion of it — its panels, coloured blocks, photo, or background) as a card, rectangle, sticker, sub-image, or overlay on top of IMAGE 2.
- Do NOT shrink the whole ad onto the photo. Do NOT create a poster-within-a-poster.
- The result must NEVER look like the original ad floating on a background.

DO:
- Treat IMAGE 2 as the full-bleed photographic background and design the poster DIRECTLY on it, as if a designer set type and logos natively over the photo.
- Reproduce every word and number with 100% EXACT spelling — do not drop, add, or alter any character (keep dates, distances, phone numbers and URLs character-for-character):
${texts || "  (none)"}
- Recreate the brand/logo artwork faithfully (same shapes, colours, lettering), drawn cleanly onto the photo — not copied as a rectangle:
${assets || "  (none)"}
- Arrange the text in a clean, balanced layout that suits the photo, echoing the original's hierarchy and colours. Make ALL text crisp, sharp and perfectly legible — add a subtle drop shadow or a soft darkened gradient scrim behind dense text only where needed for contrast.
- Output ONE finished portrait poster, same proportions as the original, with NO borders, frames, captions or watermarks.`;
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
    // Flash (~10s) is the default: nearly pro-quality with a strong prompt, and
    // it stays well under the serverless timeout. Set REBUILD_MODEL to
    // gemini-3-pro-image for maximum fidelity if your plan allows longer runs.
    model: process.env.REBUILD_MODEL || "gemini-2.5-flash-image",
  });

  const content = [
    { text: buildInstruction(spec) },
    { inlineData: { mimeType: original.mime, data: original.data.toString("base64") } },
    {
      inlineData: {
        mimeType: background.mime,
        data: background.data.toString("base64"),
      },
    },
  ];

  // Retry transient model errors (e.g. 503 "high demand", 429) with backoff.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await model.generateContent(content);
      const parts = result.response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const inline = (part as { inlineData?: { data: string } }).inlineData;
        if (inline?.data) return Buffer.from(inline.data, "base64");
      }
      throw new Error("Nano Banana returned no image data");
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /\b(503|429|500|overloaded|high demand|unavailable)\b/i.test(
        msg
      );
      if (!transient || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 1200 * Math.pow(2, attempt)));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Nano Banana failed");
}
