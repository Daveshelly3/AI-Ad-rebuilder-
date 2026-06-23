"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { AdSpec } from "@/lib/adspec";

type Step = 1 | 2 | 3 | 4;

async function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * Normalize any uploaded image (incl. iOS HEIC and huge screenshots) into a
 * bounded JPEG in the browser. This sidesteps device-specific format/size
 * issues on the server and keeps request payloads small.
 */
async function normalizeImage(
  file: File,
  max = 1600
): Promise<{ blob: Blob; dataUrl: string }> {
  const srcUrl = await readFileAsDataUrl(file);
  const img = document.createElement("img");
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not read that image file."));
    img.src = srcUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height || 1));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported.");
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Image conversion failed."))),
      "image/jpeg",
      0.9
    )
  );
  return { blob, dataUrl };
}

export default function Home() {
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<Blob | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string>("");
  const [spec, setSpec] = useState<AdSpec | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<string>("");
  const [background, setBackground] = useState<string>("");
  const [result, setResult] = useState<string>("");
  const [provider, setProvider] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  const aspectRatio = spec ? spec.aspectRatio : 0.667;

  const onPick = useCallback(async (f: File) => {
    setError("");
    setSpec(null);
    setBackground("");
    setResult("");
    setStep(1);
    try {
      const { blob, dataUrl } = await normalizeImage(f);
      setFile(blob);
      setOriginalUrl(dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that image.");
      setFile(null);
      setOriginalUrl("");
    }
  }, []);

  async function analyze() {
    if (!file) return;
    setBusy("Analyzing the ad…");
    setError("");
    try {
      const fd = new FormData();
      fd.append("image", file, "ad.jpg");
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Analyze failed");
      const s = json.spec as AdSpec;
      setSpec(s);
      setKeywords(s.theme.keywords);
      setPrompt(s.theme.prompt);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyze failed");
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    if (!spec) return;
    setBusy("Generating photorealistic background…");
    setError("");
    try {
      const fullPrompt = keywords.length
        ? `${prompt}\n\nEmphasize: ${keywords.join(", ")}.`
        : prompt;
      // Real-photo providers (Pexels) search by this short query; keywords are
      // the most reliable signal, falling back to the theme subject.
      const query = keywords.length
        ? keywords.join(" ")
        : `${spec.theme.subject} ${spec.theme.setting}`;
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: fullPrompt,
          negativePrompt: spec.theme.negativePrompt,
          aspectRatio: spec.aspectRatio,
          query,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Generate failed");
      setBackground(json.background);
      setProvider(json.provider);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setBusy("");
    }
  }

  async function compose() {
    if (!spec || !background || !originalUrl) return;
    setBusy("Rebuilding the ad with AI — this usually takes 10–20s…");
    setError("");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch("/api/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, original: originalUrl, background }),
        signal: ctrl.signal,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Compose failed");
      setResult(json.result);
      setStep(4);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      setError(
        aborted
          ? "The rebuild took too long and timed out. Please try again."
          : e instanceof Error
          ? e.message
          : "Compose failed"
      );
    } finally {
      clearTimeout(timer);
      setBusy("");
    }
  }

  const steps = useMemo(
    () => [
      { n: 1, label: "Upload" },
      { n: 2, label: "Review" },
      { n: 3, label: "Background" },
      { n: 4, label: "Rebuild" },
    ],
    []
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">AI-Ad Rebuilder</h1>
        <p className="mt-2 max-w-2xl text-neutral-400">
          Upload an AI-generated ad. We keep every word, price and logo exact,
          and swap the synthetic scene for a photorealistic, theme-matched one.
        </p>
      </header>

      {/* Stepper */}
      <ol className="mb-8 flex gap-2 text-sm">
        {steps.map((s) => (
          <li
            key={s.n}
            className={`flex items-center gap-2 rounded-full px-3 py-1 ${
              step >= (s.n as Step)
                ? "bg-emerald-600/20 text-emerald-300"
                : "bg-neutral-800 text-neutral-500"
            }`}
          >
            <span className="font-mono">{s.n}</span>
            {s.label}
          </li>
        ))}
      </ol>

      {error && (
        <div className="mb-6 rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {busy && (
        <div className="mb-6 rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {busy}
        </div>
      )}

      <div className="grid gap-8 md:grid-cols-2">
        {/* LEFT: original / working column */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
            Original
          </h2>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) onPick(f);
            }}
            onClick={() => inputRef.current?.click()}
            className="flex min-h-[280px] cursor-pointer items-center justify-center rounded-xl border border-dashed border-neutral-700 bg-neutral-900/50 p-4 hover:border-neutral-500"
          >
            {originalUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={originalUrl}
                alt="original ad"
                className="max-h-[60vh] rounded-lg"
              />
            ) : (
              <span className="text-neutral-500">
                Drag an AI ad here, or click to choose a file
              </span>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
            }}
          />
          {file && step === 1 && (
            <button
              onClick={analyze}
              disabled={!!busy}
              className="mt-4 w-full rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Analyze ad
            </button>
          )}
        </section>

        {/* RIGHT: review / result column */}
        <section>
          {step >= 2 && spec && (
            <>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Extracted info
              </h2>

              <div className="mb-4 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
                <div className="mb-2 text-xs uppercase text-neutral-500">
                  Text (kept exact)
                </div>
                <ul className="space-y-1 text-sm">
                  {spec.textElements.map((t, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="rounded bg-neutral-800 px-1.5 text-xs text-neutral-400">
                        {t.role}
                      </span>
                      <span>{t.text}</span>
                    </li>
                  ))}
                </ul>
                {spec.assets.length > 0 && (
                  <>
                    <div className="mb-2 mt-4 text-xs uppercase text-neutral-500">
                      Logos / graphics (lifted pixel-exact)
                    </div>
                    <ul className="flex flex-wrap gap-2 text-xs">
                      {spec.assets.map((a, i) => (
                        <li
                          key={i}
                          className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-300"
                        >
                          {a.kind}
                          {a.label ? ` · ${a.label}` : ""}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <div className="mb-4 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
                <div className="mb-1 text-xs uppercase text-neutral-500">
                  Detected theme — {spec.theme.category}
                </div>
                <div className="mb-3 flex flex-wrap gap-2">
                  {keywords.map((k, i) => (
                    <span
                      key={i}
                      className="group flex items-center gap-1 rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs text-emerald-200"
                    >
                      {k}
                      <button
                        onClick={() =>
                          setKeywords(keywords.filter((_, j) => j !== i))
                        }
                        className="text-emerald-400 hover:text-white"
                        aria-label={`remove ${k}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    placeholder="+ keyword"
                    className="w-24 bg-transparent text-xs outline-none placeholder:text-neutral-600"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (v) setKeywords([...keywords, v]);
                        (e.target as HTMLInputElement).value = "";
                      }
                    }}
                  />
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-950 p-2 text-sm outline-none focus:border-emerald-700"
                />
              </div>

              {step === 2 && (
                <button
                  onClick={generate}
                  disabled={!!busy}
                  className="w-full rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Generate background
                </button>
              )}
            </>
          )}

          {step >= 3 && background && (
            <div className="mt-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Photoreal background{provider ? ` · ${provider}` : ""}
              </h2>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={background}
                alt="generated background"
                className="rounded-lg"
                style={{ aspectRatio }}
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={generate}
                  disabled={!!busy}
                  className="flex-1 rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500 disabled:opacity-50"
                >
                  Regenerate
                </button>
                {step === 3 && (
                  <button
                    onClick={compose}
                    disabled={!!busy}
                    className="flex-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Rebuild ad
                  </button>
                )}
              </div>
            </div>
          )}

          {step >= 4 && result && (
            <div className="mt-6">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-emerald-400">
                Rebuilt ad
              </h2>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result} alt="rebuilt ad" className="rounded-lg" />
              <a
                href={result}
                download="rebuilt-ad.png"
                className="mt-3 block rounded-lg bg-emerald-600 px-4 py-2 text-center font-medium text-white hover:bg-emerald-500"
              >
                Download PNG
              </a>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
