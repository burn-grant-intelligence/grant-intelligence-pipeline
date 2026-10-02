"use client";

// Draft Application: every opportunity marked Fit (or forced in with "Draft
// anyway") sits on a board with three columns — Concept → First draft →
// Submitted — the same idea as Tracking → Drafting → Submitted on the
// Management Dashboard: count tiles on top, a staff filter, and every card has
// a toggle (or can be dragged) to move it between columns. The full workspace
// (Management guidance, Brief, Draft, Review, Meetings & actions, Notes &
// learnings, History) opens from the card.
// Stage logic and prompts: lib/drafting.ts. Gemini: app/api/draft-review.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabaseClient";
import { canonicalLead, effectiveFields, LEADS } from "@/lib/pipeline";
import {
  BOARD_COLUMNS, CLAUDE_PROJECT_URL, MIGRATION_HINT, buildClaudePrompt, carryForward, columnOf, daysLeftLabel, hasDraft, isMissingDraftTables,
  openItems, pickLearnings, planMove, prevStage, stageMeta, stageOf, type BoardColumn,
} from "@/lib/drafting";
import type { ActionItem, DraftGuidance, DraftLearning, DraftStage, DraftStageWork, OpportunityNote, TrackerItem } from "@/lib/types";
import DraftWorkspace, { LiftDialog, MoveToggle } from "@/components/DraftWorkspace";

// "Viewing as" — the same browser setting (same key and event) as the
// Application Tracker's picker, so choosing your name in either tab sets both.
const VIEWER_KEY = "grant-intelligence.viewer";
const VIEWER_EVENT = "grant-intelligence-viewer";
let viewerFallback: string | null = null;
function readViewer(): string | null {
  try {
    return canonicalLead(window.localStorage.getItem(VIEWER_KEY)) ?? viewerFallback;
  } catch {
    return viewerFallback;
  }
}
function writeViewer(value: string | null) {
  viewerFallback = value;
  try {
    if (value) window.localStorage.setItem(VIEWER_KEY, value);
    else window.localStorage.removeItem(VIEWER_KEY);
  } catch {
    // private browsing etc. — kept for this visit only
  }
  window.dispatchEvent(new Event(VIEWER_EVENT));
}
function subscribeViewer(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(VIEWER_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(VIEWER_EVENT, cb);
  };
}

type OwnerFilter = "all" | "unassigned" | string;
type PendingMove = { item: TrackerItem; to: BoardColumn };

const initials = (name: string) => name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();

