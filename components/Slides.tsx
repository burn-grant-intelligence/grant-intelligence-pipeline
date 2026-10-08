"use client";

// Slides for the Management Dashboard's "Grant Writing PPT" (lib/slides.ts):
//
//   SlideFrame        a 16:9 slide drawn at 1280 × 720 and scaled to fit, so
//                     it looks the same small, large and full screen
//   TitleSlide        "Prospecting / Application Phase" with the ECOA logo
//   OpportunitySlide  one opportunity, laid out like the team's PowerPoint;
//                     every text box can be edited in place
//   SlidePopup        one slide in a pop-up (Key priorities, Opportunity pipeline)
//   useSlideRows      loads and saves what people typed on the slides

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { supabase } from "@/lib/supabaseClient";
import { canonicalLead, fmtDate, todayIso } from "@/lib/pipeline";
import { SLIDE_LABELS, bulletLines, nextOverrides, targetKey, type DeckSlide, type SlideField, type SlideTarget } from "@/lib/slides";
import type { OpportunitySlideRow } from "@/lib/types";

export const SLIDE_W = 1280;
export const SLIDE_H = 720;
export const SLIDES_MIGRATION =
  "Slide edits are kept only on this screen until supabase/management_tools_migration_2026-10-08.sql is run in Supabase.";

const FONT = 'Aptos, "Segoe UI", Calibri, Arial, Helvetica, sans-serif';

// ───────────────────────── loading and saving ─────────────────────────

export function useSlideRows(viewer: string | null) {
  const [rows, setRows] = useState<OpportunitySlideRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { data, error } = await supabase.from("opportunity_slides").select("*");
    if (error) {
      setNotice(SLIDES_MIGRATION);
      return;
    }
    setNotice(null);
    setRows(((data as OpportunitySlideRow[]) ?? []).map((r) => ({ ...r, fields: r.fields ?? {} })));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(reload, 0);
    return () => window.clearTimeout(t);
  }, [reload]);

  const upsert = useCallback(
    async (target: SlideTarget, patch: Partial<Pick<OpportunitySlideRow, "fields" | "hidden">>) => {
      const now = new Date().toISOString();
      const by = canonicalLead(viewer);
      const match = (r: OpportunitySlideRow) => (target.kind === "tracker" ? r.tracker_item_id === target.id : r.key_priority_id === target.id);
      // Show it at once; the database follows.
      setRows((prev) => {
        const existing = prev.find(match);
        if (existing) return prev.map((r) => (match(r) ? { ...r, ...patch, updated_by: by, updated_at: now } : r));
        const fresh: OpportunitySlideRow = {
          id: `local-${targetKey(target)}`,
          tracker_item_id: target.kind === "tracker" ? target.id : null,
          key_priority_id: target.kind === "priority" ? target.id : null,
          fields: {},
          hidden: false,
          updated_by: by,
          created_at: now,
          updated_at: now,
          ...patch,
        };
        return [...prev, fresh];
      });
      const key = target.kind === "tracker" ? "tracker_item_id" : "key_priority_id";
      const { error } = await supabase
        .from("opportunity_slides")
        .upsert({ [key]: target.id, ...patch, updated_by: by, updated_at: now }, { onConflict: key })
        .select()
        .single();
      if (error) setNotice(/opportunity_slides|schema cache|does not exist/i.test(error.message) ? SLIDES_MIGRATION : error.message);
    },
    [viewer]
  );

  /** Save one edited text box of a slide. */
  const saveField = useCallback(
    (slide: DeckSlide, field: SlideField, value: string) => {
      const current = rows.find((r) => (slide.target.kind === "tracker" ? r.tracker_item_id === slide.target.id : r.key_priority_id === slide.target.id));
      const fields = nextOverrides(current?.fields, slide.defaults, field, value);
      if (JSON.stringify(fields) === JSON.stringify(current?.fields ?? {})) return;
      return upsert(slide.target, { fields });
    },
    [rows, upsert]
  );
  const resetSlide = useCallback((slide: DeckSlide) => upsert(slide.target, { fields: {} }), [upsert]);
  const setHidden = useCallback((slide: DeckSlide, hidden: boolean) => upsert(slide.target, { hidden }), [upsert]);

  return { rows, notice, reload, saveField, resetSlide, setHidden };
}

