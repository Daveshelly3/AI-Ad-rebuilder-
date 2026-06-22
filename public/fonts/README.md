# Optional bundled fonts

Drop TrueType font files here to improve text fidelity in the rebuilt ad. The
compositor (`lib/compose.ts`) auto-detects these files and embeds them into the
SVG text layer. If they're absent, it falls back to generic system families, so
the app works without them.

Recognized filenames:

- `Anton-Regular.ttf` — condensed bold headlines
- `Oswald-Bold.ttf` — condensed bold fallback
- `Inter-Regular.ttf` — body text
- `Inter-Bold.ttf` — bold body text

All are available under the SIL Open Font License from Google Fonts.
