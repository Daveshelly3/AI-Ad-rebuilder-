# AI-Ad Rebuilder

Upload an obviously-AI-generated ad and rebuild it: **keep every piece of real
information exact** (text, dates, prices, location, URL, logos, taglines) while
**replacing the synthetic scene with a photorealistic, theme-matched one**. The
emphasis is *editing* — decompose the ad and recomposite — not regenerating the
whole thing. It works on **any ad category**; the theme is inferred per upload,
so a cycling poster gets gravel riders on gravel and a food ad gets a real dish.

## How it works

```
upload ──▶ /api/analyze ──▶ AdSpec (text + logos + theme, via Claude vision)
                               │  (you confirm/edit the theme keywords)
                               ▼
            /api/generate ──▶ photorealistic background (image model)
                               │
            /api/compose  ──▶ final PNG
```

1. **Analyze** — Claude vision decomposes the ad into a category-agnostic
   `AdSpec`: exact text with normalized bounding boxes, brand assets to preserve,
   and an inferred theme with a ready photoreal generation prompt.
2. **Review** — you see the extracted text and can edit the theme keywords/prompt
   before anything is generated.
3. **Background** — a real, theme-matched photo is fetched (Pexels) — or
   generated (Gemini/Flux/OpenAI) if you prefer.
4. **Recomposite** — `sharp` lifts logos/badges/script from the original, cuts
   their background away (flood-fill) so they blend onto the new photo, and
   re-renders the plain text with bundled fonts via `@resvg/resvg-js`.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in keys
npm run dev                  # http://localhost:3000
```

### Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Used for ad analysis (vision). |
| `ANTHROPIC_MODEL` | no | Defaults to a current vision-capable Claude model. |
| `IMAGE_PROVIDER` | no | `pexels` (real photos) \| `mock` \| `gemini` \| `openai` \| `flux`. |
| `PEXELS_API_KEY` | for `pexels` | Free key from https://www.pexels.com/api/. |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `REPLICATE_API_TOKEN` | per provider | Set the one matching `IMAGE_PROVIDER`. |

`IMAGE_PROVIDER=mock` returns a bundled placeholder background, so you can run
the **entire** pipeline (analyze → review → compose → download) with only an
Anthropic key. Switch to `gemini`/`openai`/`flux` for real photoreal scenes.

## Image providers

`lib/imagegen.ts` is a single adapter — add a provider by implementing one
function. Defaults to Google **Gemini 2.5 Flash Image**.

## Fonts

Re-rendered text uses generic system fonts out of the box. Drop TrueType files
into `public/fonts/` (see that folder's README) to improve fidelity; true brand
logos and decorative script are always lifted as pixels, never re-rendered.

## Deploy

Deploys to Vercel as a standard Next.js app. The image/compose API routes use
the Node.js runtime (required by `sharp`).
