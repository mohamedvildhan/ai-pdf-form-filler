"use client";

export const FILL_STAGES = [
  {
    id: "sources",
    label: "Reading sources",
    detail: "Reading your documents…",
  },
  {
    id: "form",
    label: "Reading form",
    detail: "Reading the form layout…",
  },
  {
    id: "fill",
    label: "AI placing values",
    detail: "Finding blanks and filling from your sources…",
  },
  {
    id: "finish",
    label: "Almost done",
    detail: "Opening Review & edit…",
  },
] as const;

export const FILL_STAGE_AT_MS = [0, 8_000, 25_000, 75_000] as const;

const ESTIMATE_SEC = 90;

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface FillProgressProps {
  stageIndex: number;
  elapsedSec: number;
}

export function FillProgress({ stageIndex, elapsedSec }: FillProgressProps) {
  const idx = Math.min(Math.max(stageIndex, 0), FILL_STAGES.length - 1);
  const stage = FILL_STAGES[idx];
  const stagePct = ((idx + 0.55) / FILL_STAGES.length) * 100;
  const timePct = Math.min(92, (elapsedSec / ESTIMATE_SEC) * 100);
  const pct = Math.min(96, Math.max(stagePct * 0.65 + timePct * 0.35, 8));

  return (
    <div
      className="w-full overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-b from-accent/15 to-surface p-4"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-paper">Filling with AI</p>
          <p className="mt-0.5 text-xs text-mute">{stage.detail}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm tabular-nums text-accent-strong">
            {formatElapsed(elapsedSec)}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-mute">
            Step {idx + 1}/{FILL_STAGES.length}
          </p>
        </div>
      </div>

      <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-ink ring-1 ring-line">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent via-accent-strong to-accent transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
        <div className="fill-progress-shimmer pointer-events-none absolute inset-0" />
      </div>

      <ol className="mt-4 grid gap-2 sm:grid-cols-4">
        {FILL_STAGES.map((s, i) => {
          const done = i < idx;
          const active = i === idx;
          return (
            <li
              key={s.id}
              className={`relative flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] leading-tight transition ${
                active
                  ? "fill-progress-active bg-accent/15 text-paper ring-1 ring-accent/40"
                  : done
                    ? "text-ok"
                    : "text-mute/60"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  done
                    ? "bg-ok/20 text-ok"
                    : active
                      ? "bg-accent text-white"
                      : "bg-panel text-mute"
                }`}
              >
                {done ? "✓" : active ? "·" : i + 1}
              </span>
              <span className={active ? "font-medium" : undefined}>{s.label}</span>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-[11px] text-mute">
        Usually about 1–2 minutes. Keep this tab open.
      </p>
    </div>
  );
}
