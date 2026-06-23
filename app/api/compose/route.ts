import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { composeAd } from "@/lib/compose";
import { rebuildAd } from "@/lib/rebuild";
import { AdSpecSchema } from "@/lib/adspec";

export const runtime = "nodejs";
export const maxDuration = 120;

// Decode a data URL into a Buffer + mime type.
function parseDataUrl(input: string): { data: Buffer; mime: string } {
  const m = input.match(/^data:([^;,]+)[^,]*,(.*)$/s);
  if (m) return { data: Buffer.from(m[2], "base64"), mime: m[1] };
  return { data: Buffer.from(input, "base64"), mime: "image/png" };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      spec?: unknown;
      original?: string;
      background?: string;
    };
    if (!body.spec || !body.original || !body.background) {
      return NextResponse.json(
        { error: "Missing spec, original, or background" },
        { status: 400 }
      );
    }

    const spec = AdSpecSchema.parse(body.spec);
    const original = parseDataUrl(body.original);
    const background = parseDataUrl(body.background);

    // Default: rebuild with Nano Banana (Gemini image edit). Falls back to the
    // deterministic sharp compositor when COMPOSE_MODE=overlay or no Gemini key.
    const useAi =
      (process.env.COMPOSE_MODE || "ai").toLowerCase() !== "overlay" &&
      !!process.env.GEMINI_API_KEY;

    let final: Buffer;
    let mode: string;
    if (useAi) {
      const raw = await rebuildAd({ spec, original, background });
      // Normalize to the original poster's exact dimensions.
      final = await sharp(raw)
        .resize(spec.width, spec.height, { fit: "cover" })
        .png()
        .toBuffer();
      mode = "nano-banana";
    } else {
      final = await composeAd({
        spec,
        originalBuffer: original.data,
        backgroundBuffer: background.data,
      });
      mode = "overlay";
    }

    const dataUrl = `data:image/png;base64,${final.toString("base64")}`;
    return NextResponse.json({ result: dataUrl, mode });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
