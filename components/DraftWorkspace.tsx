"use client";

// The workspace for one application in the Draft Application tab. Opens over
// the stage board. Tabs:
//   Management guidance — what management wants before the concept is written
//                      (dated entries: who said it, where). Fed into the Claude prompt
//                      and the Gemini review.
//   Brief            — what the donor wants + the questions and their limits
//                      (typed, or decoded from the call by Gemini). Shared by all stages.
//   Draft            — the draft for the stage you are viewing, answer by answer,
//                      with live word / character counters against each limit.
//   Review           — the stage checklist, the automatic checks, "Copy prompt →
//                      Claude" and "Run Gemini review" (results saved per stage).
//   Meetings & actions — dated meeting notes with action points, tagged with the stage.
//   Notes & learnings  — free notes on the stage, and the learnings library
//                      (lessons borrowed from earlier applications, and new ones).
//   History          — who lifted the application when, and what was still open.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { cleanClickUpUrl, effectiveFields, fmtDate, todayIso } from "@/lib/pipeline";
import {
  BOARD_COLUMNS, CLAUDE_PROJECT_URL, MIGRATION_HINT, STAGES, buildClaudePrompt, columnOf, daysLeftLabel, isMissingDraftTables, carryForward, emptyBrief, hasDraft, limitCheck, localChecks,
  newQuestionId, pickLearnings, prevStage, stageIndex, stageMeta, stageOf, type BoardColumn, type LimitState,
} from "@/lib/drafting";
import type {
  ActionItem, DraftBrief, DraftGuidance, DraftLearning, DraftQuestion, DraftStage, DraftStageMove, DraftStageWork, OpportunityNote, ReviewStatus, StageReview, TrackerItem,
} from "@/lib/types";
import { NotesSection } from "@/components/OpportunityBreakdown";

type Tab = "guidance" | "brief" | "draft" | "review" | "meetings" | "learnings" | "history";
const TABS: { key: Tab; label: string }[] = [
  { key: "guidance", label: "🧭 Management guidance" },
  { key: "brief", label: "🎯 Brief" },
  { key: "draft", label: "📝 Draft" },
  { key: "review", label: "✅ Review" },
  { key: "meetings", label: "🤝 Meetings & actions" },
  { key: "learnings", label: "💡 Notes & learnings" },
  { key: "history", label: "🕘 History" },
];

const STATUS_STYLE: Record<ReviewStatus, string> = {
  pass: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-800",
  fail: "bg-red-100 text-red-700",
};
const STATUS_ICON: Record<ReviewStatus, string> = { pass: "✓", warn: "!", fail: "✕" };
const LIMIT_STYLE: Record<LimitState, string> = {
  empty: "text-neutral-400",
  no_limit: "text-neutral-500",
  ok: "text-emerald-700",
  near: "text-amber-700",
  over: "text-red-600 font-semibold",
};
const LIMIT_BAR: Record<LimitState, string> = { empty: "bg-neutral-200", no_limit: "bg-neutral-300", ok: "bg-emerald-500", near: "bg-amber-500", over: "bg-red-500" };

const baseInput = "rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-800 focus:border-[var(--accent)] focus:outline-none";
const inputCls = `${baseInput} w-full`;
const primaryBtn = "rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40";
const accentBtn = "rounded-md border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-orange-50 disabled:cursor-wait disabled:opacity-50";
const quietBtn = "rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40";

// Reads a JSON reply, or explains an HTML / timeout page in plain words.
async function postJson(url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> | null; error: string | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const raw = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    if (!json) {
      if (res.status === 404) return { ok: false, json: null, error: "The server has no /api/draft-review route yet (HTTP 404). Check that app/api/draft-review/route.ts is on GitHub and the latest Vercel deployment finished." };
      if (res.status === 504 || /TIMEOUT/i.test(raw)) return { ok: false, json: null, error: "Gemini took too long and the server timed out. Try again in a minute." };
      return { ok: false, json: null, error: `The server returned an unexpected reply (HTTP ${res.status}).` };
    }
    if (!res.ok) return { ok: false, json, error: (json.error as string) ?? `Request failed (HTTP ${res.status}).` };
    return { ok: true, json, error: null };
  } catch (err) {
    return { ok: false, json: null, error: `Could not reach the app's server${err instanceof Error && err.message ? ` (${err.message})` : ""}.` };
  }
}