// ───────────────────────── the frame ─────────────────────────

/**
 * Draws its child at 1280 × 720 and scales it to the space it has. With
 * `fill`, it fits inside the parent's width and height (full screen);
 * otherwise it takes the parent's width at 16:9.
 */
export function SlideFrame({ children, fill = false, className = "", shadow = true }: { children: ReactNode; fill?: boolean; className?: string; shadow?: boolean }) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setScale(fill ? Math.min(w / SLIDE_W, h / SLIDE_H) : w / SLIDE_W);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  return (
    <div ref={outer} className={`relative ${fill ? "h-full w-full" : "w-full"} ${className}`} style={fill ? undefined : { aspectRatio: "16 / 9" }}>
      <div
        className={`absolute overflow-hidden bg-white ${shadow ? "shadow-[0_2px_12px_rgba(0,0,0,0.18)]" : ""}`}
        style={{
          width: SLIDE_W,
          height: SLIDE_H,
          transform: `scale(${scale || 0.0001})`,
          transformOrigin: "top left",
          left: fill ? `calc(50% - ${(SLIDE_W * scale) / 2}px)` : 0,
          top: fill ? `calc(50% - ${(SLIDE_H * scale) / 2}px)` : 0,
          fontFamily: FONT,
          color: "#111",
          visibility: scale ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ───────────────────────── editable text ─────────────────────────

function EditableText({
  value,
  editing,
  onCommit,
  multiline = false,
  className = "",
  style,
  placeholder,
  label,
}: {
  value: string;
  editing: boolean;
  onCommit: (v: string) => void;
  multiline?: boolean;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  label: string;
}) {
  if (!editing) {
    return (
      <div className={className} style={{ ...style, whiteSpace: multiline ? "pre-wrap" : undefined }}>
        {value || <span style={{ color: "#b0b0b0" }}>{placeholder ?? ""}</span>}
      </div>
    );
  }
  return (
    <div
      key={value}
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      spellCheck
      onKeyDown={(e) => {
        if (e.key === "Escape" || (!multiline && e.key === "Enter")) {
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).blur();
        }
        e.stopPropagation(); // arrow keys type here, they don't change slides
      }}
      onBlur={(e) => {
        const text = e.currentTarget.innerText;
        if (text.trim() !== value.trim()) onCommit(text);
      }}
      className={`slide-edit ${className}`}
      style={{ ...style, whiteSpace: multiline ? "pre-wrap" : undefined }}
    >
      {value}
    </div>
  );
}

// ───────────────────────── the slides ─────────────────────────

export function TitleSlide({ subtitle }: { subtitle?: string }) {
  return (
    <div className="relative h-full w-full bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/ecoa-logo.png" alt="ecoa by burn" style={{ position: "absolute", right: 56, top: 56, width: 170, height: "auto" }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 296, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: 236, height: 6, background: "#808080", marginBottom: 14 }} />
        <h1 style={{ fontSize: 60, fontWeight: 700, color: "#3d3d3d", letterSpacing: 0.3, margin: 0 }}>Prospecting / Application Phase</h1>
        {subtitle && <p style={{ fontSize: 22, color: "#8a8a8a", marginTop: 22 }}>{subtitle}</p>}
      </div>
    </div>
  );
}

export function deckSubtitle(count: number, today = todayIso()) {
  return `Grant writing update · ${fmtDate(today)} · ${count} opportunit${count === 1 ? "y" : "ies"}`;
}

const cell: CSSProperties = { borderTop: "1.5px solid #111", display: "flex", minHeight: 0 };
const labelCell: CSSProperties = { width: 132, flexShrink: 0, background: "#f2f2f2", fontWeight: 700, fontSize: 18, padding: "8px 10px" };
const valueCell: CSSProperties = { flex: 1, fontSize: 18, padding: "8px 12px", minWidth: 0, wordBreak: "break-word" };

export function OpportunitySlide({
  slide,
  editing = false,
  onEdit,
  pageNumber,
}: {
  slide: DeckSlide;
  editing?: boolean;
  onEdit?: (field: SlideField, value: string) => void;
  pageNumber?: number;
}) {
  const f = slide.fields;
  const can = editing && !!onEdit;
  const commit = (field: SlideField) => (v: string) => onEdit?.(field, v);
  const descLen = f.description.length;
  const descSize = descLen > 1100 ? 13 : descLen > 800 ? 14.5 : descLen > 500 ? 16 : 18;
  const sources = bulletLines(f.source);

  const side = (field: SlideField) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 17, fontWeight: 700 }}>{SLIDE_LABELS[field]}:</div>
      <EditableText value={f[field]} editing={can} onCommit={commit(field)} label={SLIDE_LABELS[field]} placeholder="TBD" style={{ fontSize: 17 }} />
    </div>
  );

  return (
    <div className="relative h-full w-full bg-white">
      <EditableText
        value={f.title}
        editing={can}
        onCommit={commit("title")}
        label="Title"
        style={{ position: "absolute", left: 76, top: 44, right: 76, fontSize: 34, fontWeight: 700, lineHeight: 1.15 }}
      />

      {/* left box */}
      <div
        style={{
          position: "absolute",
          left: 58,
          top: 140,
          width: 258,
          height: 524,
          border: "2.5px solid #555",
          boxShadow: "inset 0 0 0 1px #cfcfcf",
          padding: "20px 16px",
          overflow: "hidden",
        }}
      >
        {side("organization")}
        {side("deadline")}
        {side("start")}
        {side("end")}
        {side("amount")}
        {side("funding")}
        <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 17 }}>
          <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>BURN lead:</span>
          <EditableText value={f.lead} editing={can} onCommit={commit("lead")} label="BURN lead" placeholder="TBD" style={{ fontSize: 17, flex: 1 }} />
        </div>
      </div>

      {/* right table */}
      <div
        style={{
          position: "absolute",
          left: 346,
          top: 140,
          right: 58,
          height: 524,
          border: "1.5px solid #111",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <EditableText
          value={f.stage}
          editing={can}
          onCommit={commit("stage")}
          label="Stage"
          style={{ background: "#808080", color: "#fff", fontWeight: 700, fontSize: 20, textAlign: "center", padding: "7px 10px" }}
        />
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ ...labelCell, paddingTop: 10 }}>Description</div>
          <EditableText
            value={f.description}
            editing={can}
            onCommit={commit("description")}
            multiline
            label="Description"
            placeholder="Add a short description of the opportunity"
            style={{ ...valueCell, fontSize: descSize, lineHeight: 1.35, overflow: "hidden" }}
          />
        </div>
        <div style={cell}>
          <div style={labelCell}>Countries</div>
          <EditableText value={f.countries} editing={can} onCommit={commit("countries")} label="Countries" style={valueCell} />
        </div>
        <div style={cell}>
          <div style={labelCell}>Product type</div>
          <EditableText value={f.products} editing={can} onCommit={commit("products")} label="Product type" style={valueCell} />
        </div>
        <div style={cell}>
          <div style={labelCell}>Source</div>
          {can ? (
            <EditableText value={f.source} editing onCommit={commit("source")} multiline label="Source" style={valueCell} />
          ) : (
            <div style={valueCell}>
              {sources.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 10 }}>
                  <span>•</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={cell}>
          <div style={labelCell}>Link</div>
          {can ? (
            <EditableText value={f.link} editing onCommit={commit("link")} label="Link" style={{ ...valueCell, fontSize: 15 }} />
          ) : (
            <div style={{ ...valueCell, fontSize: 15, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              {f.link ? (
                <a href={/^https?:\/\//i.test(f.link) ? f.link : `https://${f.link}`} target="_blank" rel="noopener noreferrer" style={{ color: "#1f5fbf", textDecoration: "underline" }}>
                  {f.link}
                </a>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {typeof pageNumber === "number" && (
        <div style={{ position: "absolute", right: 30, bottom: 18, fontSize: 14, color: "#9a9a9a" }}>{pageNumber}</div>
      )}
    </div>
  );
}

// The dashed boxes around editable text, like PowerPoint's text boxes.
export function SlideEditStyles() {
  return (
    <style>{`
      .slide-edit { outline: 1.5px dashed rgba(31,95,191,0.45); outline-offset: 2px; border-radius: 2px; cursor: text; }
      .slide-edit:hover { outline-color: rgba(31,95,191,0.8); }
      .slide-edit:focus { outline: 2px solid #1f5fbf; background: rgba(31,95,191,0.04); }
      .slide-edit:empty:before { content: attr(data-placeholder); color: #b0b0b0; }
    `}</style>
  );
}

// ───────────────────────── full screen ─────────────────────────

/** Full screen for the element `ref` points to (the caller owns the ref). */
export function useFullscreen<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!document.fullscreenElement && document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [ref]);
  const enter = useCallback(async () => {
    const el = ref.current;
    if (!el) return;
    try {
      await el.requestFullscreen();
    } catch {
      setOn(true); // the browser refused: fill the window instead
    }
  }, [ref]);
  const exit = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    setOn(false);
  }, []);
  return { on, enter, exit };
}

// ───────────────────────── one slide in a pop-up ─────────────────────────

const toolBtn = "rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40";

export function SlidePopup({
  slide,
  notice,
  onSave,
  onReset,
  onHide,
  onClose,
  extra,
}: {
  slide: DeckSlide;
  notice: string | null;
  onSave: (field: SlideField, value: string) => void;
  onReset: () => void;
  onHide: (hidden: boolean) => void;
  onClose: () => void;
  /** Shown under the slide (e.g. meeting notes and action points). */
  extra?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const fsRef = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(fsRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement && !fs.on) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, fs.on]);

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--ink)]/50 p-3 sm:p-6">
      <SlideEditStyles />
      <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-6xl flex-col gap-3 rounded-2xl bg-[#f3f3f3] p-4 shadow-2xl sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-neutral-700">
            Slide · <span className="font-normal text-neutral-500">{slide.fields.title}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setEditing((v) => !v)} className={`${toolBtn} ${editing ? "!border-[#1f5fbf] !bg-blue-50 !text-[#1f5fbf]" : ""}`} aria-pressed={editing}>
              {editing ? "✓ Done editing" : "✏️ Edit slide"}
            </button>
            <button onClick={fs.enter} className={toolBtn}>
              ⛶ Full screen
            </button>
            {slide.overridden.length > 0 && (
              <button onClick={() => confirm("Put the live data back on this slide? Your typed text on it is cleared.") && onReset()} className={toolBtn} title={`Typed over: ${slide.overridden.map((k) => SLIDE_LABELS[k]).join(", ")}`}>
                ↺ Reset to live data
              </button>
            )}
            <button onClick={() => onHide(!slide.hidden)} className={toolBtn} title="Whether this slide is in the Grant Writing PPT">
              {slide.hidden ? "👁 Put back in the PPT" : "🙈 Leave out of the PPT"}
            </button>
            <button onClick={onClose} className="rounded-md px-2 py-1 text-neutral-400 hover:bg-white hover:text-neutral-800" title="Close (Esc)" aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        {notice && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{notice}</p>}
        {editing && <p className="text-xs text-neutral-500">Click any text on the slide to change it. It saves when you click away. The slide keeps following the live data for everything you leave as it is.</p>}
        <div ref={fsRef} className={fs.on ? "fixed inset-0 z-[60] flex items-center justify-center bg-black" : ""}>
          <SlideFrame fill={fs.on} shadow={!fs.on}>
            <OpportunitySlide slide={slide} editing={editing} onEdit={onSave} />
          </SlideFrame>
          {fs.on && (
            <button onClick={fs.exit} className="fixed right-4 top-4 z-[61] rounded-md bg-white/15 px-3 py-1.5 text-sm text-white hover:bg-white/30">
              Exit full screen
            </button>
          )}
        </div>
        {slide.hidden && <p className="text-xs text-neutral-500">This slide is left out of the Grant Writing PPT.</p>}
        {extra}
      </div>
    </div>
  );
}
