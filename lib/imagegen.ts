import fs from "node:fs/promises";
import path from "node:path";

/**
 * Provider-agnostic background generator. Every provider takes the same request
 * and returns a raw image buffer (PNG/JPEG). The active provider is chosen via
 * the IMAGE_PROVIDER env var so the rest of the app never knows which model ran.
 *
 * Providers:
 *   - mock   : returns a bundled placeholder photo (no API key needed; dev default)
 *   - gemini : Google Gemini 2.5 Flash Image
 *   - openai : OpenAI gpt-image-1
 *   - flux   : Black Forest Labs Flux via Replicate
 */

export interface GenerateBackgroundRequest {
  prompt: string;
  negativePrompt: string;
  // width/height ratio, used to request the closest supported size.
  aspectRatio: number;
}

const PHOTOREAL_SUFFIX =
  "Photorealistic documentary photograph, shot on a full-frame camera, natural daylight, realistic depth of field, fine film grain, true-to-life colors, candid composition. No text, no logos, no watermark.";

export function activeProvider(): string {
  return (process.env.IMAGE_PROVIDER || "mock").toLowerCase();
}

export async function generateBackground(
  req: GenerateBackgroundRequest
): Promise<Buffer> {
  const provider = activeProvider();
  switch (provider) {
    case "gemini":
      return generateGemini(req);
    case "openai":
      return generateOpenAI(req);
    case "flux":
      return generateFlux(req);
    case "mock":
    default:
      return generateMock(req);
  }
}

function fullPrompt(req: GenerateBackgroundRequest): string {
  return `${req.prompt}\n\n${PHOTOREAL_SUFFIX}\n\nAvoid: ${req.negativePrompt}`;
}

// Map a ratio to the nearest size a provider supports (portrait/square/landscape).
function nearestSize(aspectRatio: number): { width: number; height: number } {
  if (aspectRatio < 0.85) return { width: 1024, height: 1536 }; // portrait
  if (aspectRatio > 1.18) return { width: 1536, height: 1024 }; // landscape
  return { width: 1024, height: 1024 }; // square-ish
}

async function generateMock(_req: GenerateBackgroundRequest): Promise<Buffer> {
  const p = path.join(process.cwd(), "public", "mock-bg.jpg");
  return fs.readFile(p);
}

async function generateGemini(req: GenerateBackgroundRequest): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-image-preview",
  });
  const result = await model.generateContent(fullPrompt(req));
  const parts = result.response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = (part as { inlineData?: { data: string } }).inlineData;
    if (inline?.data) return Buffer.from(inline.data, "base64");
  }
  throw new Error("Gemini returned no image data");
}

async function generateOpenAI(req: GenerateBackgroundRequest): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const { width, height } = nearestSize(req.aspectRatio);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: fullPrompt(req),
      size: `${width}x${height}`,
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI image error: ${await res.text()}`);
  const json = (await res.json()) as { data: { b64_json: string }[] };
  return Buffer.from(json.data[0].b64_json, "base64");
}

async function generateFlux(req: GenerateBackgroundRequest): Promise<Buffer> {
  const key = process.env.REPLICATE_API_TOKEN;
  if (!key) throw new Error("REPLICATE_API_TOKEN is not set");
  const { width, height } = nearestSize(req.aspectRatio);
  // Use Replicate's blocking API to get a finished prediction in one call.
  const res = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          prompt: fullPrompt(req),
          width,
          height,
          output_format: "png",
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Flux error: ${await res.text()}`);
  const json = (await res.json()) as { output?: string | string[] };
  const url = Array.isArray(json.output) ? json.output[0] : json.output;
  if (!url) throw new Error("Flux returned no output URL");
  const img = await fetch(url);
  return Buffer.from(await img.arrayBuffer());
}
