import { PdfFiller } from "@/components/pdf-filler";

export default function Home() {
  return (
    <div className="app-shell">
      <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:max-w-7xl">
        <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-medium tracking-[0.16em] text-accent-strong">
              PDF TOOL
            </p>
            <h1 className="mt-1.5 text-balance text-3xl font-semibold tracking-tight text-paper sm:text-4xl">
              AI PDF Form Filler
            </h1>
            <p className="mt-2 text-pretty text-sm leading-relaxed text-mute sm:text-[15px]">
              Upload a form and your docs. Review on the page, fix what&apos;s
              missing, then download.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px] text-mute">
            <span className="rounded-full border border-line bg-surface/80 px-2.5 py-1">
              English ↔ Dhivehi
            </span>
            <span className="rounded-full border border-line bg-surface/80 px-2.5 py-1">
              Overlay review
            </span>
          </div>
        </header>
        <PdfFiller />
      </main>
    </div>
  );
}
