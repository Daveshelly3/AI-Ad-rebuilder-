import { NextRequest, NextResponse } from "next/server";
import { composeAd } from "@/lib/compose";
import { AdSpecSchema } from "@/lib/adspec";

export const runtime = "nodejs";
export const maxDuration = 60;

// Decode a data URL (or raw base64) into a Buffer.
function dataUrlToBuffer(input: string): Buffer {
  const comma = input.indexOf(",");
  const b64 = comma >= 0 && input.startsWith("data:") ? input.slice(comma + 1) : input;
  return Buffer.from(b64, "base64");
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
    const final = await composeAd({
      spec,
      originalBuffer: dataUrlToBuffer(body.original),
      backgroundBuffer: dataUrlToBuffer(body.background),
    });

    const dataUrl = `data:image/png;base64,${final.toString("base64")}`;
    return NextResponse.json({ result: dataUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
