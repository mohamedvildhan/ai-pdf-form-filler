"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AcroFieldSpec,
  AnalyzeResult,
  FillFontFamily,
  FillLanguage,
  FillStyle,
  NeededInfo,
  OverlayPlacement,
} from "@/lib/types";
import {
  formatCombedDateDisplay,
  isLatinLockField,
  looksLikeDateBox,
} from "@/lib/dates";
import { containsThaana } from "@/lib/language";
import { DEFAULT_FILL_STYLE, isThaanaFont } from "@/lib/types";
import {
  FILL_STAGE_AT_MS,
  FILL_STAGES,
  FillProgress,
} from "@/components/fill-progress";

type Status =
  | "idle"
  | "analyzing"
  | "ready"
  | "previewing"
  | "filling"
  | "rewriting"
  | "error";

const LATIN_FONT_OPTIONS: { value: FillFontFamily; label: string }[] = [
  { value: "helvetica", label: "Helvetica" },
  { value: "helvetica-bold", label: "Helvetica Bold" },
  { value: "times", label: "Times Roman" },
  { value: "times-bold", label: "Times Bold" },
  { value: "courier", label: "Courier" },
  { value: "courier-bold", label: "Courier Bold" },
];

const THAANA_FONT_OPTIONS: { value: FillFontFamily; label: string }[] = [
  { value: "bolhu", label: "Bolhu" },
  { value: "faruma", label: "Faruma" },
  { value: "waheed", label: "Waheed" },
];

const FONT_SIZES = [
  { value: 0, label: "Auto (fit to box)" },
  { value: 8, label: "8 pt" },
  { value: 9, label: "9 pt" },
  { value: 10, label: "10 pt" },
  { value: 11, label: "11 pt" },
  { value: 12, label: "12 pt" },
  { value: 14, label: "14 pt" },
  { value: 16, label: "16 pt" },
  { value: 18, label: "18 pt" },
];

const LANGUAGE_OPTIONS: { value: FillLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "dv", label: "Dhivehi (ދިވެހި)" },
];

function fileKey(f: File): string {
  return `${f.name}::${f.size}::${f.lastModified}`;
}

function computeNeededClient(
  fields: AcroFieldSpec[],
  placements: OverlayPlacement[],
): NeededInfo[] {
  const needed: NeededInfo[] = [];
  for (const f of fields) {
    if (f.type === "button" || f.type === "unknown" || f.type === "checkbox") {
      continue;
    }
    if (!(f.value ?? "").trim()) {
      needed.push({
        field: f.name,
        label: f.label || f.name,
        reason: "No value found in the information you provided.",
      });
    }
  }
  for (const p of placements) {
    if (!(p.value ?? "").trim()) {
      needed.push({
        field: p.id,
        label: p.label || "Untitled field",
        reason: "No value found in the information you provided.",
      });
    }
  }
  return needed;
}

function thaanaCssFont(family: FillFontFamily): string | undefined {
  switch (family) {
    case "bolhu":
      return "Bolhu, sans-serif";
    case "faruma":
      return "Faruma, sans-serif";
    case "waheed":
      return "Waheed, sans-serif";
    default:
      return undefined;
  }
}