export default function DraftApplication() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [works, setWorks] = useState<DraftStageWork[]>([]);
  const [guidance, setGuidance] = useState<DraftGuidance[]>([]);
  const [notes, setNotes] = useState<OpportunityNote[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [learnings, setLearnings] = useState<DraftLearning[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tablesMissing, setTablesMissing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [moving, setMoving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("all");
  const [dragOver, setDragOver] = useState<BoardColumn | null>(null);
  const viewer = useSyncExternalStore(subscribeViewer, readViewer, () => null);

  async function loadData() {
    setLoading(true);
    setError(null);
    // Only opportunities marked "Fit" in the Eligibility Tracker come here by
    // default; "Draft anyway" forces in an unreviewed or not-fit one. This is a
    // gate on fit_status/draft_override alone (see EligibilityTracker.tsx).
    // Submitted ones stay visible in the last column.
    const { data, error: fetchError } = await supabase
      .from("tracker_items")
      .select("*, grant:grants(*)")
      .in("status", ["tracking", "researching", "drafting", "submitted"])
      .or("fit_status.eq.fit,draft_override.eq.true")
      .order("updated_at", { ascending: false });
    if (fetchError) setError(fetchError.message);
    const list = (data as unknown as TrackerItem[]) ?? [];
    setItems(list);
    if (list.length) {
      const ids = list.map((i) => i.id);
      const [w, g, n, a, l] = await Promise.all([
        supabase.from("draft_stage_work").select("*").in("tracker_item_id", ids),
        supabase.from("draft_guidance").select("*").in("tracker_item_id", ids),
        supabase.from("opportunity_notes").select("*").in("tracker_item_id", ids),
        supabase.from("action_items").select("*").in("tracker_item_id", ids),
        supabase.from("draft_learnings").select("*").order("created_at", { ascending: false }).limit(500),
      ]);
      const missing = [w.error, g.error, l.error].find((e) => e && isMissingDraftTables(e.message));
      setTablesMissing(!!missing);
      const other = [w.error, g.error, n.error, a.error, l.error].find((e) => e && !isMissingDraftTables(e.message));
      if (other) setError(other.message);
      setWorks((w.data as DraftStageWork[]) ?? []);
      setGuidance((g.data as DraftGuidance[]) ?? []);
      setNotes((n.data as OpportunityNote[]) ?? []);
      setActions((a.data as ActionItem[]) ?? []);
      setLearnings((l.data as DraftLearning[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load once on mount
    loadData();
  }, []);

  const workFor = (itemId: string, stage: DraftStage) => works.find((w) => w.tracker_item_id === itemId && w.stage === stage) ?? null;

  function onWorkSaved(row: DraftStageWork) {
    setWorks((prev) => [...prev.filter((w) => !(w.tracker_item_id === row.tracker_item_id && w.stage === row.stage)), row]);
  }
  function onItemChange(id: string, patch: Partial<TrackerItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  // Move an application to another column. Concept → First draft copies the
  // concept's text across (each stage keeps its own version); First draft →
  // Submitted sets the tracker status and the submission date.
  async function doMove(move: PendingMove) {
    const { item } = move;
    const plan = planMove(item, move.to);
    if (!plan.ok) {
      setNotice(plan.reason);
      setPending(null);
      return;
    }
    setMoving(true);
    setError(null);
    const fromStage = stageOf(item);
    const fromWork = workFor(item.id, fromStage);
    const open = plan.forward || plan.to === "submitted" ? openItems(fromStage, fromWork, item.draft_brief) : [];
    try {
      if (plan.forward && hasDraft(item.draft_brief, fromWork) && !hasDraft(item.draft_brief, workFor(item.id, "first_draft"))) {
        const { data, error: e } = await supabase
          .from("draft_stage_work")
          .upsert({ tracker_item_id: item.id, stage: "first_draft", ...carryForward(fromWork), updated_by: viewer, updated_at: new Date().toISOString() }, { onConflict: "tracker_item_id,stage" })
          .select()
          .single();
        if (e) throw e;
        onWorkSaved(data as DraftStageWork);
      }
      const now = new Date().toISOString();
      const patch: Partial<TrackerItem> = { status: plan.status, ...(plan.stage ? { draft_stage: plan.stage, draft_stage_changed_at: now } : {}), ...(plan.submissionDate ? { submission_date: plan.submissionDate } : {}) };
      const { error: uErr } = await supabase.from("tracker_items").update({ ...patch, updated_at: now }).eq("id", item.id);
      if (uErr) throw uErr;
      onItemChange(item.id, patch);
      if (plan.stage && plan.stage !== fromStage) {
        const { error: hErr } = await supabase.from("draft_stage_history").insert({ tracker_item_id: item.id, from_stage: fromStage, to_stage: plan.stage, moved_by: viewer, open_items: open });
        if (hErr) console.warn("Stage history not saved:", hErr.message);
      }
      const label = BOARD_COLUMNS.find((c) => c.key === plan.to)?.label ?? plan.to;
      const name = effectiveFields(item).programName || "Opportunity";
      setNotice(
        plan.to === "submitted"
          ? `${name} marked as submitted. It shows as Submitted in the Application Tracker too. Good luck!${open.length ? ` ${open.length} item${open.length > 1 ? "s were" : " was"} still open.` : ""}`
          : `${name} moved to ${label}.${open.length ? ` ${open.length} item${open.length > 1 ? "s were" : " was"} still open and ${open.length > 1 ? "are" : "is"} noted in its History.` : ""}`
      );
      setPending(null);
    } catch (e) {
      const m = (e as { message?: string }).message ?? "Could not move it.";
      setError(isMissingDraftTables(m) ? MIGRATION_HINT : m);
    } finally {
      setMoving(false);
    }
  }

  function requestMove(item: TrackerItem, to: BoardColumn) {
    const plan = planMove(item, to);
    if (!plan.ok) return setNotice(plan.reason);
    // Going forward with something still open asks first; going back needs no warning.
    if ((plan.forward || plan.to === "submitted") && openItems(stageOf(item), workFor(item.id, stageOf(item)), item.draft_brief).length > 0) return setPending({ item, to });
    doMove({ item, to });
  }

  function promptFor(item: TrackerItem): string {
    const stage = stageOf(item);
    const prev = prevStage(stage);
    return buildClaudePrompt({
      item,
      stage,
      work: workFor(item.id, stage),
      previous: prev ? workFor(item.id, prev) : null,
      notes: notes.filter((n) => n.tracker_item_id === item.id),
      actions: actions.filter((a) => a.tracker_item_id === item.id),
      learnings: pickLearnings(learnings, { trackerItemId: item.id, funder: effectiveFields(item).funder, stage }),
      guidance: guidance.filter((g) => g.tracker_item_id === item.id),
    });
  }

  async function copyPrompt(item: TrackerItem) {
    try {
      await navigator.clipboard.writeText(promptFor(item));
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId((c) => (c === item.id ? null : c)), 2500);
    } catch {
      // Clipboard access can fail in some browser contexts — still open the project.
    }
    window.open(CLAUDE_PROJECT_URL, "_blank", "noopener,noreferrer");
  }

  const visible = useMemo(
    () =>
      items.filter((i) => {
        if (ownerFilter === "all") return true;
        const lead = canonicalLead(i.owner);
        return ownerFilter === "unassigned" ? !lead : lead === ownerFilter;
      }),
    [items, ownerFilter]
  );

  const byColumn = useMemo(() => {
    const map = new Map<BoardColumn, TrackerItem[]>(BOARD_COLUMNS.map((c) => [c.key, []]));
    for (const i of visible) map.get(columnOf(i))!.push(i);
    for (const [key, list] of map)
      list.sort((a, b) =>
        key === "submitted"
          ? (b.submission_date || "").localeCompare(a.submission_date || "")
          : (effectiveFields(a).deadline || "9999").localeCompare(effectiveFields(b).deadline || "9999")
      );
    return map;
  }, [visible]);

  const openItem = items.find((i) => i.id === openId) ?? null;
  const itemsForPending = pending ? stageOf(pending.item) : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="max-w-3xl">
          <h2 className="mb-1 text-lg font-semibold text-[var(--ink)]">Draft an application</h2>
          <p className="text-sm text-[var(--ink-muted)]">
            Start with what management wants, then write the <strong>Concept</strong> and the <strong>First draft</strong>. Open a card to record management&apos;s guidance, capture what the
            donor wants and the word limits, paste the draft, run a <strong>Gemini review</strong> or copy the stage prompt to Claude, and keep meeting notes and learnings. Use the toggle
            on a card (or drag it) to move it along.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--ink-muted)]">
          Viewing as
          <select value={viewer ?? ""} onChange={(e) => writeViewer(e.target.value || null)} className="rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-800">
            <option value="">Choose your name</option>
            {LEADS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </section>

      {tablesMissing && <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{MIGRATION_HINT}</div>}
      {error && <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-emerald-600 hover:text-emerald-900">
            ✕
          </button>
        </div>
      )}

      {/* count tiles, like the Management Dashboard */}
      <div className="grid grid-cols-3 gap-4">
        {BOARD_COLUMNS.map((c) => (
          <div key={c.key} className="rounded-lg border border-neutral-200 bg-white p-3 text-center">
            <p className={`text-2xl font-semibold ${c.key === "submitted" ? "text-emerald-600" : "text-neutral-800"}`}>{(byColumn.get(c.key) ?? []).length}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
              {c.icon} {c.label}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-white">Filter by staff</span>
        <Pill active={ownerFilter === "all"} onClick={() => setOwnerFilter("all")}>
          All staff
        </Pill>
        <Pill active={ownerFilter === "unassigned"} onClick={() => setOwnerFilter("unassigned")}>
          Unassigned
        </Pill>
        {LEADS.map((owner) => (
          <Pill key={owner} active={ownerFilter === owner} onClick={() => setOwnerFilter(owner)}>
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-neutral-200 text-[9px] font-bold text-neutral-700">{initials(owner)}</span>
            {owner.split(" ")[0]}
          </Pill>
        ))}
      </div>

      {!loading && !error && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center text-[var(--ink-muted)]">
          Nothing to draft yet — track an opportunity from the Grant Scanner, then mark it &ldquo;Fit&rdquo; in the Eligibility Tracker (or use its &ldquo;Draft anyway&rdquo; override to
          bring in an unreviewed one).
        </div>
      )}

      {items.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {BOARD_COLUMNS.map((col) => {
            const list = byColumn.get(col.key) ?? [];
            const meta = col.key === "submitted" ? null : stageMeta(col.key);
            return (
              <div
                key={col.key}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(col.key);
                }}
                onDragLeave={() => setDragOver((k) => (k === col.key ? null : k))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const item = items.find((i) => i.id === e.dataTransfer.getData("text/plain"));
                  if (item) requestMove(item, col.key);
                }}
                className={`flex min-w-0 flex-col gap-3 rounded-xl p-2 transition-colors ${dragOver === col.key ? "bg-[var(--accent-soft)] ring-2 ring-[var(--accent)]" : "bg-neutral-50"}`}
              >
                <div className="flex items-center justify-between px-1">
                  <span className="text-sm font-semibold text-neutral-700">
                    {col.icon} {meta?.label ?? col.label}
                  </span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-neutral-500">{list.length}</span>
                </div>
                <p className="px-1 text-xs leading-snug text-neutral-500">{meta ? meta.goal : "Sent to the funder. Move a card back to First draft if it has to be reopened."}</p>
                {list.length === 0 && <p className="rounded-lg border border-dashed border-neutral-200 p-4 text-center text-xs text-neutral-400">Nothing here</p>}
                {list.map((item) => (
                  <StageCard
                    key={item.id}
                    item={item}
                    work={workFor(item.id, stageOf(item))}
                    guidanceCount={guidance.filter((g) => g.tracker_item_id === item.id).length}
                    copied={copiedId === item.id}
                    busy={moving}
                    onOpen={() => setOpenId(item.id)}
                    onCopy={() => copyPrompt(item)}
                    onMove={(to) => requestMove(item, to)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {openItem && (
        <DraftWorkspace
          item={openItem}
          works={works.filter((w) => w.tracker_item_id === openItem.id)}
          guidance={guidance.filter((g) => g.tracker_item_id === openItem.id)}
          notes={notes.filter((n) => n.tracker_item_id === openItem.id)}
          actions={actions.filter((a) => a.tracker_item_id === openItem.id)}
          learnings={learnings}
          viewer={viewer}
          tablesMissing={tablesMissing}
          onClose={() => setOpenId(null)}
          onWorkSaved={onWorkSaved}
          onItemChange={(patch) => onItemChange(openItem.id, patch)}
          onRequestMove={(to) => requestMove(openItem, to)}
          onGuidanceChange={(update) => setGuidance((prev) => update(prev))}
          onNotesChange={(update) => setNotes((prev) => update(prev))}
          onActionsChange={(update) => setActions((prev) => update(prev))}
          onLearningsChange={(update) => setLearnings((prev) => update(prev))}
        />
      )}

      {pending && itemsForPending && (
        <LiftDialog
          title={effectiveFields(pending.item).programName || "This opportunity"}
          from={itemsForPending}
          to={pending.to}
          open={openItems(itemsForPending, workFor(pending.item.id, itemsForPending), pending.item.draft_brief)}
          busy={moving}
          onCancel={() => setPending(null)}
          onConfirm={() => doMove(pending)}
        />
      )}
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
        active ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
      }`}
    >
      {children}
    </button>
  );
}

function StageCard({
  item,
  work,
  guidanceCount,
  copied,
  busy,
  onOpen,
  onCopy,
  onMove,
}: {
  item: TrackerItem;
  work: DraftStageWork | null;
  guidanceCount: number;
  copied: boolean;
  busy: boolean;
  onOpen: () => void;
  onCopy: () => void;
  onMove: (to: BoardColumn) => void;
}) {
  const column = columnOf(item);
  const submitted = column === "submitted";
  const meta = stageMeta(stageOf(item));
  const eff = effectiveFields(item);
  const ticked = new Set(work?.checklist ?? []);
  const done = meta.checklist.filter((c) => ticked.has(c.id)).length;
  const pct = Math.round((done / meta.checklist.length) * 100);
  const due = submitted ? null : daysLeftLabel(eff.deadline);
  const readiness = work?.review?.readiness;

  return (
    <div draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", item.id)} className="flex cursor-grab flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm active:cursor-grabbing">
      <div className="min-w-0">
        {eff.funder && <p className="truncate text-[11px] text-[var(--ink-muted)]">{eff.funder}</p>}
        <button onClick={onOpen} className="text-left text-sm font-medium leading-snug text-[var(--ink)] hover:text-[var(--accent)]">
          {eff.programName || "(untitled grant)"}
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {submitted && item.submission_date && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Submitted {item.submission_date}</span>}
        {due && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${due.tone}`}>{due.text}</span>}
        {item.fit_status !== "fit" && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.fit_status === "not_fit" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
            {item.fit_status === "not_fit" ? "⚠ Not fit (override)" : "⚠ Unreviewed (override)"}
          </span>
        )}
        {guidanceCount > 0 && (
          <span title="Management guidance recorded" className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
            🧭 {guidanceCount}
          </span>
        )}
        {typeof readiness === "number" && !submitted && (
          <span
            title="Gemini's last review of this stage: how ready it is"
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${readiness >= 75 ? "bg-emerald-100 text-emerald-700" : readiness >= 50 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700"}`}
          >
            ✨ {readiness}% ready
          </span>
        )}
        {eff.lead && <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">{eff.lead}</span>}
      </div>
      {!submitted && (
        <div title={`${done} of ${meta.checklist.length} checklist items ticked`}>
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-[11px] text-neutral-500">
            {meta.short} checklist {done}/{meta.checklist.length}
          </p>
        </div>
      )}
      <MoveToggle column={column} disabled={busy} onMove={onMove} compact />
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={onOpen} className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700">
          Open workspace
        </button>
        {!submitted && (
          <button onClick={onCopy} title={`Copies the ${meta.label.toLowerCase()} prompt and opens your BURN Grant Applications project in Claude`} className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
            {copied ? "Copied ✓" : "📋 Claude"}
          </button>
        )}
        {item.clickup_url && (
          <a href={item.clickup_url} target="_blank" rel="noopener noreferrer" title="Open this opportunity in ClickUp" className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
            ClickUp ↗
          </a>
        )}
      </div>
    </div>
  );
}
