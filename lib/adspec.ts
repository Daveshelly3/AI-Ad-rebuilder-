import { z } from "zod";

/**
 * AdSpec is the structured, category-agnostic representation of an uploaded ad.
 * It is produced by the vision analysis step and is the single source of truth
 * for both background generation and recompositing. Nothing here is specific to
 * any ad category — every field is inferred per-upload.
 */

// Normalized bounding box: all values in [0, 1] relative to image width/height.
export const BBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type BBox = z.infer<typeof BBoxSchema>;

export const TextElementSchema = z.object({
  // Exact text as it appears in the ad. Preserve casing and punctuation.
  text: z.string(),
  bbox: BBoxSchema,
  role: z.enum(["headline", "subhead", "body", "cta", "caption"]),
  // Hex color of the text fill, e.g. "#FFFFFF".
  colorHex: z.string(),
  weight: z.enum(["regular", "medium", "bold", "black"]),
  case: z.enum(["upper", "title", "sentence", "mixed"]),
  align: z.enum(["left", "center", "right"]),
  // Loose descriptor of the typeface so we can map to a bundled font.
  font_hint: z.enum(["condensed-sans", "sans", "serif", "script", "mono"]),
});
export type TextElement = z.infer<typeof TextElementSchema>;

export const AssetSchema = z.object({
  // Brand/graphic regions that must be preserved pixel-exact (lifted from the
  // original upload) rather than re-rendered.
  kind: z.enum(["logo", "badge", "script", "icon", "graphic"]),
  bbox: BBoxSchema,
  // Short human label, e.g. "GO Gravel wordmark".
  label: z.string().optional(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const ThemeSchema = z.object({
  // Generic category, e.g. "sports/cycling event", "restaurant", "cosmetics".
  category: z.string(),
  // The main subject the photoreal scene must depict.
  subject: z.string(),
  setting: z.string(),
  palette: z.array(z.string()),
  mood: z.string(),
  // Ready-to-use positive prompt for the photoreal background generator.
  prompt: z.string(),
  // Negative prompt steering away from the AI-ad gloss.
  negativePrompt: z.string(),
  // Editable keyword chips surfaced to the user for confirmation.
  keywords: z.array(z.string()),
});
export type Theme = z.infer<typeof ThemeSchema>;

export const AdSpecSchema = z.object({
  // width/height ratio, e.g. 0.667 for a 2:3 portrait poster.
  aspectRatio: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  textElements: z.array(TextElementSchema),
  assets: z.array(AssetSchema),
  theme: ThemeSchema,
});
export type AdSpec = z.infer<typeof AdSpecSchema>;

// The model returns everything except the pixel dimensions (filled in server-side).
export const AdSpecModelSchema = AdSpecSchema.omit({
  aspectRatio: true,
  width: true,
  height: true,
});
export type AdSpecModel = z.infer<typeof AdSpecModelSchema>;

/**
 * Instruction prompt for the vision model. It must work for ANY ad category, so
 * it asks for generic structure (text, brand assets, theme) and never assumes a
 * subject. The model is told to return strict JSON matching AdSpecModelSchema.
 */
export const ANALYSIS_PROMPT = `You are an expert ad deconstructor. You are given an image of an AI-generated advertisement (any category: events, food, products, software, fashion, etc.).

Your job is to decompose it into a structured JSON spec so the ad can be REBUILT with the exact same information but a photorealistic, real-world background instead of the synthetic AI look.

Return ONLY valid JSON (no markdown, no commentary) with this exact shape:

{
  "textElements": [
    {
      "text": "exact text as shown, preserve casing/punctuation",
      "bbox": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
      "role": "headline | subhead | body | cta | caption",
      "colorHex": "#RRGGBB",
      "weight": "regular | medium | bold | black",
      "case": "upper | title | sentence | mixed",
      "align": "left | center | right",
      "font_hint": "condensed-sans | sans | serif | script | mono"
    }
  ],
  "assets": [
    { "kind": "logo | badge | script | icon | graphic", "bbox": { "x":0,"y":0,"w":0,"h":0 }, "label": "short description" }
  ],
  "theme": {
    "category": "generic category of the ad",
    "subject": "the main subject the new photoreal scene must depict",
    "setting": "physical setting/environment for the scene",
    "palette": ["#hex", "#hex"],
    "mood": "short mood description",
    "prompt": "a detailed prompt to generate a PHOTOREALISTIC real-world background scene that matches the ad's subject and setting. The scene's subject MUST match the ad (e.g. if it's a gravel cycling event, gravel riders on a gravel road; not road cyclists on tarmac). Describe real photography, natural light.",
    "negativePrompt": "things to avoid: oversaturated, CGI, 3d render, poster, text, watermark, plastic, oversharpened, unnaturally symmetrical",
    "keywords": ["short", "editable", "theme", "keywords"]
  }
}

Rules:
- bbox values are normalized 0..1 relative to image width (x,w) and height (y,h). Be as accurate as you can.
- For logos/wordmarks/badges/script, the bbox MUST enclose the COMPLETE element with a small margin on every side. Never crop a letter or part of a mark (e.g. include the full word, not "Grave" for "Gravel"). When unsure, make the box slightly larger.
- Put STYLIZED brand marks, wordmark logos, badges, and decorative script taglines into "assets" (these will be lifted pixel-exact from the original). Put plain informational text (dates, prices, distances, URLs, labels) into "textElements" (these will be re-rendered).
- A piece of text can ALSO be referenced as an asset if it is highly stylized (e.g. a hand-script tagline). Prefer assets for anything whose exact lettering matters to the brand.
- Never invent text. Only include what is actually visible.
- The theme.prompt must produce a scene whose subject and environment match the ad so the rebuild is believable.`;