export function PdfFiller() {
  const [formFile, setFormFile] = useState<File | null>(null);
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [sourceText, setSourceText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [fillStyle, setFillStyle] = useState<FillStyle>(DEFAULT_FILL_STYLE);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [fields, setFields] = useState<AcroFieldSpec[]>([]);
  const [placements, setPlacements] = useState<OverlayPlacement[]>([]);
  const [filledPreviews, setFilledPreviews] = useState<string[]>([]);
  const [neededInfo, setNeededInfo] = useState<NeededInfo[]>([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [focusField, setFocusField] = useState<string | null>(null);
  const [progressStage, setProgressStage] = useState("");
  const [progressStageIndex, setProgressStageIndex] = useState(0);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const formInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<Record<string, HTMLElement | null>>({});
  const skipAutoPreviewRef = useRef(false);
  const previewGenRef = useRef(0);
  /** After first fill, adding sources triggers enrich (not a full re-analyze). */
  const watchSourcesRef = useRef(false);
  const sourceCountRef = useRef(0);

  const addSourceFiles = useCallback((incoming: File[]) => {
    setSourceFiles((prev) => {
      const seen = new Set(prev.map(fileKey));
      const next = [...prev];
      for (const f of incoming) {
        const key = fileKey(f);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(f);
      }
      return next;
    });
  }, []);

  const removeSourceFile = useCallback((index: number) => {
    setSourceFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  useEffect(() => {
    if (status !== "analyzing" && status !== "filling" && status !== "previewing") {
      setElapsedSec(0);
      setProgressStage("");
      setProgressStageIndex(0);
      return;
    }
    setElapsedSec(0);
    const id = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  useEffect(() => {
    if (status !== "analyzing") return;
    setProgressStageIndex(0);
    setProgressStage(FILL_STAGES[0].detail);
    const timers = FILL_STAGE_AT_MS.slice(1).map((at, i) =>
      window.setTimeout(() => {
        const next = i + 1;
        setProgressStageIndex(next);
        setProgressStage(FILL_STAGES[next].detail);
      }, at),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [status]);

  /** Scroll the corrections panel to a field — only from the PDF (not when typing in the list). */
  const revealFieldInPanel = useCallback((name: string) => {
    setFocusField(name);
    const tryFocus = (attempt: number) => {
      const el = fieldRefs.current[name];
      if (!el) {
        if (attempt < 8) {
          window.setTimeout(() => tryFocus(attempt + 1), 40);
        }
        return;
      }
      const input = el.querySelector("input, select, textarea") as
        | HTMLInputElement
        | HTMLSelectElement
        | null;
      // Only nudge scroll if the card is outside the panel viewport — never
      // re-center on every click (that was jumping fields down while typing).
      const scroller = el.closest(".overflow-y-auto");
      if (scroller instanceof HTMLElement) {
        const sRect = scroller.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const outOfView =
          eRect.top < sRect.top + 8 || eRect.bottom > sRect.bottom - 8;
        if (outOfView) {
          el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
      if (input && document.activeElement !== input) {
        input.focus({ preventScroll: true });
      }
    };
    requestAnimationFrame(() => tryFocus(0));
  }, []);

  const payloadForMode = useCallback(() => {
    if (!result) return null;
    switch (result.mode) {
      case "acroform":
        return { mode: "acroform" as const, flatten: true, fields, style: fillStyle };
      case "created-acroform":
        return {
          mode: "created-acroform" as const,
          flatten: true,
          fields,
          style: fillStyle,
        };
      case "overlay":
        return { mode: "overlay" as const, placements, style: fillStyle };
      default: {
        const _exhaustive: never = result.mode;
        throw new Error(`Unknown mode: ${String(_exhaustive)}`);
      }
    }
  }, [result, fields, placements, fillStyle]);

  const liveOverlay =
    result?.liveOverlay === true ||
    result?.mode === "created-acroform" ||
    result?.mode === "overlay";

  const fillForm = useCallback(async () => {
    watchSourcesRef.current = false;
    sourceCountRef.current = sourceFiles.length;
    if (!formFile) return;
    setStatus("analyzing");
    setError(null);
    setResult(null);
    setFilledPreviews([]);
    setNeededInfo([]);
    setPageIndex(0);
    setIsPreviewing(false);
    const controller = new AbortController();
    // Vision + date digit refine ~120s; allow headroom for slower networks.
    const abortTimer = window.setTimeout(() => controller.abort(), 180_000);
    try {
      const body = new FormData();
      body.append("form", formFile);
      for (const f of sourceFiles) body.append("sources", f);
      if (sourceText.trim()) body.append("sourceText", sourceText);
      if (instructions.trim()) body.append("instructions", instructions);
      body.append("style", JSON.stringify(fillStyle));

      const res = await fetch("/api/analyze", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const data = (await res.json()) as AnalyzeResult & { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not fill the form.");

      // Live-overlay / analyze already has page images — skip server preview refresh.
      skipAutoPreviewRef.current = true;
      setResult(data);
      setFields(data.fields ?? []);
      setPlacements(data.placements ?? []);
      setFilledPreviews(
        data.filledPreviews?.length
          ? data.filledPreviews
          : data.pagePreviews ?? [],
      );
      setNeededInfo(data.neededInfo ?? []);
      setStatus("ready");
      sourceCountRef.current = sourceFiles.length;
      watchSourcesRef.current = true;
    } catch (e) {
      const aborted =
        (e instanceof DOMException && e.name === "AbortError") ||
        (e instanceof Error && e.name === "AbortError");
      setError(
        aborted
          ? "Filling timed out after 2.5 minutes. Try again with fewer or smaller source files."
          : e instanceof Error
            ? e.message
            : "Could not fill the form.",
      );
      setStatus("error");
    } finally {
      window.clearTimeout(abortTimer);
    }
  }, [formFile, sourceFiles, sourceText, instructions, fillStyle]);

  /** Merge new sources into existing boxes (no geometry re-detect). */
  const enrichFromSources = useCallback(async () => {
    if (!formFile || !result) return;
    if (sourceFiles.length === 0 && !sourceText.trim()) return;
    const useLive =
      result.liveOverlay === true ||
      result.mode === "created-acroform" ||
      result.mode === "overlay";
    setStatus("analyzing");
    setProgressStage("Updating form from new sources…");
    setError(null);
    try {
      const body = new FormData();
      body.append("form", formFile);
      for (const f of sourceFiles) body.append("sources", f);
      if (sourceText.trim()) body.append("sourceText", sourceText);
      body.append(
        "payload",
        JSON.stringify({
          mode: result.mode,
          fields,
          placements,
          style: fillStyle,
          instructions,
        }),
      );
      const res = await fetch("/api/enrich", { method: "POST", body });
      const data = (await res.json()) as {
        fields?: AcroFieldSpec[];
        placements?: OverlayPlacement[];
        filledPreviews?: string[];
        neededInfo?: NeededInfo[];
        facts?: AnalyzeResult["facts"];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Could not update from sources.");

      skipAutoPreviewRef.current = true;
      if (data.fields) setFields(data.fields);
      if (data.placements) setPlacements(data.placements);
      setNeededInfo(data.neededInfo ?? []);
      if (!useLive && data.filledPreviews?.length) {
        setFilledPreviews(data.filledPreviews);
      }
      if (data.facts?.length) {
        setResult((prev) =>
          prev
            ? {
                ...prev,
                facts: [...prev.facts, ...data.facts!].filter(
                  (f, i, arr) =>
                    arr.findIndex((x) => x.key === f.key && x.value === f.value) ===
                    i,
                ),
              }
            : prev,
        );
      }
      sourceCountRef.current = sourceFiles.length;
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update from sources.");
      setStatus("error");
    }
  }, [
    formFile,
    result,
    sourceFiles,
    sourceText,
    fields,
    placements,
    fillStyle,
    instructions,
  ]);

  /** Rewrite all filled values EN ↔ DV when Fill language changes in Review. */
  const rewriteLanguage = useCallback(
    async (nextStyle: FillStyle) => {
      if (!result || (fields.length === 0 && placements.length === 0)) return;
      setStatus("rewriting");
      setProgressStage(
        nextStyle.language === "dv"
          ? "Translating values to Dhivehi…"
          : "Translating values to English…",
      );
      setError(null);
      try {
        const body = new FormData();
        if (formFile) body.append("form", formFile);
        const spellingContext = [
          ...fields
            .filter((f) => containsThaana(f.value))
            .map((f) => ({ label: f.label, value: f.value })),
          ...placements
            .filter((p) => containsThaana(p.value))
            .map((p) => ({ label: p.label, value: p.value })),
          ...(result.facts ?? [])
            .filter((f) => containsThaana(f.value))
            .map((f) => ({ label: f.key, value: f.value })),
        ];
        body.append(
          "payload",
          JSON.stringify({
            fields,
            placements,
            style: nextStyle,
            spellingContext,
          }),
        );
        const res = await fetch("/api/rewrite-language", {
          method: "POST",
          body,
        });
        const data = (await res.json()) as {
          fields?: AcroFieldSpec[];
          placements?: OverlayPlacement[];
          neededInfo?: NeededInfo[];
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || "Could not rewrite language.");
        skipAutoPreviewRef.current = true;
        if (data.fields) setFields(data.fields);
        if (data.placements) setPlacements(data.placements);
        if (data.neededInfo) setNeededInfo(data.neededInfo);
        setStatus("ready");
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Could not rewrite fill language.",
        );
        setStatus("error");
      }
    },
    [result, fields, placements, formFile],
  );

  /**
   * After the user edits a free-text value, translate into the selected fill
   * language when the typed script doesn't match (EN ↔ DV).
   */
  const translateFieldValue = useCallback(
    async (
      kind: "field" | "placement",
      id: string,
      value: string,
    ): Promise<string | null> => {
      const lang = fillStyle.language ?? "en";
      const trimmed = value.trim();
      if (!trimmed) return null;

      const hasThaana = containsThaana(trimmed);
      // Already matches target language script for free-text
      if (lang === "dv" && hasThaana) return null;
      if (lang === "en" && !hasThaana) return null;

      if (/^[\d+\s().\-/]+$/.test(trimmed)) return null;
      if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(trimmed)) return null;

      const label =
        kind === "field"
          ? (fields.find((f) => f.name === id)?.label ?? id)
          : (placements.find((p) => p.id === id)?.label ?? id);
      if (isLatinLockField(label, id, trimmed)) return null;

      const oneField: AcroFieldSpec[] =
        kind === "field"
          ? fields
              .filter((f) => f.name === id)
              .map((f) => ({ ...f, value: trimmed }))
          : [];
      const onePlacement: OverlayPlacement[] =
        kind === "placement"
          ? placements
              .filter((p) => p.id === id)
              .map((p) => ({ ...p, value: trimmed }))
          : [];
      if (oneField.length === 0 && onePlacement.length === 0) return null;

      // Prefer existing Thaana spellings already on the form / in facts (same entity → same letters).
      const spellingContext = [
        ...fields
          .filter((f) => f.name !== id && containsThaana(f.value))
          .map((f) => ({ label: f.label, value: f.value })),
        ...placements
          .filter((p) => p.id !== id && containsThaana(p.value))
          .map((p) => ({ label: p.label, value: p.value })),
        ...(result?.facts ?? [])
          .filter((f) => containsThaana(f.value))
          .map((f) => ({ label: f.key, value: f.value })),
      ];

      const body = new FormData();
      if (formFile) body.append("form", formFile);
      body.append(
        "payload",
        JSON.stringify({
          fields: oneField,
          placements: onePlacement,
          style: fillStyle,
          forceProse: true,
          spellingContext,
        }),
      );
      const res = await fetch("/api/rewrite-language", {
        method: "POST",
        body,
      });
      const data = (await res.json()) as {
        fields?: AcroFieldSpec[];
        placements?: OverlayPlacement[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Translation failed.");
      }
      if (kind === "field") {
        const hit = data.fields?.find((f) => f.name === id);
        if (hit?.value != null) return String(hit.value);
      }
      if (kind === "placement") {
        const hit = data.placements?.find((p) => p.id === id);
        if (hit?.value != null) return String(hit.value);
      }
      return null;
    },
    [fillStyle, fields, placements, formFile, result?.facts],
  );

  const applyTranslatedValue = useCallback(
    async (kind: "field" | "placement", id: string, value: string) => {
      const lang = fillStyle.language ?? "en";
      const trimmed = value.trim();
      if (!trimmed) return;
      const hasThaana = containsThaana(trimmed);
      if (lang === "dv" && hasThaana) return;
      if (lang === "en" && !hasThaana) return;

      const label =
        kind === "field"
          ? (fields.find((f) => f.name === id)?.label ?? id)
          : (placements.find((p) => p.id === id)?.label ?? id);
      if (isLatinLockField(label, id, trimmed)) return;

      setProgressStage(
        lang === "dv" ? "Translating to Dhivehi…" : "Translating to English…",
      );
      setStatus("rewriting");
      try {
        const translated = await translateFieldValue(kind, id, value);
        if (translated != null && translated !== value) {
          if (kind === "field") {
            setFields((prev) =>
              prev.map((f) =>
                f.name === id ? { ...f, value: translated } : f,
              ),
            );
          } else {
            setPlacements((prev) =>
              prev.map((p) =>
                p.id === id ? { ...p, value: translated } : p,
              ),
            );
          }
        }
        setStatus("ready");
        setProgressStage("");
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Could not translate this field.",
        );
        setStatus("error");
        setProgressStage("");
      }
    },
    [translateFieldValue, fillStyle.language, fields, placements],
  );

  const refreshPreview = useCallback(async () => {
    if (!formFile || !result) return;
    const gen = ++previewGenRef.current;
    setIsPreviewing(true);
    setError(null);
    try {
      const payload = payloadForMode();
      if (!payload) return;
      const body = new FormData();
      body.append("form", formFile);
      body.append("payload", JSON.stringify(payload));
      const res = await fetch("/api/preview", { method: "POST", body });
      const data = (await res.json()) as {
        filledPreviews?: string[];
        neededInfo?: NeededInfo[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || "Preview failed.");
      // Ignore stale responses when the user kept editing.
      if (gen !== previewGenRef.current) return;
      setFilledPreviews(data.filledPreviews ?? []);
      setNeededInfo(data.neededInfo ?? []);
    } catch (e) {
      if (gen !== previewGenRef.current) return;
      setError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      if (gen === previewGenRef.current) setIsPreviewing(false);
    }
  }, [formFile, result, payloadForMode]);

  // Live-overlay modes draw values in the browser — no slow PDF re-render.
  // AcroForm still refreshes a server preview when values/style change.
  useEffect(() => {
    if (!result || !formFile) return;
    if (liveOverlay) {
      if (skipAutoPreviewRef.current) skipAutoPreviewRef.current = false;
      setNeededInfo(computeNeededClient(fields, placements));
      return;
    }
    if (skipAutoPreviewRef.current) {
      skipAutoPreviewRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void refreshPreview();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [fields, placements, fillStyle, result, formFile, refreshPreview, liveOverlay]);

  // Auto-enrich when the user adds more source files on the review screen.
  useEffect(() => {
    if (!watchSourcesRef.current || !result) return;
    if (
      status === "analyzing" ||
      status === "filling" ||
      status === "rewriting"
    ) {
      return;
    }
    if (sourceFiles.length <= sourceCountRef.current) return;
    const timer = window.setTimeout(() => {
      void enrichFromSources();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [sourceFiles, result, status, enrichFromSources]);

  const download = useCallback(async () => {
    if (!formFile || !result) return;
    setStatus("filling");
    setError(null);
    try {
      const payload = payloadForMode();
      const body = new FormData();
      body.append("form", formFile);
      body.append("payload", JSON.stringify(payload));

      const res = await fetch("/api/fill", { method: "POST", body });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to generate PDF.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = formFile.name.replace(/\.pdf$/i, "") + "-filled.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate PDF.");
      setStatus("error");
    }
  }, [formFile, result, payloadForMode]);

  const busy =
    status === "analyzing" ||
    status === "filling" ||
    status === "rewriting";

  const onFillStyleChange = useCallback(
    (next: FillStyle) => {
      const langChanged = (next.language ?? "en") !== (fillStyle.language ?? "en");
      setFillStyle(next);
      if (result && langChanged && (fields.length > 0 || placements.length > 0)) {
        void rewriteLanguage(next);
      }
    },
    [fillStyle.language, result, fields.length, placements.length, rewriteLanguage],
  );

  const filledCount = useMemo(() => {
    if (result?.mode === "overlay") {
      return placements.filter((p) => p.value.trim()).length;
    }
    return fields.filter(
      (f) =>
        f.type !== "button" &&
        f.type !== "unknown" &&
        (f.type === "checkbox"
          ? f.value.toLowerCase() === "true"
          : !!f.value.trim()),
    ).length;
  }, [result, fields, placements]);

  return (
    <div className="space-y-7">
      {!result && (
        <>
          <section className="grid gap-4 sm:grid-cols-2">
            <FilePicker
              label="Form PDF"
              hint="The blank form you want filled"
              accept="application/pdf,.pdf"
              inputRef={formInputRef}
              onChange={(files) => setFormFile(files[0] ?? null)}
              files={formFile ? [formFile] : []}
              onClear={() => {
                setFormFile(null);
                if (formInputRef.current) formInputRef.current.value = "";
              }}
            />
            <MultiSourcePicker
              files={sourceFiles}
              inputRef={sourceInputRef}
              onAdd={addSourceFiles}
              onRemove={removeSourceFile}
              onClear={() => {
                setSourceFiles([]);
                if (sourceInputRef.current) sourceInputRef.current.value = "";
              }}
            />
          </section>

          <FontStyleControls
            style={fillStyle}
            onChange={setFillStyle}
            hint="English ↔ Dhivehi: free-text is translated to the selected fill language. Passport numbers and dates stay Latin/digits. Sources can be either language."
          />

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col">
              <label className="text-sm font-medium text-paper" htmlFor="source-text">
                Or type / paste details
              </label>
              <textarea
                id="source-text"
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                rows={4}
                placeholder={"Name: …\nDate of birth: …\nEmail: …"}
                className="field-input mt-2 resize-y"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-sm font-medium text-paper" htmlFor="instructions">
                Extra instructions (optional)
              </label>
              <textarea
                id="instructions"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="e.g. Put names in CAPITALS. Leave phone blank."
                className="field-input mt-2 resize-y"
              />
            </div>
          </section>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={fillForm}
                disabled={!formFile || busy}
                className="btn-primary"
              >
                {status === "analyzing" ? "Filling with AI…" : "Fill form with AI"}
              </button>
              {status === "analyzing" && (
                <span className="inline-flex items-center gap-2 text-xs text-accent-strong/80">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                  </span>
                  Working
                </span>
              )}
            </div>
            {status === "analyzing" && (
              <FillProgress
                stageIndex={progressStageIndex}
                elapsedSec={elapsedSec}
              />
            )}
          </div>
        </>
      )}

      {error && (
        <div
          className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {/* Sticky action bar */}
          <div className="sticky top-0 z-20 -mx-4 border-b border-line bg-ink/95 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold tracking-tight text-paper">
                  Review & edit
                </p>
                <p className="mt-0.5 text-[11px] text-mute">
                  Check overlays, fix anything left, then download.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-ok/15 px-2.5 py-0.5 font-medium text-ok ring-1 ring-ok/35">
                    {filledCount} filled
                  </span>
                  {neededInfo.length > 0 ? (
                    <span className="rounded-full bg-warn/15 px-2.5 py-0.5 font-medium text-warn ring-1 ring-warn/35">
                      {neededInfo.length} still needed
                    </span>
                  ) : (
                    <span className="rounded-full bg-panel px-2.5 py-0.5 text-paper/80 ring-1 ring-line">
                      Ready to download
                    </span>
                  )}
                  {busy && (
                    <span className="text-mute">{progressStage || "Working…"}</span>
                  )}
                  {isPreviewing && (
                    <span className="text-mute">Updating preview…</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setError(null);
                    setStatus("idle");
                    watchSourcesRef.current = false;
                  }}
                  className="btn-secondary"
                >
                  Start over
                </button>
                <button
                  type="button"
                  onClick={download}
                  disabled={busy}
                  className="btn-ok disabled:opacity-40"
                >
                  {status === "filling"
                    ? "Preparing…"
                    : status === "rewriting"
                      ? "Translating…"
                      : "Download PDF"}
                </button>
              </div>
            </div>
          </div>

          {/* Main edit workspace */}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
            <div className="space-y-3">
              <FilledViewer
                mode={result.mode}
                pages={filledPreviews}
                pageIndex={pageIndex}
                onPageChange={setPageIndex}
                fields={fields}
                placements={placements}
                focusField={focusField}
                onFieldSelect={setFocusField}
                onFieldEdit={revealFieldInPanel}
                onFieldsChange={setFields}
                onPlacementsChange={setPlacements}
                onValueCommit={applyTranslatedValue}
                isPreviewing={isPreviewing}
                liveOverlay={liveOverlay}
                fillStyle={fillStyle}
              />
              <details
                className="rounded-xl border border-line bg-surface/50"
                open
              >
                <summary className="cursor-pointer px-4 py-3 text-sm text-paper/80 hover:text-paper">
                  Language & font
                </summary>
                <div className="border-t border-line px-2 pb-3">
                  <FontStyleControls
                    style={fillStyle}
                    onChange={onFillStyleChange}
                    showLanguageNote
                    languageBusy={status === "rewriting"}
                  />
                </div>
              </details>
            </div>

            <div className="flex min-h-0 flex-col gap-3 xl:sticky xl:top-[4.5rem] xl:max-h-[calc(100vh-5.5rem)]">
              <CorrectionsPanel
                mode={result.mode}
                fields={fields}
                placements={placements}
                onFieldsChange={setFields}
                onPlacementsChange={setPlacements}
                onValueCommit={applyTranslatedValue}
                instructions={instructions}
                onInstructionsChange={setInstructions}
                onRerunAi={fillForm}
                busy={busy}
                focusField={focusField}
                onFocusField={setFocusField}
                fieldRefs={fieldRefs}
                neededCount={neededInfo.length}
              />

              <details className="rounded-xl border border-line bg-surface/70 open:shadow-lg">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-paper/90 marker:content-none [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center justify-between gap-2">
                    <span>Add more sources</span>
                    <span className="text-xs font-normal text-amber-400/90">
                      {neededInfo.length > 0
                        ? `${neededInfo.length} empty — add docs or paste`
                        : `${sourceFiles.length} file${sourceFiles.length === 1 ? "" : "s"}`}
                    </span>
                  </span>
                </summary>
                <div className="space-y-3 border-t border-line p-4 pt-3">
                  <p className="text-xs text-mute">
                    Add another document or paste notes. Empty fields update; filled
                    ones stay as you left them.
                  </p>
                  <MultiSourcePicker
                    files={sourceFiles}
                    inputRef={sourceInputRef}
                    onAdd={addSourceFiles}
                    onRemove={removeSourceFile}
                    onClear={() => {
                      setSourceFiles([]);
                      sourceCountRef.current = 0;
                      if (sourceInputRef.current) sourceInputRef.current.value = "";
                    }}
                    compact
                  />
                  <textarea
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                    rows={3}
                    placeholder={"Port of Entry: Male\nEmail: name@example.com"}
                    className="w-full resize-y rounded-lg border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || !sourceText.trim()}
                      onClick={() => {
                        const nextFields = applyLabelValueLines(
                          fields,
                          sourceText,
                        );
                        const nextPlacements = applyLabelValueLinesToPlacements(
                          placements,
                          sourceText,
                        );
                        setFields(nextFields);
                        setPlacements(nextPlacements);
                        setNeededInfo(
                          computeNeededClient(nextFields, nextPlacements),
                        );
                      }}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs text-paper/90 hover:bg-panel disabled:opacity-40"
                    >
                      Fill from text
                    </button>
                    <button
                      type="button"
                      disabled={
                        busy || (sourceFiles.length === 0 && !sourceText.trim())
                      }
                      onClick={() => void enrichFromSources()}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-strong disabled:opacity-40"
                    >
                      {busy ? "Updating…" : "Update with AI"}
                    </button>
                  </div>
                </div>
              </details>

              {result.facts.length > 0 && (
                <details className="rounded-xl border border-line bg-surface/50">
                  <summary className="cursor-pointer px-4 py-3 text-sm text-mute hover:text-paper/90">
                    Facts AI read ({result.facts.length})
                  </summary>
                  <dl className="max-h-48 space-y-1 overflow-y-auto border-t border-line px-4 py-3 text-xs">
                    {result.facts.map((f, i) => (
                      <div key={i} className="flex gap-2">
                        <dt className="shrink-0 text-mute">{f.key}:</dt>
                        <dd className="min-w-0 break-words text-paper/80">
                          {f.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function parseLabelValueLines(text: string): Map<string, string> {
  const updates = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
    if (!m) continue;
    const label = m[1].toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const value = m[2].trim();
    if (!label || !value) continue;
    updates.set(label, value);
  }
  return updates;
}

function matchLabelValue(
  key: string,
  updates: Map<string, string>,
): string | undefined {
  let matched = updates.get(key);
  if (matched) return matched;
  for (const [k, v] of updates) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return undefined;
}

/** Apply lines like "Port of Entry: Male" into matching field boxes (no AI). */
function applyLabelValueLines(
  fields: AcroFieldSpec[],
  text: string,
): AcroFieldSpec[] {
  const updates = parseLabelValueLines(text);
  if (updates.size === 0) return fields;

  return fields.map((f) => {
    const key = (f.label || f.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const matched = matchLabelValue(key, updates);
    if (matched === undefined) return f;
    if (f.type === "checkbox") {
      const on = /^(true|yes|y|1|checked)$/i.test(matched);
      return { ...f, value: on ? "true" : "false" };
    }
    return { ...f, value: matched };
  });
}

function applyLabelValueLinesToPlacements(
  placements: OverlayPlacement[],
  text: string,
): OverlayPlacement[] {
  const updates = parseLabelValueLines(text);
  if (updates.size === 0) return placements;

  return placements.map((p) => {
    const key = (p.label || p.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const matched = matchLabelValue(key, updates);
    if (matched === undefined) return p;
    return { ...p, value: matched };
  });
}


type HitBox = {
  id: string;
  label: string;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  kind: "field" | "placement";
  isCheckbox: boolean;
  value: string;
  geomKind?: "text" | "checkbox" | "comb";
  combCells?: AcroFieldSpec["combCells"];
};

function FilledViewer({
  mode,
  pages,
  pageIndex,
  onPageChange,
  fields,
  placements,
  focusField,
  onFieldSelect,
  onFieldEdit,
  onFieldsChange,
  onPlacementsChange,
  onValueCommit,
  isPreviewing,
  liveOverlay,
  fillStyle,
}: {
  mode: AnalyzeResult["mode"];
  pages: string[];
  pageIndex: number;
  onPageChange: (i: number) => void;
  fields: AcroFieldSpec[];
  placements: OverlayPlacement[];
  focusField: string | null;
  /** Highlight only — does not scroll the corrections panel. */
  onFieldSelect: (name: string) => void;
  /** Open the field for editing in the corrections panel. */
  onFieldEdit: (name: string) => void;
  onFieldsChange: (f: AcroFieldSpec[]) => void;
  onPlacementsChange: (p: OverlayPlacement[]) => void;
  /** After inline edit, translate EN ↔ DV to match fill language. */
  onValueCommit?: (
    kind: "field" | "placement",
    id: string,
    value: string,
  ) => void;
  isPreviewing?: boolean;
  liveOverlay?: boolean;
  fillStyle: FillStyle;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    kind: "field" | "placement";
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    dx: number;
    dy: number;
    moved: boolean;
  } | null>(null);
  const drawRef = useRef<{
    startX: number;
    startY: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [dragOffset, setDragOffset] = useState<{
    id: string;
    dx: number;
    dy: number;
  } | null>(null);
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineDraft, setInlineDraft] = useState("");
  const [addBoxMode, setAddBoxMode] = useState(false);
  const [drawPreview, setDrawPreview] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const hitBoxes = useMemo((): HitBox[] => {
    const safeIndex = Math.min(pageIndex, Math.max(pages.length - 1, 0));
    if (mode === "overlay") {
      return placements
        .filter((p) => p.page === safeIndex)
        .map((p) => ({
          id: p.id,
          label: p.label || p.id,
          xNorm: p.xNorm,
          yNorm: p.yNorm,
          wNorm: p.wNorm,
          hNorm: p.hNorm,
          kind: "placement" as const,
          isCheckbox: false,
          value: p.value,
        }));
    }
    return fields
      .filter(
        (f) =>
          f.page === safeIndex &&
          f.xNorm !== undefined &&
          f.yNorm !== undefined &&
          f.wNorm !== undefined &&
          f.hNorm !== undefined,
      )
      .map((f) => ({
        id: f.name,
        label: f.label || f.name,
        xNorm: f.xNorm!,
        yNorm: f.yNorm!,
        wNorm: f.wNorm!,
        hNorm: f.hNorm!,
        kind: "field" as const,
        isCheckbox: f.type === "checkbox",
        value: f.value,
        geomKind: f.geomKind,
        combCells: f.combCells,
      }));
  }, [mode, pages.length, pageIndex, fields, placements]);

  const commitInline = useCallback(
    (id: string, kind: "field" | "placement", value: string) => {
      if (kind === "field") {
        onFieldsChange(
          fields.map((f) => (f.name === id ? { ...f, value } : f)),
        );
      } else {
        onPlacementsChange(
          placements.map((p) => (p.id === id ? { ...p, value } : p)),
        );
      }
      setInlineEditId(null);
      onValueCommit?.(kind, id, value);
    },
    [fields, placements, onFieldsChange, onPlacementsChange, onValueCommit],
  );

  const addManualBox = useCallback(
    (xNorm: number, yNorm: number, wNorm: number, hNorm: number) => {
      const safeIndex = Math.min(pageIndex, Math.max(pages.length - 1, 0));
      const id = `manual_${Date.now().toString(36)}`;
      const label = "Custom field";
      if (mode === "overlay") {
        const next: OverlayPlacement = {
          id,
          page: safeIndex,
          label,
          value: "",
          fieldType: "text",
          xNorm,
          yNorm,
          wNorm,
          hNorm,
        };
        onPlacementsChange([...placements, next]);
      } else {
        const next: AcroFieldSpec = {
          name: id,
          type: "text",
          label,
          value: "",
          page: safeIndex,
          xNorm,
          yNorm,
          wNorm,
          hNorm,
          geomKind: "text",
        };
        onFieldsChange([...fields, next]);
      }
      onFieldSelect(id);
      setAddBoxMode(false);
      setInlineEditId(id);
      setInlineDraft("");
    },
    [
      mode,
      pageIndex,
      pages.length,
      fields,
      placements,
      onFieldsChange,
      onPlacementsChange,
      onFieldSelect,
    ],
  );

  const toggleCheckbox = useCallback(
    (id: string) => {
      onFieldsChange(
        fields.map((f) =>
          f.name === id
            ? {
                ...f,
                value: f.value.toLowerCase() === "true" ? "false" : "true",
              }
            : f,
        ),
      );
    },
    [fields, onFieldsChange],
  );

  const applyPosition = useCallback(
    (id: string, kind: "field" | "placement", xNorm: number, yNorm: number) => {
      if (kind === "field") {
        onFieldsChange(
          fields.map((f) =>
            f.name === id
              ? {
                  ...f,
                  xNorm: clamp01(xNorm),
                  yNorm: clamp01(yNorm),
                }
              : f,
          ),
        );
      } else {
        onPlacementsChange(
          placements.map((p) =>
            p.id === id
              ? {
                  ...p,
                  xNorm: clamp01(xNorm),
                  yNorm: clamp01(yNorm),
                }
              : p,
          ),
        );
      }
    },
    [fields, placements, onFieldsChange, onPlacementsChange],
  );

  const nudgeFocused = useCallback(
    (dx: number, dy: number) => {
      if (!focusField) return;
      const box = hitBoxes.find((b) => b.id === focusField);
      if (!box) return;
      const nextX = clampBox(box.xNorm + dx, box.wNorm);
      const nextY = clampBox(box.yNorm + dy, box.hNorm);
      applyPosition(box.id, box.kind, nextX, nextY);
    },
    [focusField, hitBoxes, applyPosition],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!focusField) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const step = e.shiftKey ? 0.01 : 0.003;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          nudgeFocused(-step, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          nudgeFocused(step, 0);
          break;
        case "ArrowUp":
          e.preventDefault();
          nudgeFocused(0, -step);
          break;
        case "ArrowDown":
          e.preventDefault();
          nudgeFocused(0, step);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusField, nudgeFocused]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const draw = drawRef.current;
      if (draw) {
        const x1 = clamp01((e.clientX - rect.left) / rect.width);
        const y1 = clamp01((e.clientY - rect.top) / rect.height);
        draw.x1 = x1;
        draw.y1 = y1;
        const x = Math.min(draw.x0, x1);
        const y = Math.min(draw.y0, y1);
        const w = Math.abs(x1 - draw.x0);
        const h = Math.abs(y1 - draw.y0);
        setDrawPreview({ x, y, w, h });
        return;
      }

      const drag = dragRef.current;
      if (!drag) return;
      const dx = (e.clientX - drag.startX) / rect.width;
      const dy = (e.clientY - drag.startY) / rect.height;
      if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) drag.moved = true;
      drag.dx = dx;
      drag.dy = dy;
      setDragOffset({ id: drag.id, dx, dy });
    };

    const onUp = () => {
      const draw = drawRef.current;
      if (draw) {
        drawRef.current = null;
        setDrawPreview(null);
        const x = Math.min(draw.x0, draw.x1);
        const y = Math.min(draw.y0, draw.y1);
        const w = Math.abs(draw.x1 - draw.x0);
        const h = Math.abs(draw.y1 - draw.y0);
        // Ignore tiny accidental clicks
        if (w >= 0.02 && h >= 0.012) {
          addManualBox(x, y, w, h);
        }
        return;
      }

      const drag = dragRef.current;
      dragRef.current = null;
      setDragOffset(null);
      if (!drag) return;
      const box = hitBoxes.find((b) => b.id === drag.id);
      if (!drag.moved) {
        if (box?.isCheckbox && drag.kind === "field") {
          toggleCheckbox(drag.id);
          return;
        }
        // Tap → inline type on the box (Fill & Sign style)
        setInlineEditId(drag.id);
        setInlineDraft(box?.value ?? "");
        onFieldSelect(drag.id);
        return;
      }
      if (!box) return;
      applyPosition(
        drag.id,
        drag.kind,
        clampBox(drag.origX + drag.dx, box.wNorm),
        clampBox(drag.origY + drag.dy, box.hNorm),
      );
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [hitBoxes, applyPosition, onFieldSelect, toggleCheckbox, addManualBox]);

  if (pages.length === 0) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-xl border border-line bg-surface/70 text-sm text-mute">
        Preview will appear here after filling.
      </div>
    );
  }

  const safeIndex = Math.min(pageIndex, pages.length - 1);

  const emptyCount = hitBoxes.filter(
    (b) => !b.isCheckbox && !b.value.trim(),
  ).length;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-paper">Form preview</h2>
          <p className="text-[11px] text-mute">
            {addBoxMode
              ? "Drag on the page to draw a new fill box"
              : "Click a box to type · Drag to move · Empty boxes are amber"}
            {!addBoxMode && emptyCount > 0 ? ` (${emptyCount} on this page)` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setAddBoxMode((v) => !v);
              setDrawPreview(null);
              drawRef.current = null;
            }}
            className={`rounded-md border px-2.5 py-1 text-xs transition ${
              addBoxMode
                ? "border-accent bg-accent/15 text-accent-strong"
                : "border-line text-paper/80 hover:bg-panel"
            }`}
          >
            {addBoxMode ? "Cancel add" : "Add box"}
          </button>
          {isPreviewing && (
            <span className="text-xs text-accent-strong/90">Updating…</span>
          )}
          {pages.length > 1 && (
            <div className="flex items-center gap-1.5 text-xs text-mute">
              <button
                type="button"
                disabled={safeIndex <= 0}
                onClick={() => onPageChange(safeIndex - 1)}
                className="rounded-md border border-line px-2 py-1 disabled:opacity-30"
              >
                Prev
              </button>
              <span className="tabular-nums">
                {safeIndex + 1}/{pages.length}
              </span>
              <button
                type="button"
                disabled={safeIndex >= pages.length - 1}
                onClick={() => onPageChange(safeIndex + 1)}
                className="rounded-md border border-line px-2 py-1 disabled:opacity-30"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
      <div
        ref={stageRef}
        className={`relative overflow-hidden rounded-xl border border-line bg-ink shadow-lg ${
          addBoxMode
            ? "cursor-crosshair border-accent"
            : "border-line"
        }`}
        onPointerDown={(e) => {
          if (!addBoxMode) return;
          // Don't start a draw when interacting with an existing box button
          if ((e.target as HTMLElement).closest("button, input")) return;
          const stage = stageRef.current;
          if (!stage) return;
          const rect = stage.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          e.preventDefault();
          const x0 = clamp01((e.clientX - rect.left) / rect.width);
          const y0 = clamp01((e.clientY - rect.top) / rect.height);
          drawRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            x0,
            y0,
            x1: x0,
            y1: y0,
          };
          setDrawPreview({ x: x0, y: y0, w: 0, h: 0 });
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={pages[safeIndex]}
          alt={`Filled page ${safeIndex + 1}`}
          className="pointer-events-none block w-full select-none bg-ink [image-rendering:auto]"
          draggable={false}
        />
        {drawPreview && drawPreview.w > 0 && drawPreview.h > 0 && (
          <div
            className="pointer-events-none absolute z-20 border-2 border-dashed border-accent bg-accent/20"
            style={{
              left: `${drawPreview.x * 100}%`,
              top: `${drawPreview.y * 100}%`,
              width: `${drawPreview.w * 100}%`,
              height: `${drawPreview.h * 100}%`,
            }}
          />
        )}
        {hitBoxes.map((box) => {
          const offset =
            dragOffset?.id === box.id
              ? dragOffset
              : { dx: 0, dy: 0 };
          const left = clampBox(box.xNorm + offset.dx, box.wNorm);
          const top = clampBox(box.yNorm + offset.dy, box.hNorm);
          const focused = focusField === box.id || inlineEditId === box.id;
          const dragging = dragOffset?.id === box.id;
          const editing = inlineEditId === box.id && !box.isCheckbox;
          const empty = !box.isCheckbox && !box.value.trim();
          const showValue =
            liveOverlay &&
            !editing &&
            (box.isCheckbox
              ? box.value.toLowerCase() === "true"
              : !!box.value.trim());
          const isDate = looksLikeDateBox({
            label: box.label,
            name: box.id,
            geomKind: box.geomKind,
            wNorm: box.wNorm,
            hNorm: box.hNorm,
          });
          // Dates / IDs / passport lines must stay Latin LTR — Dhivehi RTL was
          // reversing DDMMYYYY (e.g. 28102034 → 43020182 on screen).
          const latinLock =
            isDate ||
            isLatinLockField(box.label, box.id, box.value) ||
            /^[\d\s+./:@_\-A-Za-z]+$/.test(box.value.trim());
          const useThaana =
            liveOverlay && fillStyle.language === "dv" && !latinLock;
          const overlayFont = useThaana
            ? thaanaCssFont(fillStyle.fontFamily) || "Faruma, sans-serif"
            : undefined;
          const dateDigits = isDate ? formatCombedDateDisplay(box.value) : "";
          return (
            <div
              key={`${box.kind}-${box.id}`}
              className={`absolute touch-none transition-colors ${
                addBoxMode && !editing
                  ? "pointer-events-none opacity-50"
                  : ""
              } ${
                focused || dragging
                  ? "z-10 border-2 border-accent bg-accent/25"
                  : empty
                    ? "border border-dashed border-warn/70 bg-warn/10 hover:bg-warn/20"
                    : "border border-accent/25 bg-transparent hover:border-accent/50 hover:bg-accent/10"
              }`}
              style={{
                left: `${left * 100}%`,
                top: `${top * 100}%`,
                width: `${box.wNorm * 100}%`,
                height: `${box.hNorm * 100}%`,
              }}
            >
              {editing ? (
                <input
                  autoFocus
                  value={inlineDraft}
                  onChange={(e) => setInlineDraft(e.target.value)}
                  onBlur={() => commitInline(box.id, box.kind, inlineDraft)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitInline(box.id, box.kind, inlineDraft);
                    } else if (e.key === "Escape") {
                      setInlineEditId(null);
                    }
                  }}
                  className="h-full w-full bg-white/95 px-1 text-xs text-ink outline-none"
                  style={overlayFont ? { fontFamily: overlayFont } : undefined}
                  dir={useThaana ? "rtl" : "ltr"}
                  title={box.label}
                />
              ) : (
                <>
                  {showValue &&
                    (isDate && dateDigits.length === 8 ? (
                      box.combCells && box.combCells.length >= 6 ? (
                        <span
                          className="pointer-events-none absolute inset-0"
                          dir="ltr"
                        >
                          {dateDigits.split("").map((ch, i) => {
                            const cell = box.combCells![i];
                            if (!cell || !ch) return null;
                            // Cell coords are page-absolute; convert relative to this field box.
                            const relL =
                              (cell.xNorm - box.xNorm) /
                              Math.max(box.wNorm, 0.0001);
                            const relT =
                              (cell.yNorm - box.yNorm) /
                              Math.max(box.hNorm, 0.0001);
                            const relW =
                              cell.wNorm / Math.max(box.wNorm, 0.0001);
                            const relH =
                              cell.hNorm / Math.max(box.hNorm, 0.0001);
                            return (
                              <span
                                key={i}
                                className="absolute flex items-center justify-center font-medium tabular-nums text-[clamp(7px,1.5vw,11px)] leading-none text-ink"
                                style={{
                                  left: `${relL * 100}%`,
                                  top: `${relT * 100}%`,
                                  width: `${relW * 100}%`,
                                  height: `${relH * 100}%`,
                                }}
                              >
                                {ch}
                              </span>
                            );
                          })}
                        </span>
                      ) : (
                      <span
                        className="pointer-events-none absolute inset-0 flex items-stretch px-0.5 text-[clamp(7px,1.5vw,11px)] leading-none text-ink"
                        dir="ltr"
                      >
                        {dateDigits.split("").map((ch, i) => (
                          <span
                            key={i}
                            className="flex flex-1 items-center justify-center font-medium tabular-nums"
                          >
                            {ch}
                          </span>
                        ))}
                      </span>
                      )
                    ) : (
                    <span
                      className={`pointer-events-none absolute inset-0 flex items-center overflow-hidden px-0.5 text-[clamp(7px,1.6vw,11px)] leading-tight text-ink ${
                        box.isCheckbox
                          ? "justify-center text-base font-bold"
                          : useThaana
                            ? "justify-end text-right"
                            : "justify-start"
                      }`}
                      style={overlayFont ? { fontFamily: overlayFont } : undefined}
                      dir={useThaana ? "rtl" : "ltr"}
                    >
                      {box.isCheckbox ? "✓" : box.value}
                    </span>
                    ))}
                  <button
                    type="button"
                    title={`${box.label} — click to type, drag to move`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      (e.currentTarget as HTMLButtonElement).setPointerCapture?.(
                        e.pointerId,
                      );
                      dragRef.current = {
                        id: box.id,
                        kind: box.kind,
                        startX: e.clientX,
                        startY: e.clientY,
                        origX: box.xNorm,
                        origY: box.yNorm,
                        dx: 0,
                        dy: 0,
                        moved: false,
                      };
                      onFieldSelect(box.id);
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      onFieldEdit(box.id);
                    }}
                    className="absolute inset-0 cursor-grab active:cursor-grabbing"
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Keep a box fully on-page given its size. */
function clampBox(origin: number, size: number): number {
  const max = Math.max(0, 1 - size);
  return Math.min(max, Math.max(0, origin));
}

function CorrectionsPanel({
  mode,
  fields,
  placements,
  onFieldsChange,
  onPlacementsChange,
  onValueCommit,
  instructions,
  onInstructionsChange,
  onRerunAi,
  busy,
  focusField,
  onFocusField,
  fieldRefs,
  neededCount,
}: {
  mode: AnalyzeResult["mode"];
  fields: AcroFieldSpec[];
  placements: OverlayPlacement[];
  onFieldsChange: (f: AcroFieldSpec[]) => void;
  onPlacementsChange: (p: OverlayPlacement[]) => void;
  onValueCommit?: (
    kind: "field" | "placement",
    id: string,
    value: string,
  ) => void;
  instructions: string;
  onInstructionsChange: (v: string) => void;
  onRerunAi: () => void;
  busy: boolean;
  focusField: string | null;
  onFocusField: (name: string) => void;
  fieldRefs: React.MutableRefObject<Record<string, HTMLElement | null>>;
  neededCount: number;
}) {
  const [filter, setFilter] = useState<"needed" | "all">("needed");
  const [query, setQuery] = useState("");

  const editableFields = useMemo(() => {
    return fields.filter((f) => {
      if (f.type === "button" || f.type === "unknown") return false;
      if (f.type === "signature" && mode === "acroform") return false;
      return true;
    });
  }, [fields, mode]);

  const emptyCount = useMemo(() => {
    if (mode === "overlay") {
      return placements.filter((p) => !p.value.trim()).length;
    }
    return editableFields.filter(
      (f) => f.type !== "checkbox" && !f.value.trim(),
    ).length;
  }, [mode, placements, editableFields]);

  // Keep document order — never re-sort by filled/empty while typing (that
  // jumped fields down as soon as the first character was entered).
  const visibleFields = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = editableFields.slice();
    if (filter === "needed") {
      list = list.filter(
        (f) =>
          f.name === focusField ||
          (f.type !== "checkbox" && !f.value.trim()),
      );
    }
    if (q) {
      list = list.filter((f) =>
        (f.label || f.name).toLowerCase().includes(q),
      );
    }
    return list;
  }, [editableFields, filter, query, focusField]);

  const visiblePlacements = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = placements.slice();
    if (filter === "needed") {
      list = list.filter((p) => p.id === focusField || !p.value.trim());
    }
    if (q) {
      list = list.filter((p) => (p.label || p.id).toLowerCase().includes(q));
    }
    return list;
  }, [placements, filter, query, focusField]);

  // Show all fields once nothing is empty.
  useEffect(() => {
    if (neededCount === 0 && filter === "needed") setFilter("all");
  }, [neededCount, filter]);

  return (
    <section className="panel flex min-h-[280px] flex-1 flex-col overflow-hidden">
      <div className="border-b border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-paper">Fields</h2>
          <span className="text-[11px] text-mute">
            {emptyCount > 0 ? `${emptyCount} empty` : "All filled"}
          </span>
        </div>
        <div className="mt-2 flex gap-1 rounded-lg bg-panel p-0.5">
          <button
            type="button"
            onClick={() => setFilter("needed")}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition ${
              filter === "needed"
                ? "bg-warn font-medium text-ink"
                : "text-mute hover:text-paper/90"
            }`}
          >
            Needs attention
            {neededCount > 0 ? ` (${neededCount})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition ${
              filter === "all"
                ? "bg-panel font-medium text-paper ring-1 ring-line"
                : "text-mute hover:text-paper/90"
            }`}
          >
            All fields
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fields…"
          className="field-input mt-2"
        />
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {mode === "overlay" ? (
          visiblePlacements.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-mute">
              {filter === "needed"
                ? "Nothing left to fill — nice work."
                : "No matching fields."}
            </p>
          ) : (
            visiblePlacements.map((p) => {
              const empty = !p.value.trim();
              return (
                <label
                  key={p.id}
                  ref={(el) => {
                    fieldRefs.current[p.id] = el;
                  }}
                  className={`block space-y-1 rounded-lg border border-line p-2.5 ${
                    focusField === p.id
                      ? "bg-accent/10 ring-2 ring-inset ring-accent"
                      : empty
                        ? "bg-warn/10"
                        : "bg-panel"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-paper/80">
                      {p.label || "Field"}
                    </span>
                    {empty && (
                      <span className="rounded bg-warn/25 px-1.5 py-0.5 text-[10px] text-warn">
                        empty
                      </span>
                    )}
                  </span>
                  <input
                    className="w-full rounded-md border border-line bg-ink px-3 py-1.5 text-sm outline-none focus:border-accent"
                    value={p.value}
                    placeholder="Type value (auto-translates to fill language)…"
                    onFocus={() => onFocusField(p.id)}
                    onChange={(e) =>
                      onPlacementsChange(
                        placements.map((x) =>
                          x.id === p.id ? { ...x, value: e.target.value } : x,
                        ),
                      )
                    }
                    onBlur={(e) =>
                      onValueCommit?.("placement", p.id, e.target.value)
                    }
                  />
                </label>
              );
            })
          )
        ) : visibleFields.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-mute">
            {filter === "needed"
              ? "Nothing left to fill — nice work."
              : "No matching fields."}
          </p>
        ) : (
          visibleFields.map((f) => {
            const empty = f.type !== "checkbox" && !f.value.trim();
            return (
              <label
                key={f.name}
                ref={(el) => {
                  fieldRefs.current[f.name] = el;
                }}
                className={`block space-y-1 rounded-lg border border-line p-2.5 ${
                  focusField === f.name
                    ? "bg-accent/10 ring-2 ring-inset ring-accent"
                    : empty
                      ? "bg-warn/10"
                      : "bg-panel"
                }`}
              >
                <span className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-paper/80">
                    {f.label || f.name}
                  </span>
                  {empty && (
                    <span className="rounded bg-warn/25 px-1.5 py-0.5 text-[10px] text-warn">
                      empty
                    </span>
                  )}
                </span>
                <FieldInput
                  field={f}
                  onChange={(v) =>
                    onFieldsChange(
                      fields.map((x) =>
                        x.name === f.name ? { ...x, value: v } : x,
                      ),
                    )
                  }
                  onFocus={() => onFocusField(f.name)}
                  onBlurCommit={(v) => onValueCommit?.("field", f.name, v)}
                />
              </label>
            );
          })
        )}
      </div>

      <details className="border-t border-line">
        <summary className="cursor-pointer px-3 py-2.5 text-xs text-mute hover:text-paper/80">
          Advanced: re-run AI with an instruction
        </summary>
        <div className="space-y-2 px-3 pb-3">
          <textarea
            value={instructions}
            onChange={(e) => onInstructionsChange(e.target.value)}
            rows={2}
            placeholder="e.g. Make the name UPPERCASE"
            className="w-full resize-y rounded-md border border-line bg-ink px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={onRerunAi}
            disabled={busy || !instructions.trim()}
            className="w-full rounded-lg border border-line px-3 py-1.5 text-xs text-paper/90 hover:bg-panel disabled:opacity-40"
          >
            {busy ? "Working…" : "Re-run AI"}
          </button>
        </div>
      </details>
    </section>
  );
}

function FieldInput({
  field,
  onChange,
  onFocus,
  onBlurCommit,
}: {
  field: AcroFieldSpec;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlurCommit?: (value: string) => void;
}) {
  const base =
    "w-full rounded-md border border-line bg-ink px-3 py-1.5 text-sm outline-none focus:border-accent";

  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={field.value.toLowerCase() === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          onFocus={onFocus}
        />
        <span className="text-mute">
          {field.value.toLowerCase() === "true" ? "Checked" : "Unchecked"}
        </span>
      </label>
    );
  }

  if (field.options && field.options.length > 0) {
    return (
      <select
        className={base}
        value={field.value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
      >
        <option value="">— none —</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      className={base}
      value={field.value}
      placeholder="Type value (auto-translates to fill language)…"
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
      onBlur={(e) => onBlurCommit?.(e.target.value)}
    />
  );
}

function FontStyleControls({
  style,
  onChange,
  hint,
  showLanguageNote,
  languageBusy,
}: {
  style: FillStyle;
  onChange: (s: FillStyle) => void;
  hint?: string;
  /** When true, explain bidirectional rewrite on language change. */
  showLanguageNote?: boolean;
  languageBusy?: boolean;
}) {
  return (
    <section className="panel grid gap-3 p-4 sm:grid-cols-3">
      <div>
        <label className="text-sm font-medium text-paper" htmlFor="fill-language">
          Fill language
          {languageBusy ? (
            <span className="ml-2 text-xs font-normal text-accent-strong">
              Translating…
            </span>
          ) : null}
        </label>
        <select
          id="fill-language"
          value={style.language ?? "en"}
          disabled={languageBusy}
          onChange={(e) => {
            const language = e.target.value as FillLanguage;
            const nextFamily =
              language === "dv"
                ? isThaanaFont(style.fontFamily)
                  ? style.fontFamily
                  : "bolhu"
                : isThaanaFont(style.fontFamily)
                  ? "helvetica"
                  : style.fontFamily;
            onChange({ ...style, language, fontFamily: nextFamily });
          }}
          className="field-input mt-1.5 disabled:opacity-50"
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium text-paper" htmlFor="fill-font">
          Font
        </label>
        <select
          id="fill-font"
          value={
            (style.language ?? "en") === "dv"
              ? isThaanaFont(style.fontFamily)
                ? style.fontFamily
                : "bolhu"
              : isThaanaFont(style.fontFamily)
                ? "helvetica"
                : style.fontFamily
          }
          onChange={(e) =>
            onChange({ ...style, fontFamily: e.target.value as FillFontFamily })
          }
          className="field-input mt-1.5"
        >
          {((style.language ?? "en") === "dv"
            ? THAANA_FONT_OPTIONS
            : LATIN_FONT_OPTIONS
          ).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium text-paper" htmlFor="fill-size">
          Font size
        </label>
        <select
          id="fill-size"
          value={style.fontSize}
          onChange={(e) =>
            onChange({ ...style, fontSize: Number(e.target.value) })
          }
          className="field-input mt-1.5"
        >
          {FONT_SIZES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {hint && (
        <p className="text-xs text-mute sm:col-span-3">{hint}</p>
      )}
      {showLanguageNote && (
        <p className="text-xs text-mute sm:col-span-3">
          Change Fill language anytime — free-text values rewrite both ways
          (English ↔ Dhivehi). Dates, IDs, phones, and emails stay Latin.
          Typing in the other language in a field also auto-translates on blur.
        </p>
      )}
    </section>
  );
}

function MultiSourcePicker({
  files,
  inputRef,
  onAdd,
  onRemove,
  onClear,
  compact,
}: {
  files: File[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`panel flex flex-col border-dashed ${
        compact ? "p-3" : "p-4"
      }`}
    >
      {!compact && (
        <>
          <span className="text-sm font-medium text-paper">Your information</span>
          <span className="mt-0.5 text-xs text-mute">
            Add multiple files — ID, letter, passport, Word, photos…
          </span>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf,.pdf,.doc,.docx,.txt,.md,.csv,.json"
        multiple
        className="sr-only"
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []));
          // Reset so the same file can be re-picked later if removed.
          e.target.value = "";
        }}
      />

      <div className={`flex flex-wrap gap-2 ${compact ? "" : "mt-3"}`}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-panel px-3 py-1.5 text-xs font-medium text-paper/90 ring-1 ring-line transition hover:bg-line/80 hover:ring-accent/40"
        >
          {files.length === 0 ? "Choose files" : "Add more files"}
        </button>
        {files.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="rounded-md px-3 py-1.5 text-xs text-danger hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      {files.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {files.map((f, i) => (
            <li
              key={fileKey(f)}
              className="flex items-center justify-between gap-2 rounded-md bg-panel px-2.5 py-1.5 text-xs text-paper/80 ring-1 ring-line/60"
            >
              <span className="min-w-0 truncate">
                {i + 1}. {f.name}
              </span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="shrink-0 text-danger hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilePicker({
  label,
  hint,
  accept,
  inputRef,
  files,
  onChange,
  onClear,
}: {
  label: string;
  hint: string;
  accept: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  files: File[];
  onChange: (files: File[]) => void;
  onClear: () => void;
}) {
  return (
    <label className="panel group flex cursor-pointer flex-col border-dashed p-5 transition hover:border-accent/50 hover:bg-accent/[0.07]">
      <span className="text-sm font-medium text-paper">{label}</span>
      <span className="mt-0.5 text-xs text-mute">{hint}</span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => onChange(Array.from(e.target.files ?? []))}
      />
      <span className="mt-3 inline-flex w-fit rounded-md bg-panel px-3 py-1.5 text-xs font-medium text-paper/90 ring-1 ring-line transition group-hover:bg-accent/15 group-hover:text-accent-strong group-hover:ring-accent/40">
        Choose file
      </span>
      {files.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-mute">
          {files.map((f) => (
            <li key={f.name} className="truncate text-paper/75">
              • {f.name}
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onClear();
              }}
              className="mt-1 text-danger hover:underline"
            >
              Clear
            </button>
          </li>
        </ul>
      )}
    </label>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent"
      aria-label="loading"
    />
  );
}
