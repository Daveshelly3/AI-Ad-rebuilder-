import { NextRequest, NextResponse } from "next/server";
import { generateBackground, activeProvider } from "@/lib/imagegen";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      prompt?: string;
      negativePrompt?: string;
      aspectRatio?: number;
      query?: string;
    };
    if (!body.prompt) {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const buffer = await generateBackground({
      prompt: body.prompt,
      negativePrompt: body.negativePrompt || "",
      aspectRatio: body.aspectRatio || 0.667,
      query: body.query,
    });

    const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    return NextResponse.json({ provider: activeProvider(), background: dataUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
