"use client";

// Management Dashboard → "📽️ Grant Writing PPT": a deck that builds itself
// from every opportunity the team is working on (the key priorities, and the
// tracker from Draft Application onwards; lib/slides.ts buildDeck). It opens
// like PowerPoint: slide list on the left, the slide in the middle, ‹ › to
// move, ✏️ to edit any text in place, ⛶ for full screen, 🖨 to print or save
// as PDF. Edits are saved per opportunity (opportunity_slides) and the rest of
// each slide keeps following the live data.

import { useEffect, useMemo, useRef, useState } from "react";
import { SLIDE_LABELS, buildDeck, type DeckSlide, type SlideField } from "@/lib/slides";
import type { KeyPriority, OpportunitySlideRow, TrackerItem } from "@/lib/types";
import { OpportunitySlide, SLIDE_H, SLIDE_W, SlideEditStyles, SlideFrame, TitleSlide, deckSubtitle, useFullscreen } from "@/components/Slides";

type Props = {
  items: TrackerItem[];
  priorities: KeyPriority[];
  rows: OpportunitySlideRow[];
  notice: string | null;
  onSave: (slide: DeckSlide, field: SlideField, value: string) => void;
  onReset: (slide: DeckSlide) => void;
  onHide: (slide: DeckSlide, hidden: boolean) => void;
  onClose: () => void;
};

const btn = "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40";