export default function DraftWorkspace({
  item,
  works,
  guidance,
  notes,
  actions,
  learnings,
  viewer,
  tablesMissing,
  onClose,
  onWorkSaved,
  onItemChange,
  onRequestMove,
  onGuidanceChange,
  onNotesChange,
  onActionsChange,
  onLearningsChange,
}: {
  item: TrackerItem;
  works: DraftStageWork[];
  guidance: DraftGuidance[];
  notes: OpportunityNote[];
  actions: ActionItem[];
  learnings: DraftLearning[];
  viewer: string | null;
  tablesMissing: boolean;
  onClose: () => void;
  onWorkSaved: (row: DraftStageWork) => void;
  onItemChange: (patch: Partial<TrackerItem>) => void;
  onRequestMove: (to: BoardColumn) => void;
  onGuidanceChange: (update: (prev: DraftGuidance[]) => DraftGuidance[]) => void;
  onNotesChange: (update: (prev: OpportunityNote[]) => OpportunityNote[]) => void;
  onActionsChange: (update: (prev: ActionItem[]) => ActionItem[]) => void;
  onLearningsChange: (update: (prev: DraftLearning[]) => DraftLearning[]) => void;
}) {
  const current = stageOf(item);
  const column = columnOf(item);
  const [viewStage, setViewStage] = useState<DraftStage>(current);
  const [tab, setTab] = useState<Tab>(item.draft_brief?.questions?.length ? "draft" : current === "concept" && guidance.length === 0 ? "guidance" : "brief");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<DraftStageMove[]>([]);
  const [showMindset, setShowMindset] = useState(false);
  const eff = effectiveFields(item);
  const opportunity = eff.programName || "(untitled opportunity)";

  // Follow the application when it is moved while the workspace is open.
  const [seenStage, setSeenStage] = useState(current);
  if (seenStage !== current) {
    setSeenStage(current);
    setViewStage(current);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const h = await supabase.from("draft_stage_history").select("*").eq("tracker_item_id", item.id).order("moved_at", { ascending: false });
      if (cancelled) return;
      setHistory((h.data as DraftStageMove[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, item.draft_stage, item.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const workFor = (s: DraftStage) => works.find((w) => w.stage === s) ?? null;
  const work = workFor(viewStage);
  const before = prevStage(viewStage);
  const previous = before ? workFor(before) : null;
  const borrowed = useMemo(() => pickLearnings(learnings, { trackerItemId: item.id, funder: eff.funder, stage: viewStage }), [learnings, item.id, eff.funder, viewStage]);

  async function saveWork(stage: DraftStage, patch: Partial<DraftStageWork>): Promise<boolean> {
    setError(null);
    const { data, error: e } = await supabase
      .from("draft_stage_work")
      .upsert({ tracker_item_id: item.id, stage, ...patch, updated_by: viewer, updated_at: new Date().toISOString() }, { onConflict: "tracker_item_id,stage" })
      .select()
      .single();
    if (e) {
      setError(isMissingDraftTables(e.message) ? MIGRATION_HINT : e.message);
      return false;
    }
    onWorkSaved(data as DraftStageWork);
    return true;
  }

  async function saveBrief(brief: DraftBrief): Promise<boolean> {
    setError(null);
    const { error: e } = await supabase.from("tracker_items").update({ draft_brief: brief, updated_at: new Date().toISOString() }).eq("id", item.id);
    if (e) {
      setError(isMissingDraftTables(e.message) ? MIGRATION_HINT : e.message);
      return false;
    }
    onItemChange({ draft_brief: brief });
    return true;
  }

  async function saveClickUp(raw: string) {
    const clean = cleanClickUpUrl(raw);
    if (raw.trim() && !clean) return setError("That doesn't look like a web link — paste the ClickUp task or list URL (starting with https://).");
    if ((item.clickup_url ?? null) === clean) return;
    setError(null);
    const { error: e } = await supabase.from("tracker_items").update({ clickup_url: clean, updated_at: new Date().toISOString() }).eq("id", item.id);
    if (e) return setError(isMissingDraftTables(e.message) ? MIGRATION_HINT : e.message);
    onItemChange({ clickup_url: clean });
  }

  const due = daysLeftLabel(eff.deadline);
  const meta = stageMeta(viewStage);

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--ink)]/40 p-3 sm:p-6">
      <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-6xl flex-col gap-4 rounded-2xl bg-white p-4 shadow-2xl sm:p-6">
        {/* ── header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {eff.funder && <p className="text-xs text-[var(--ink-muted)]">{eff.funder}</p>}
            <h3 className="text-lg font-semibold leading-snug text-[var(--ink)]">{opportunity}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              {due && <span className={`rounded-full px-2 py-0.5 font-medium ${due.tone}`}>{due.text}</span>}
              {eff.deadline && <span>Deadline {fmtDate(eff.deadline)}</span>}
              {eff.lead && <span>· Lead: {eff.lead}</span>}
              {eff.link && (
                <a href={eff.link} target="_blank" rel="noopener noreferrer" className="underline decoration-neutral-300 hover:text-[var(--accent)]">
                  · Call page ↗
                </a>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">ClickUp</span>
              <input
                key={item.clickup_url ?? "none"}
                defaultValue={item.clickup_url ?? ""}
                placeholder="Paste the ClickUp task or list link"
                onBlur={(e) => saveClickUp(e.target.value)}
                className={`${baseInput} w-72 max-w-full py-1 text-xs`}
              />
              {item.clickup_url && (
                <a href={item.clickup_url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
                  Open in ClickUp ↗
                </a>
              )}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800" title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* ── stage stepper ── */}
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
          <div className="grid grid-cols-2 gap-2">
            {STAGES.map((s, i) => {
              const isCurrent = s.key === current;
              const isPast = i < stageIndex(current) || column === "submitted";
              const isViewed = s.key === viewStage;
              const w = workFor(s.key);
              const ticks = s.checklist.filter((c) => (w?.checklist ?? []).includes(c.id)).length;
              return (
                <button
                  key={s.key}
                  onClick={() => setViewStage(s.key)}
                  className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition ${
                    isViewed ? "border-[var(--accent)] bg-white shadow-sm" : "border-transparent hover:bg-white"
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--ink)]">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${isPast ? "bg-emerald-500 text-white" : isCurrent ? "bg-[var(--accent)] text-white" : "bg-neutral-200 text-neutral-500"}`}>
                      {isPast ? "✓" : i + 1}
                    </span>
                    {s.icon} {s.short}
                  </span>
                  <span className="text-[11px] text-neutral-500">
                    {isCurrent && column !== "submitted" ? "Current stage · " : ""}
                    {ticks}/{s.checklist.length} ticked{typeof w?.review?.readiness === "number" ? ` · ✨ ${w.review.readiness}%` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-neutral-700">
              <strong>{meta.label}:</strong> {meta.goal}{" "}
              <button onClick={() => setShowMindset(!showMindset)} className="text-xs font-medium text-[var(--accent)] hover:underline">
                {showMindset ? "Hide" : "What to keep in mind"}
              </button>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {viewStage !== current && <span className="text-xs text-amber-700">You are viewing the {meta.label.toLowerCase()}; the application is at {stageMeta(current).label.toLowerCase()}.</span>}
              <MoveToggle column={column} onMove={onRequestMove} />
            </div>
          </div>
          {showMindset && (
            <ul className="grid gap-1 pl-1 text-sm text-neutral-600 sm:grid-cols-2">
              {meta.mindset.map((m) => (
                <li key={m}>• {m}</li>
              ))}
            </ul>
          )}
        </div>

        {tablesMissing && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{MIGRATION_HINT}</div>}
        {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

        {/* ── tabs ── */}
        <div className="flex flex-wrap gap-1 border-b border-neutral-200">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-[var(--accent)] font-semibold text-[var(--ink)]" : "border-transparent text-neutral-500 hover:text-neutral-800"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "guidance" && (
          <GuidanceTab item={item} stage={viewStage} guidance={guidance} viewer={viewer} onChange={onGuidanceChange} onError={setError} onGoToDraft={() => setTab(item.draft_brief?.questions?.length ? "draft" : "brief")} />
        )}
        {tab === "brief" && <BriefTab item={item} onSave={saveBrief} onDecoded={(b) => onItemChange({ draft_brief: b })} onError={setError} />}
        {tab === "draft" && (
          <DraftTab
            key={viewStage}
            item={item}
            stage={viewStage}
            work={work}
            previous={previous}
            onSave={(patch) => saveWork(viewStage, patch)}
            onGoToBrief={() => setTab("brief")}
          />
        )}
        {tab === "review" && (
          <ReviewTab
            key={viewStage}
            item={item}
            stage={viewStage}
            work={work}
            previous={previous}
            notes={notes}
            actions={actions}
            learnings={borrowed}
            guidance={guidance}
            viewer={viewer}
            onSave={(patch) => saveWork(viewStage, patch)}
            onReviewed={(review, reviewed_at) => work && onWorkSaved({ ...work, review, reviewed_at })}
            onActionsAdded={(rows) => onActionsChange((prev) => [...prev, ...rows])}
            onLearningAdded={(l) => onLearningsChange((prev) => [l, ...prev])}
            onError={setError}
          />
        )}
        {tab === "meetings" && (
          <NotesSection
            item={item}
            opportunity={opportunity}
            viewer={viewer}
            notes={notes}
            actions={actions}
            onNotesChange={onNotesChange}
            onActionsChange={onActionsChange}
            onError={setError}
            stage={viewStage}
          />
        )}
        {tab === "learnings" && (
          <LearningsTab
            key={viewStage}
            item={item}
            stage={viewStage}
            work={work}
            all={learnings}
            borrowed={borrowed}
            viewer={viewer}
            onSaveNotes={(stage_notes) => saveWork(viewStage, { stage_notes })}
            onChange={onLearningsChange}
            onError={setError}
          />
        )}
        {tab === "history" && <HistoryTab history={history} works={works} />}
      </div>
    </div>
  );
}

// ───────────────────────── Lift dialog ─────────────────────────

const COLUMN_LABEL = (c: BoardColumn) => BOARD_COLUMNS.find((x) => x.key === c)?.label ?? c;

export function LiftDialog({
  title,
  from,
  to,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  from: DraftStage;
  to: BoardColumn;
  open: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const submitting = to === "submitted";
  return (
    <div onClick={onCancel} className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--ink)]/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-lg flex-col gap-3 rounded-2xl bg-white p-5 shadow-2xl">
        <h4 className="text-base font-semibold text-[var(--ink)]">{submitting ? "Mark as submitted?" : `Move to ${COLUMN_LABEL(to)}?`}</h4>
        <p className="text-sm text-neutral-600">
          <strong>{title}</strong> still has {open.length} open item{open.length === 1 ? "" : "s"} at the {stageMeta(from).label.toLowerCase()}. You can move it anyway; the open items are saved in its History.
        </p>
        <ul className="max-h-64 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {open.map((o) => (
            <li key={o} className="py-0.5">
              ☐ {o}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className={quietBtn}>
            Stay at {stageMeta(from).short}
          </button>
          <button onClick={onConfirm} disabled={busy} className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? "Moving…" : submitting ? "Submit anyway ✓" : "Move anyway ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}

// The toggle on every card and in the workspace header: Concept | First draft |
// Submitted — the same idea as Tracking | Drafting | Submitted on the Management
// Dashboard. Clicking the column it is already in does nothing.
export function MoveToggle({ column, onMove, disabled, compact }: { column: BoardColumn; onMove: (to: BoardColumn) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <div role="group" aria-label="Move to" className="inline-flex w-full overflow-hidden rounded-md border border-neutral-300 sm:w-auto">
      {BOARD_COLUMNS.map((c, i) => {
        const active = c.key === column;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => !active && onMove(c.key)}
            title={active ? `Currently in ${c.label}` : `Move to ${c.label}`}
            className={`flex-1 ${i > 0 ? "border-l border-neutral-300" : ""} ${compact ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs"} font-medium transition disabled:opacity-50 ${
              active ? (c.key === "submitted" ? "bg-emerald-600 text-white" : "bg-[var(--accent)] text-white") : "bg-white text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            {c.icon} {c.label}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Management guidance ─────────────────────────

const GUIDANCE_SOURCES = ["Management meeting", "Email", "WhatsApp / chat", "Call", "Other"];

function GuidanceTab({
  item,
  stage,
  guidance,
  viewer,
  onChange,
  onError,
  onGoToDraft,
}: {
  item: TrackerItem;
  stage: DraftStage;
  guidance: DraftGuidance[];
  viewer: string | null;
  onChange: (update: (prev: DraftGuidance[]) => DraftGuidance[]) => void;
  onError: (m: string | null) => void;
  onGoToDraft: () => void;
}) {
  const [date, setDate] = useState(todayIso());
  const [source, setSource] = useState(GUIDANCE_SOURCES[0]);
  const [givenBy, setGivenBy] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!text.trim()) return;
    setSaving(true);
    onError(null);
    const { data, error } = await supabase
      .from("draft_guidance")
      .insert({ tracker_item_id: item.id, guidance_date: date || todayIso(), source, given_by: givenBy.trim() || null, text: text.trim(), author: viewer })
      .select()
      .single();
    setSaving(false);
    if (error) return onError(isMissingDraftTables(error.message) ? MIGRATION_HINT : error.message);
    onChange((prev) => [...prev, data as DraftGuidance]);
    setText("");
  }

  async function remove(g: DraftGuidance) {
    if (!confirm("Delete this guidance entry for everyone?")) return;
    const { error } = await supabase.from("draft_guidance").delete().eq("id", g.id);
    if (error) return onError(error.message);
    onChange((prev) => prev.filter((x) => x.id !== g.id));
  }

  const sorted = [...guidance].sort((a, b) => b.guidance_date.localeCompare(a.guidance_date) || b.created_at.localeCompare(a.created_at));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="flex flex-col gap-3">
        <div className="rounded-lg border border-orange-100 bg-orange-50/60 p-3 text-sm text-neutral-700">
          Before the concept is written, the management team usually says what it wants: why this opportunity, what to lead with, what to avoid, who to partner with, the budget it is
          comfortable with. Record each steer here with its date and who gave it.{" "}
          <strong>It goes into the Claude prompt and the Gemini review</strong>, so the {stage === "concept" ? "concept note" : "draft"} follows it — and any conflict with the call is flagged, not hidden.
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
          <p className="text-sm font-medium text-neutral-800">Add management guidance</p>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${baseInput} w-40`} aria-label="Date given" />
            <select value={source} onChange={(e) => setSource(e.target.value)} className={`${baseInput} w-auto`} aria-label="Where it came from">
              {GUIDANCE_SOURCES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <input value={givenBy} onChange={(e) => setGivenBy(e.target.value)} placeholder="Given by (e.g. CEO)" className={`${baseInput} w-44`} />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="e.g. Lead with the clean-cooking pilot in Kenya; keep the budget under USD 250k; partner with the county government, not an NGO; don't promise carbon credits."
            className={inputCls}
          />
          <div className="flex items-center justify-between gap-2">
            <button onClick={onGoToDraft} className="text-xs font-medium text-[var(--accent)] hover:underline">
              Next: the Brief / Draft →
            </button>
            <button onClick={add} disabled={!text.trim() || saving} className={primaryBtn}>
              {saving ? "Saving…" : "Save guidance"}
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Recorded guidance ({guidance.length})</p>
        {sorted.length === 0 && <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">Nothing recorded yet. The concept prompt will say that management has not given direction.</p>}
        {sorted.map((g) => (
          <div key={g.id} className="rounded-lg border border-neutral-200 p-2.5 text-sm">
            <p className="whitespace-pre-wrap text-neutral-800">{g.text}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
              <span className="rounded-full bg-orange-50 px-2 py-0.5 font-medium text-[var(--accent)]">{fmtDate(g.guidance_date)}</span>
              {g.source && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{g.source}</span>}
              {g.given_by && <span className="rounded-full bg-neutral-100 px-2 py-0.5">from {g.given_by}</span>}
              {g.author && <span>recorded by {g.author}</span>}
              <span className="flex-1" />
              <button onClick={() => remove(g)} className="text-neutral-300 hover:text-red-500" title="Delete">
                ✕
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

// ───────────────────────── Brief ─────────────────────────

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function BriefTab({ item, onSave, onDecoded, onError }: { item: TrackerItem; onSave: (b: DraftBrief) => Promise<boolean>; onDecoded: (b: DraftBrief) => void; onError: (m: string | null) => void }) {
  const initial = item.draft_brief ?? emptyBrief();
  const [objectives, setObjectives] = useState(initial.objectives.join("\n"));
  const [criteria, setCriteria] = useState(initial.criteria.map((c) => (c.weight ? `${c.name} | ${c.weight}` : c.name)).join("\n"));
  const [keywords, setKeywords] = useState(initial.keywords.join(", "));
  const [mustHaves, setMustHaves] = useState(initial.must_haves.join("\n"));
  const [questions, setQuestions] = useState<DraftQuestion[]>(initial.questions);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = (b: DraftBrief) => {
    setObjectives(b.objectives.join("\n"));
    setCriteria(b.criteria.map((c) => (c.weight ? `${c.name} | ${c.weight}` : c.name)).join("\n"));
    setKeywords(b.keywords.join(", "));
    setMustHaves(b.must_haves.join("\n"));
    setQuestions(b.questions);
    setDirty(false);
  };

  const collect = (): DraftBrief => ({
    objectives: lines(objectives),
    criteria: lines(criteria).map((l) => {
      const [name, weight] = l.split("|").map((x) => x.trim());
      return { name, weight: weight || null };
    }),
    keywords: keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean),
    must_haves: lines(mustHaves),
    questions: questions.filter((q) => q.label.trim()).map((q) => ({ ...q, label: q.label.trim() })),
    decoded_at: item.draft_brief?.decoded_at ?? null,
    source: item.draft_brief?.source ?? null,
  });

  async function save() {
    setSaving(true);
    if (await onSave(collect())) {
      setDirty(false);
      setMessage("Brief saved.");
    }
    setSaving(false);
  }

  async function decode() {
    if (dirty && !(await onSave(collect()))) return; // keep what was typed before Gemini merges
    setDecoding(true);
    setMessage(null);
    onError(null);
    const r = await postJson("/api/draft-review", { action: "decode", trackerItemId: item.id, ...(paste.trim() ? { pastedText: paste } : {}) });
    setDecoding(false);
    if (!r.ok || !r.json) {
      onError(r.error);
      setShowPaste(true);
      return;
    }
    const brief = r.json.brief as DraftBrief;
    const found = r.json.found as { questions: number; criteria: number };
    load(brief);
    onDecoded(brief);
    setMessage(`Gemini found ${found.questions} question${found.questions === 1 ? "" : "s"} and ${found.criteria} criteria. Anything you had typed was kept — check the limits against the form.`);
  }

  const set = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setDirty(true);
  };
  const updateQ = (id: string, patch: Partial<DraftQuestion>) => set(setQuestions)(questions.map((q) => (q.id === id ? { ...q, ...patch } : q)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-orange-100 bg-orange-50/60 p-3">
        <p className="max-w-2xl text-sm text-neutral-700">
          The Brief is what every stage is checked against: the donor&apos;s objectives and scoring criteria, the words they repeat, the must-haves, and each question with its
          word or character limit.
          {item.draft_brief?.decoded_at && <span className="text-neutral-500"> Last decoded {fmtDate(item.draft_brief.decoded_at.slice(0, 10))}{item.draft_brief.source ? ` from ${item.draft_brief.source}` : ""}.</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setShowPaste(!showPaste)} className={quietBtn}>
            {showPaste ? "Hide paste box" : "Paste the call / form"}
          </button>
          <button onClick={decode} disabled={decoding} className={accentBtn}>
            {decoding ? "Reading the call…" : "✨ Decode the call with Gemini"}
          </button>
        </div>
      </div>
      {showPaste && (
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={6}
          placeholder="Optional: paste the call text or the application form (questions and limits). Gemini reads this instead of the link."
          className={inputCls}
        />
      )}
      {message && <p className="text-sm text-emerald-700">{message}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <Labeled label="Donor objectives" hint="One per line, in the donor's words.">
          <textarea value={objectives} onChange={(e) => set(setObjectives)(e.target.value)} rows={4} className={inputCls} />
        </Labeled>
        <Labeled label="Scoring criteria" hint="One per line. Add a weight after a bar, e.g. “Impact | 30%”.">
          <textarea value={criteria} onChange={(e) => set(setCriteria)(e.target.value)} rows={4} className={inputCls} />
        </Labeled>
        <Labeled label="Donor keywords to echo" hint="Comma-separated. The Review tab checks the draft uses them.">
          <textarea value={keywords} onChange={(e) => set(setKeywords)(e.target.value)} rows={2} className={inputCls} />
        </Labeled>
        <Labeled label="Must-haves" hint="Mandatory sections, attachments, templates, formats, page limits — one per line.">
          <textarea value={mustHaves} onChange={(e) => set(setMustHaves)(e.target.value)} rows={2} className={inputCls} />
        </Labeled>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Questions and limits</p>
        {questions.length === 0 && <p className="text-sm text-neutral-400">No questions yet. Decode them from the call, or add them one by one.</p>}
        {questions.map((q, i) => (
          <div key={q.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 p-2">
            <span className="w-7 text-xs font-semibold text-neutral-400">Q{i + 1}</span>
            <input value={q.label} onChange={(e) => updateQ(q.id, { label: e.target.value })} placeholder="Question or section heading" className={`${baseInput} min-w-[220px] flex-1`} />
            <input
              type="number"
              min={0}
              value={q.limit ?? ""}
              onChange={(e) => updateQ(q.id, { limit: e.target.value ? Number(e.target.value) : null })}
              placeholder="Limit"
              className={`${baseInput} w-24`}
            />
            <select value={q.unit} onChange={(e) => updateQ(q.id, { unit: e.target.value as DraftQuestion["unit"] })} className={`${baseInput} w-auto`}>
              <option value="words">words</option>
              <option value="characters">characters</option>
            </select>
            <input value={q.criterion ?? ""} onChange={(e) => updateQ(q.id, { criterion: e.target.value || null })} placeholder="Serves which criterion?" className={`${baseInput} w-48`} />
            <button
              onClick={() => i > 0 && set(setQuestions)([...questions.slice(0, i - 1), q, questions[i - 1], ...questions.slice(i + 1)])}
              disabled={i === 0}
              className="text-neutral-300 hover:text-neutral-700 disabled:opacity-30"
              title="Move up"
            >
              ↑
            </button>
            <button
              onClick={() => confirm("Remove this question? Answers already written to it are kept in the database but no longer shown.") && set(setQuestions)(questions.filter((x) => x.id !== q.id))}
              className="text-neutral-300 hover:text-red-500"
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
        <button onClick={() => set(setQuestions)([...questions, { id: newQuestionId(), label: "", limit: null, unit: "words", criterion: null }])} className="w-fit text-xs font-medium text-[var(--accent)] hover:underline">
          + Add a question
        </button>
      </div>

      <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-neutral-100 bg-white pt-3">
        {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
        <button onClick={save} disabled={saving || !dirty} className={primaryBtn}>
          {saving ? "Saving…" : "Save Brief"}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── Draft ─────────────────────────

function DraftTab({
  item,
  stage,
  work,
  previous,
  onSave,
  onGoToBrief,
}: {
  item: TrackerItem;
  stage: DraftStage;
  work: DraftStageWork | null;
  previous: DraftStageWork | null;
  onSave: (patch: Partial<DraftStageWork>) => Promise<boolean>;
  onGoToBrief: () => void;
}) {
  const brief = item.draft_brief ?? emptyBrief();
  const [answers, setAnswers] = useState<Record<string, string>>(work?.answers ?? {});
  const [other, setOther] = useState(work?.draft_text ?? "");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const prev = prevStage(stage);
  const canCopy = !!previous && hasDraft(brief, previous) && !hasDraft(brief, { answers, draft_text: other });

  async function persist(nextAnswers = answers, nextOther = other) {
    const unchanged = JSON.stringify(nextAnswers) === JSON.stringify(work?.answers ?? {}) && (nextOther || null) === (work?.draft_text ?? null);
    if (unchanged) return;
    if (await onSave({ answers: nextAnswers, draft_text: nextOther.trim() ? nextOther : null })) setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }

  async function copyFromPrevious() {
    const c = carryForward(previous);
    setAnswers(c.answers);
    setOther(c.draft_text ?? "");
    await persist(c.answers, c.draft_text ?? "");
  }

  const total = brief.questions.reduce((n, q) => n + limitCheck(answers[q.id], q).count, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600">
          The {stageMeta(stage).label.toLowerCase()} — each stage keeps its own version. Saved when you click away from a box.
          {savedAt && <span className="ml-2 text-emerald-700">Saved ✓ {savedAt}</span>}
        </p>
        {canCopy && prev && (
          <button onClick={copyFromPrevious} className={quietBtn}>
            Start from the {stageMeta(prev).label.toLowerCase()}
          </button>
        )}
      </div>

      {brief.questions.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 p-3 text-sm text-neutral-500">
          No questions in the Brief yet, so the whole draft goes in one box below.{" "}
          <button onClick={onGoToBrief} className="font-medium text-[var(--accent)] hover:underline">
            Add the questions and their limits
          </button>{" "}
          to get a counter per answer.
        </div>
      )}

      {brief.questions.map((q, i) => {
        const value = answers[q.id] ?? "";
        const c = limitCheck(value, q);
        const pct = c.limit ? Math.min(100, Math.round((c.count / c.limit) * 100)) : 0;
        const prevAnswer = previous?.answers?.[q.id];
        return (
          <div key={q.id} className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-neutral-800">
                <span className="mr-1 text-neutral-400">Q{i + 1}.</span>
                {q.label}
                {q.criterion && <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-normal text-neutral-500">{q.criterion}</span>}
              </p>
              <span className={`text-xs ${LIMIT_STYLE[c.state]}`}>
                {c.label}
                {c.state === "over" && c.limit ? ` · ${c.count - c.limit} over` : ""}
              </span>
            </div>
            <textarea
              value={value}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              onBlur={() => persist()}
              rows={Math.min(14, Math.max(4, Math.ceil(value.length / 110)))}
              className={inputCls}
            />
            {c.limit && (
              <div className="h-1 overflow-hidden rounded-full bg-neutral-100">
                <div className={`h-full ${LIMIT_BAR[c.state]}`} style={{ width: `${pct}%` }} />
              </div>
            )}
            {prevAnswer && prevAnswer.trim() !== value.trim() && prev && (
              <details className="text-xs text-neutral-500">
                <summary className="cursor-pointer">Compare with the {stageMeta(prev).label.toLowerCase()}</summary>
                <p className="mt-1 whitespace-pre-wrap rounded bg-neutral-50 p-2">{prevAnswer}</p>
              </details>
            )}
          </div>
        );
      })}

      <Labeled label={brief.questions.length ? "Other text (cover note, annex text, anything outside the questions)" : "The draft"}>
        <textarea value={other} onChange={(e) => setOther(e.target.value)} onBlur={() => persist()} rows={brief.questions.length ? 4 : 16} className={inputCls} placeholder="Paste or write here…" />
      </Labeled>
      {brief.questions.length > 0 && <p className="text-right text-xs text-neutral-400">Total across the answers: {total.toLocaleString("en-US")} (words / characters as each question counts them)</p>}
    </div>
  );
}

// ───────────────────────── Review ─────────────────────────

function ReviewTab({
  item,
  stage,
  work,
  previous,
  notes,
  actions,
  learnings,
  guidance,
  viewer,
  onSave,
  onReviewed,
  onActionsAdded,
  onLearningAdded,
  onError,
}: {
  item: TrackerItem;
  stage: DraftStage;
  work: DraftStageWork | null;
  previous: DraftStageWork | null;
  notes: OpportunityNote[];
  actions: ActionItem[];
  learnings: DraftLearning[];
  guidance: DraftGuidance[];
  viewer: string | null;
  onSave: (patch: Partial<DraftStageWork>) => Promise<boolean>;
  onReviewed: (review: StageReview, reviewed_at: string) => void;
  onActionsAdded: (rows: ActionItem[]) => void;
  onLearningAdded: (l: DraftLearning) => void;
  onError: (m: string | null) => void;
}) {
  const meta = stageMeta(stage);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [kept, setKept] = useState<Set<number>>(new Set());
  const [stepsAddedFor, setStepsAddedFor] = useState<string | null>(null); // reviewed_at of the review whose steps were added
  const ticked = new Set(work?.checklist ?? []);
  const checks = localChecks(item.draft_brief, work, stage, stage === "concept" ? guidance.length : undefined);
  const review = work?.review ?? null;
  const drafted = hasDraft(item.draft_brief, work);

  async function toggle(id: string) {
    const next = ticked.has(id) ? [...ticked].filter((x) => x !== id) : [...ticked, id];
    await onSave({ checklist: next });
  }

  async function copyPrompt() {
    const prompt = buildClaudePrompt({ item, stage, work, previous, notes, actions, learnings, guidance });
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // still open the project
    }
    window.open(CLAUDE_PROJECT_URL, "_blank", "noopener,noreferrer");
  }

  async function runReview() {
    setRunning(true);
    setMessage(null);
    onError(null);
    const r = await postJson("/api/draft-review", { action: "review", trackerItemId: item.id, stage });
    setRunning(false);
    if (!r.ok || !r.json) return onError(r.error);
    onReviewed(r.json.review as StageReview, r.json.reviewed_at as string);
    const used = Number(r.json.learningsUsed ?? 0);
    setMessage(`Review saved.${used ? ` ${used} learning${used === 1 ? "" : "s"} from earlier applications were taken into account.` : ""}`);
  }

  async function addNextSteps() {
    if (!review?.next_steps.length || stepsAddedFor === work?.reviewed_at) return;
    const rows = review.next_steps.map((s) => ({ tracker_item_id: item.id, note_id: null, kind: "task", description: s, assignee: viewer, due_date: null, created_by: viewer, stage }));
    const { data, error } = await supabase.from("action_items").insert(rows).select();
    if (error) return onError(isMissingDraftTables(error.message) ? MIGRATION_HINT : error.message);
    onActionsAdded((data ?? []) as ActionItem[]);
    setStepsAddedFor(work?.reviewed_at ?? null);
    setMessage(`${rows.length} action point${rows.length === 1 ? "" : "s"} added under Meetings & actions${viewer ? `, assigned to ${viewer}` : ""}.`);
  }

  async function keepAsLearning(i: number, s: StageReview["suggestions"][number]) {
    const eff = effectiveFields(item);
    const lesson = `${s.issue}${s.suggestion ? ` → ${s.suggestion}` : ""}`.slice(0, 1500);
    const { data, error } = await supabase
      .from("draft_learnings")
      .insert({ tracker_item_id: item.id, stage, funder: eff.funder || null, lesson, tags: ["from review"], author: viewer })
      .select()
      .single();
    if (error) return onError(isMissingDraftTables(error.message) ? MIGRATION_HINT : error.message);
    onLearningAdded(data as DraftLearning);
    setKept((prev) => new Set(prev).add(i));
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      {/* left: checklist + automatic checks */}
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            {meta.icon} {meta.label} checklist · {meta.checklist.filter((c) => ticked.has(c.id)).length}/{meta.checklist.length}
          </p>
          {meta.checklist.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-start gap-2 text-sm text-neutral-700">
              <input type="checkbox" checked={ticked.has(c.id)} onChange={() => toggle(c.id)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
              <span className={ticked.has(c.id) ? "text-neutral-400 line-through" : ""}>{c.text}</span>
            </label>
          ))}
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Automatic checks</p>
          {checks.map((c) => (
            <div key={c.id} className="flex items-start gap-2 text-sm">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${STATUS_STYLE[c.status]}`}>{STATUS_ICON[c.status]}</span>
              <span>
                <strong className="font-medium text-neutral-800">{c.label}.</strong> <span className="text-neutral-600">{c.detail}</span>
              </span>
            </div>
          ))}
        </section>
        <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
          <p className="mb-1 font-medium text-neutral-800">What this stage&apos;s review looks for</p>
          <ul className="flex flex-col gap-0.5">
            {meta.reviewFocus.map((f) => (
              <li key={f}>• {f}</li>
            ))}
          </ul>
        </section>
      </div>

      {/* right: the two reviewers */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={runReview} disabled={running || !drafted} title={drafted ? undefined : "Write or paste the draft for this stage first"} className={accentBtn}>
            {running ? "Gemini is reviewing…" : review ? "✨ Re-run Gemini review" : "✨ Run Gemini review"}
          </button>
          <button onClick={copyPrompt} className={quietBtn} title="Copies a prompt with the Brief, the draft, the notes and learnings, and opens your BURN Grant Applications project in Claude">
            {copied ? "Copied ✓ — opening Claude…" : drafted ? "📋 Copy review prompt → Claude" : `📋 Copy ${stage === "concept" ? "concept-note" : "writing"} prompt → Claude`}
          </button>
        </div>
        {message && <p className="text-sm text-emerald-700">{message}</p>}
        {!review && (
          <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
            {drafted
              ? "No Gemini review yet for this stage. It checks the draft against the stage checklist, the Brief (criteria, keywords, limits), management's guidance, the meeting-note decisions and the learnings, and suggests better wording."
              : stage === "concept"
                ? "Nothing written yet. Use “Copy concept-note prompt → Claude” to draft the concept note in your Claude project, then paste it into the Draft tab and run the review."
                : "Nothing written for this stage yet. Lift the application here from the previous stage (its draft is copied over), or paste a draft in the Draft tab."}
          </p>
        )}
        {review && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4 rounded-lg border border-neutral-200 p-3">
              <Gauge value={review.readiness} />
              <div className="min-w-0">
                <p className="text-sm text-neutral-800">{review.summary}</p>
                {work?.reviewed_at && (
                  <p className="mt-1 text-[11px] text-neutral-400">
                    Reviewed {fmtDate(work.reviewed_at.slice(0, 10))} {new Date(work.reviewed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {review.model ? ` · ${review.model}` : ""}
                  </p>
                )}
              </div>
            </div>
            {review.checks.length > 0 && (
              <ReviewList title="Checks" rows={review.checks.map((c) => ({ status: c.status, head: c.item, body: c.comment }))} />
            )}
            {review.criteria_coverage.length > 0 && (
              <ReviewList title="Scoring criteria" rows={review.criteria_coverage.map((c) => ({ status: c.status, head: c.criterion, body: c.comment }))} />
            )}
            {review.suggestions.length > 0 && (
              <section className="flex flex-col gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Suggestions (framing, wording, evidence)</p>
                {review.suggestions.map((s, i) => (
                  <div key={i} className="rounded-lg border border-neutral-200 p-2.5 text-sm">
                    <p className="text-xs font-semibold text-neutral-500">{s.where}</p>
                    <p className="text-neutral-700">{s.issue}</p>
                    {s.suggestion && <p className="mt-1 rounded bg-emerald-50 p-2 text-emerald-900">{s.suggestion}</p>}
                    <div className="mt-1 flex justify-end">
                      <button onClick={() => keepAsLearning(i, s)} disabled={kept.has(i)} className="text-[11px] font-medium text-[var(--accent)] hover:underline disabled:text-emerald-700 disabled:no-underline">
                        {kept.has(i) ? "Kept as a learning ✓" : "💡 Keep as a learning"}
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}
            {review.missing.length > 0 && (
              <section>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Still to supply</p>
                <ul className="mt-1 text-sm text-neutral-700">
                  {review.missing.map((m) => (
                    <li key={m}>☐ {m}</li>
                  ))}
                </ul>
              </section>
            )}
            {review.next_steps.length > 0 && (
              <section>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Next steps</p>
                  <button onClick={addNextSteps} disabled={stepsAddedFor === work?.reviewed_at} className="text-xs font-medium text-[var(--accent)] hover:underline disabled:text-emerald-700 disabled:no-underline">
                    {stepsAddedFor === work?.reviewed_at ? "Added as action points ✓" : "+ Add as action points"}
                  </button>
                </div>
                <ol className="mt-1 list-decimal pl-5 text-sm text-neutral-700">
                  {review.next_steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Gauge({ value }: { value: number }) {
  const color = value >= 75 ? "#059669" : value >= 50 ? "#d97706" : "#dc2626";
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-16 w-16 shrink-0" title="How ready this stage is to lift, in Gemini's view">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#e5e5e5" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(value / 100) * c} ${c}`} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center text-sm font-semibold" style={{ color }}>
        {value}%<span className="text-[9px] font-normal text-neutral-400">ready</span>
      </span>
    </div>
  );
}

function ReviewList({ title, rows }: { title: string; rows: { status: ReviewStatus; head: string; body: string }[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</p>
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${STATUS_STYLE[r.status]}`}>{STATUS_ICON[r.status]}</span>
          <span>
            <strong className="font-medium text-neutral-800">{r.head}.</strong> <span className="text-neutral-600">{r.body}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

// ───────────────────────── Notes & learnings ─────────────────────────

function LearningsTab({
  item,
  stage,
  work,
  all,
  borrowed,
  viewer,
  onSaveNotes,
  onChange,
  onError,
}: {
  item: TrackerItem;
  stage: DraftStage;
  work: DraftStageWork | null;
  all: DraftLearning[];
  borrowed: DraftLearning[];
  viewer: string | null;
  onSaveNotes: (notes: string | null) => Promise<boolean>;
  onChange: (update: (prev: DraftLearning[]) => DraftLearning[]) => void;
  onError: (m: string | null) => void;
}) {
  const eff = effectiveFields(item);
  const [stageNotes, setStageNotes] = useState(work?.stage_notes ?? "");
  const [savedNotes, setSavedNotes] = useState(false);
  const [lesson, setLesson] = useState("");
  const [forFunder, setForFunder] = useState(true);
  const [forStage, setForStage] = useState<DraftStage | "">(stage);
  const [tags, setTags] = useState("");
  const [query, setQuery] = useState("");
  const [showLibrary, setShowLibrary] = useState(false);

  async function saveNotes() {
    if ((stageNotes.trim() || null) === (work?.stage_notes ?? null)) return;
    if (await onSaveNotes(stageNotes.trim() || null)) {
      setSavedNotes(true);
      window.setTimeout(() => setSavedNotes(false), 2000);
    }
  }

  async function addLearning() {
    if (!lesson.trim()) return;
    const { data, error } = await supabase
      .from("draft_learnings")
      .insert({
        tracker_item_id: item.id,
        stage: forStage || null,
        funder: forFunder ? eff.funder || null : null,
        lesson: lesson.trim(),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        author: viewer,
      })
      .select()
      .single();
    if (error) return onError(isMissingDraftTables(error.message) ? MIGRATION_HINT : error.message);
    onChange((prev) => [data as DraftLearning, ...prev]);
    setLesson("");
    setTags("");
  }

  async function remove(l: DraftLearning) {
    if (!confirm("Delete this learning for everyone?")) return;
    const { error } = await supabase.from("draft_learnings").delete().eq("id", l.id);
    if (error) return onError(error.message);
    onChange((prev) => prev.filter((x) => x.id !== l.id));
  }

  const q = query.trim().toLowerCase();
  const library = all.filter((l) => !q || [l.lesson, l.funder ?? "", ...l.tags].join(" ").toLowerCase().includes(q));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Notes on the {stageMeta(stage).label.toLowerCase()} {savedNotes && <span className="normal-case text-emerald-700">· saved ✓</span>}
        </p>
        <textarea
          value={stageNotes}
          onChange={(e) => setStageNotes(e.target.value)}
          onBlur={saveNotes}
          rows={10}
          placeholder="Anything about this stage: what management asked to change, the funder's feedback, reviewer comments still to settle, decisions and why… These go into the stage's prompts."
          className={inputCls}
        />

        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
          <p className="text-sm font-medium text-neutral-800">Add a learning</p>
          <p className="text-xs text-neutral-500">A lesson a future application should borrow — what a funder liked or disliked, what worked, what to avoid.</p>
          <textarea value={lesson} onChange={(e) => setLesson(e.target.value)} rows={3} placeholder="e.g. This funder scores gender-disaggregated targets highly — put them in the first paragraph." className={inputCls} />
          <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-600">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={forFunder} onChange={(e) => setForFunder(e.target.checked)} className="accent-[var(--accent)]" />
              About {eff.funder || "this funder"}
            </label>
            <label className="flex items-center gap-1.5">
              Stage
              <select value={forStage} onChange={(e) => setForStage(e.target.value as DraftStage | "")} className={`${baseInput} w-auto py-1 text-xs`}>
                <option value="">Any stage</option>
                {STAGES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma-separated" className={`${baseInput} w-44 py-1 text-xs`} />
            <button onClick={addLearning} disabled={!lesson.trim()} className={primaryBtn}>
              Save learning
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Borrowed for this application ({borrowed.length})</p>
        <p className="text-xs text-neutral-500">From this application first, then the same funder, then lessons for this stage and general ones. These are added to the review prompts automatically.</p>
        {borrowed.length === 0 && <p className="text-sm text-neutral-400">No learnings yet. Add one, or keep one from a Gemini review suggestion.</p>}
        {borrowed.map((l) => (
          <LearningRow key={l.id} l={l} here={l.tracker_item_id === item.id} onRemove={remove} />
        ))}
        <button onClick={() => setShowLibrary(!showLibrary)} className="mt-2 w-fit text-xs font-medium text-[var(--accent)] hover:underline">
          {showLibrary ? "Hide the learnings library" : `Browse the whole learnings library (${all.length})`}
        </button>
        {showLibrary && (
          <div className="flex flex-col gap-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search lessons, funders, tags…" className={inputCls} />
            {library.slice(0, 100).map((l) => (
              <LearningRow key={l.id} l={l} here={l.tracker_item_id === item.id} onRemove={remove} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function LearningRow({ l, here, onRemove }: { l: DraftLearning; here: boolean; onRemove: (l: DraftLearning) => void }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-2.5 text-sm">
      <p className="whitespace-pre-wrap text-neutral-700">{l.lesson}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
        {here && <span className="rounded-full bg-orange-50 px-2 py-0.5 font-medium text-[var(--accent)]">this application</span>}
        {l.funder && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{l.funder}</span>}
        {l.stage && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{stageMeta(l.stage).label}</span>}
        {l.tags.map((t) => (
          <span key={t} className="rounded-full bg-neutral-100 px-2 py-0.5">
            #{t}
          </span>
        ))}
        <span>
          {l.author ? `${l.author} · ` : ""}
          {fmtDate(l.created_at.slice(0, 10))}
        </span>
        <span className="flex-1" />
        <button onClick={() => onRemove(l)} className="text-neutral-300 hover:text-red-500" title="Delete">
          ✕
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── History ─────────────────────────

function HistoryTab({ history, works }: { history: DraftStageMove[]; works: DraftStageWork[] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Stage moves</p>
        {history.length === 0 && <p className="text-sm text-neutral-400">Not moved yet.</p>}
        <ol className="relative flex flex-col gap-3 border-l border-neutral-200 pl-4">
          {history.map((h) => (
            <li key={h.id} className="text-sm">
              <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-[var(--accent)]" />
              <p className="text-neutral-800">
                {h.from_stage ? `${stageMeta(h.from_stage).label} → ` : ""}
                <strong>{stageMeta(h.to_stage).label}</strong>
              </p>
              <p className="text-xs text-neutral-500">
                {fmtDate(h.moved_at.slice(0, 10))} {new Date(h.moved_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {h.moved_by ? ` · ${h.moved_by}` : ""}
              </p>
              {h.open_items.length > 0 && (
                <details className="mt-1 text-xs text-amber-800">
                  <summary className="cursor-pointer">Lifted with {h.open_items.length} item{h.open_items.length === 1 ? "" : "s"} still open</summary>
                  <ul className="mt-1 pl-2">
                    {h.open_items.map((o) => (
                      <li key={o}>☐ {o}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ol>
      </section>
      <section className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Each stage</p>
        {STAGES.map((s) => {
          const w = works.find((x) => x.stage === s.key);
          return (
            <div key={s.key} className="rounded-lg border border-neutral-200 p-2.5 text-sm">
              <p className="font-medium text-neutral-800">
                {s.icon} {s.label}
              </p>
              <p className="text-xs text-neutral-500">
                {w
                  ? [
                      `Last edited ${fmtDate(w.updated_at.slice(0, 10))}${w.updated_by ? ` by ${w.updated_by}` : ""}`,
                      `${s.checklist.filter((c) => w.checklist.includes(c.id)).length}/${s.checklist.length} ticked`,
                      w.review && w.reviewed_at ? `Gemini: ${w.review.readiness}% ready (${fmtDate(w.reviewed_at.slice(0, 10))})` : "No Gemini review",
                    ].join(" · ")
                  : "Not started"}
              </p>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[11px] text-neutral-400">{hint}</p>}
    </div>
  );
}
