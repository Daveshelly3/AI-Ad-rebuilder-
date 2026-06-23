import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import {
  ANALYSIS_PROMPT,
  AdSpecModelSchema,
  type AdSpec,
} from "@/lib/adspec";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// Pull the first JSON object out of a model response, tolerating ```json fences
// or leading/trailing prose.
function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found in response");
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not set" },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const file = form.get("image");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No image uploaded" }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // Normalize ANY upload (HEIC, huge screenshots, odd metadata) into a clean,
    // bounded JPEG before sending to the model. This avoids format/size/media-
    // type issues that vary by device. Original dimensions are kept for the spec.
    let width = 0;
    let height = 0;
    let jpeg: Buffer;
    try {
      const pipeline = sharp(bytes, { failOn: "none" }).rotate();
      const meta = await pipeline.metadata();
      width = meta.width ?? 0;
      height = meta.height ?? 0;
      jpeg = await pipeline
        .resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
    } catch (e) {
      const m = e instanceof Error ? e.message : "decode failed";
      return NextResponse.json(
        { error: `Could not read this image (${m}). Try a PNG or JPG screenshot.` },
        { status: 400 }
      );
    }
    if (!width || !height) {
      return NextResponse.json(
        { error: "Could not read image dimensions" },
        { status: 400 }
      );
    }

    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: jpeg.toString("base64"),
              },
            },
            { type: "text", text: ANALYSIS_PROMPT },
          ],
        },
      ],
    });

    const textPart = message.content.find((c) => c.type === "text");
    const raw = textPart && "text" in textPart ? textPart.text : "";
    const parsed = AdSpecModelSchema.parse(extractJson(raw));

    const spec: AdSpec = {
      ...parsed,
      width,
      height,
      aspectRatio: width / height,
    };

    return NextResponse.json({ spec });
  } catch (err) {
    console.error("[analyze] error:", err);
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