export default function GrantWritingDeck({ items, priorities, rows, notice, onSave, onReset, onHide, onClose }: Props) {
  const [showHidden, setShowHidden] = useState(false);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const fsRef = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(fsRef);

  const all = useMemo(() => buildDeck(items, priorities, rows), [items, priorities, rows]);
  const slides = useMemo(() => (showHidden ? all : all.filter((s) => !s.hidden)), [all, showHidden]);
  const hiddenCount = all.length - all.filter((s) => !s.hidden).length;
  const total = slides.length + 1; // + the title slide
  const at = Math.min(index, total - 1);
  const current = at === 0 ? null : slides[at - 1];
  const subtitle = deckSubtitle(all.filter((s) => !s.hidden).length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "")) return;
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, total - 1));
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Home") setIndex(0);
      else if (e.key === "End") setIndex(total - 1);
      else if (e.key === "Escape" && !document.fullscreenElement && !fs.on) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total, onClose, fs.on]);

  const renderSlide = (i: number, edit = false) =>
    i === 0 ? (
      <TitleSlide subtitle={subtitle} />
    ) : (
      <OpportunitySlide slide={slides[i - 1]} editing={edit} onEdit={(f, v) => onSave(slides[i - 1], f, v)} pageNumber={i + 1} />
    );

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#e9e9e9]">
      <SlideEditStyles />
      <PrintStyles />

      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-300 bg-white px-4 py-2 print:hidden">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ecoa-logo.png" alt="" className="h-7 w-auto" />
          <div>
            <p className="text-sm font-semibold text-neutral-800">Grant Writing PPT</p>
            <p className="text-[11px] text-neutral-500">Builds itself from the key priorities and the tracker (Draft Application onwards). Live data, plus what you type on a slide.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center overflow-hidden rounded-md border border-neutral-300 bg-white">
            <button onClick={() => setIndex(Math.max(at - 1, 0))} disabled={at === 0} className="px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-30" aria-label="Previous slide">
              ‹
            </button>
            <span className="border-x border-neutral-300 px-3 py-1.5 text-sm tabular-nums text-neutral-700">
              {at + 1} / {total}
            </span>
            <button onClick={() => setIndex(Math.min(at + 1, total - 1))} disabled={at === total - 1} className="px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-30" aria-label="Next slide">
              ›
            </button>
          </div>
          <button onClick={() => setEditing((v) => !v)} disabled={!current} aria-pressed={editing} className={`${btn} ${editing && current ? "!border-[#1f5fbf] !bg-blue-50 !text-[#1f5fbf]" : ""}`}>
            {editing && current ? "✓ Done editing" : "✏️ Edit slide"}
          </button>
          <button onClick={fs.enter} className={btn}>
            ⛶ Full screen
          </button>
          <button onClick={() => window.print()} className={btn} title="Print, or choose “Save as PDF”">
            🖨 Print / PDF
          </button>
          {hiddenCount > 0 && (
            <button onClick={() => setShowHidden((v) => !v)} className={btn}>
              {showHidden ? "Hide left-out slides" : `Show left-out slides (${hiddenCount})`}
            </button>
          )}
          <button onClick={onClose} className="rounded-md px-2 py-1 text-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800" title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>
      </div>
      {notice && <p className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 print:hidden">{notice}</p>}

      <div className="flex min-h-0 flex-1 print:hidden">
        {/* ── slide list ── */}
        <div className="hidden w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-neutral-300 bg-[#f6f6f6] p-3 md:flex" aria-label="Slides">
          {Array.from({ length: total }, (_, i) => {
            const s = i === 0 ? null : slides[i - 1];
            return (
              <button key={s?.key ?? "title"} onClick={() => setIndex(i)} className="group flex items-start gap-2 text-left" aria-current={i === at}>
                <span className="w-5 pt-1 text-right text-xs tabular-nums text-neutral-500">{i + 1}</span>
                <div className={`flex-1 rounded-sm ${i === at ? "ring-2 ring-[#c2410c]" : "ring-1 ring-neutral-300 group-hover:ring-neutral-500"} ${s?.hidden ? "opacity-40" : ""}`}>
                  <div className="pointer-events-none">
                    <SlideFrame shadow={false}>{renderSlide(i)}</SlideFrame>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* ── the slide ── */}
        <div className="flex min-w-0 flex-1 flex-col items-center gap-3 overflow-y-auto p-4 sm:p-8">
          <div ref={fsRef} className={fs.on ? "fixed inset-0 z-[60] bg-black" : "w-full max-w-5xl"}>
            <SlideFrame fill={fs.on} shadow={!fs.on}>
              {renderSlide(at, editing && !fs.on)}
            </SlideFrame>
            {fs.on && (
              <div className="fixed bottom-4 left-1/2 z-[61] flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white opacity-30 transition-opacity hover:opacity-100">
                <button onClick={() => setIndex(Math.max(at - 1, 0))} disabled={at === 0} className="px-2 disabled:opacity-30" aria-label="Previous slide">
                  ‹
                </button>
                <span className="tabular-nums">
                  {at + 1} / {total}
                </span>
                <button onClick={() => setIndex(Math.min(at + 1, total - 1))} disabled={at === total - 1} className="px-2 disabled:opacity-30" aria-label="Next slide">
                  ›
                </button>
                <span className="mx-1 h-4 w-px bg-white/40" />
                <button onClick={fs.exit} className="px-2">
                  Exit full screen
                </button>
              </div>
            )}
          </div>

          {current && !fs.on && (
            <div className="flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 text-xs text-neutral-600">
              <span>
                {current.item ? "From the tracker" : "From the key priorities"}
                {current.priority && current.item ? " and the key priorities" : ""}
                {current.overridden.length > 0 && <> · typed over: {current.overridden.map((k) => SLIDE_LABELS[k]).join(", ")}</>}
                {current.hidden && " · left out of the PPT"}
              </span>
              <span className="flex gap-2">
                {current.overridden.length > 0 && (
                  <button onClick={() => confirm("Put the live data back on this slide? Your typed text on it is cleared.") && onReset(current)} className={btn}>
                    ↺ Reset to live data
                  </button>
                )}
                <button onClick={() => onHide(current, !current.hidden)} className={btn}>
                  {current.hidden ? "👁 Put back in the PPT" : "🙈 Leave out of the PPT"}
                </button>
              </span>
            </div>
          )}
          {editing && current && !fs.on && (
            <p className="w-full max-w-5xl text-xs text-neutral-500">Click any text on the slide to change it. It saves when you click away.</p>
          )}
          {total === 1 && (
            <p className="text-sm text-neutral-600">No opportunities yet. Add key priorities, or mark opportunities Fit so they reach Draft Application.</p>
          )}
        </div>
      </div>

      {/* ── what prints: every slide, one per page ── */}
      <div className="print-deck hidden print:block">
        {Array.from({ length: total }, (_, i) => (
          <div key={i} className="print-slide" style={{ width: SLIDE_W, height: SLIDE_H }}>
            <div style={{ width: SLIDE_W, height: SLIDE_H, position: "relative", fontFamily: 'Aptos, "Segoe UI", Calibri, Arial, sans-serif', color: "#111" }}>{renderSlide(i)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PrintStyles() {
  return (
    <style>{`
      @media print {
        @page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }
        body * { visibility: hidden !important; }
        .print-deck, .print-deck * { visibility: visible !important; }
        .print-deck { position: absolute; left: 0; top: 0; }
        .print-slide { page-break-after: always; break-after: page; overflow: hidden; background: #fff; }
        .print-slide:last-child { page-break-after: auto; break-after: auto; }
      }
    `}</style>
  );
}
