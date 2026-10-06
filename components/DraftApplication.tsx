"use client";

// Draft Application: every opportunity marked Fit (or forced in with "Draft
// anyway") sits on a board — Concept → First draft → Submitted. Each card has
// two buttons: the stage's Claude chat (started once, then the same chat for
// everyone — components/StageClaude.tsx) and "Open workspace" (meeting notes &
// action points, donor guidance, and the full history — DraftWorkspace.tsx).
// "View as" (shared with the other tabs) narrows the board to one person's
// applications and the ones waiting on them; search finds any opportunity.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { canonicalLead, effectiveFields, firstName, LEADS, myOpenActions } from "@/lib/pipeline";
import {
  BOARD_COLUMNS, MIGRATION_HINT, buildClaudePrompt, carryForward, columnOf, daysLeftLabel, hasDraft, isMissingDraftTables,
  pickLearnings, planMove, prevStage, stageMeta, stageOf, type BoardColumn,
} from "@/lib/drafting";
import { searchWords } from "@/lib/opportunitySection";
import { setViewer, useViewer } from "@/lib/viewer";
import type { ActionItem, DraftGuidance, DraftLearning, DraftStage, DraftStageWork, OpportunityNote, TrackerItem } from "@/lib/types";
import DraftWorkspace, { MoveToggle } from "@/components/DraftWorkspace";
import StageClaude from "@/components/StageClaude";
import { PersonChip } from "@/components/EligibilityReview";

function matches(item: TrackerItem, words: string[]): boolean {
  if (!words.length) return true;
  const eff = effectiveFields(item);
  const g = item.grant;
  const hay = [eff.programName, eff.funder, eff.lead, g?.title, g?.funder, g?.geography, ...(g?.eligible_countries ?? []), ...(g?.focus_areas ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

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
  const [moving, setMoving] = useState(false);
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState<BoardColumn | null>(null);
  const viewer = useViewer();
  const me = canonicalLead(viewer);

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
    // "Remove & discard" in the Application Tracker hides an opportunity everywhere.
    const list = ((data as unknown as TrackerItem[]) ?? []).filter((i) => !i.removed_at);
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
    const t = setTimeout(loadData, 0);
    return () => clearTimeout(t);
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
  async function moveTo(item: TrackerItem, to: BoardColumn) {
    const plan = planMove(item, to);
    if (!plan.ok) {
      setNotice(plan.reason);
      return;
    }
    setMoving(true);
    setError(null);
    const fromStage = stageOf(item);
    const fromWork = workFor(item.id, fromStage);
    try {
      if (plan.forward && hasDraft(item.draft_brief, fromWork) && !hasDraft(item.draft_brief, workFor(item.id, "first_draft"))) {
        const { data, error: e } = await supabase
          .from("draft_stage_work")
          .upsert({ tracker_item_id: item.id, stage: "first_draft", ...carryForward(fromWork), updated_by: me, updated_at: new Date().toISOString() }, { onConflict: "tracker_item_id,stage" })
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
        const { error: hErr } = await supabase.from("draft_stage_history").insert({ tracker_item_id: item.id, from_stage: fromStage, to_stage: plan.stage, moved_by: me, open_items: [] });
        if (hErr) console.warn("Stage history not saved:", hErr.message);
      }
      const label = BOARD_COLUMNS.find((c) => c.key === plan.to)?.label ?? plan.to;
      const name = effectiveFields(item).programName || "Opportunity";
      setNotice(plan.to === "submitted" ? `${name} marked as submitted. It shows as Submitted in the Application Tracker too. Good luck!` : `${name} moved to ${label}.`);
    } catch (e) {
      const m = (e as { message?: string }).message ?? "Could not move it.";
      setError(isMissingDraftTables(m) ? MIGRATION_HINT : m);
    } finally {
      setMoving(false);
    }
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

  // The viewer's open action points (incl. review / input requests), per application.
  const mineById = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of myOpenActions(actions, viewer)) map.set(a.tracker_item_id, (map.get(a.tracker_item_id) ?? 0) + 1);
    return map;
  }, [actions, viewer]);

  // Search, then "View as": what they lead, plus anything waiting on them.
  const visible = useMemo(() => {
    const words = searchWords(search);
    const who = canonicalLead(viewer);
    return items.filter((i) => matches(i, words) && (!who || canonicalLead(i.owner) === who || mineById.has(i.id)));
  }, [items, search, viewer, mineById]);

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
  const myCount = me ? { leads: visible.filter((i) => canonicalLead(i.owner) === me).length, actions: visible.reduce((n, i) => n + (mineById.get(i.id) ?? 0), 0) } : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="mb-1 text-lg font-semibold text-[var(--ink)]">Draft an application</h2>
        <p className="text-sm text-[var(--ink-muted)]">
          Each card has two buttons: <strong>✨ Claude</strong> for the stage you&apos;re at (start the chat once, paste its link, and everyone opens the same chat) and{" "}
          <strong>Open workspace</strong> for meeting notes, action points, donor guidance and the history. Use the toggle (or drag the card) to move it along.
        </p>
      </section>

      {/* View as + search, like the other tabs */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
          View as
          <select
            value={me ?? ""}
            onChange={(e) => setViewer(e.target.value || null)}
            aria-label="View as"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
          >
            <option value="">Whole team</option>
            {LEADS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
          Search
          <span className="relative">
            <input
              type="text"
              enterKeyHint="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearch("")}
              placeholder="Title, funder, lead or country"
              aria-label="Search applications"
              className="w-full rounded-md border border-neutral-300 py-2 pl-8 pr-8 text-sm normal-case tracking-normal text-neutral-800 placeholder:text-neutral-400"
            />
            <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-neutral-400">⌕</span>
            {search && (
              <button type="button" onClick={() => setSearch("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1 text-base leading-none text-neutral-400 hover:text-neutral-700">
                ×
              </button>
            )}
          </span>
        </label>
        {myCount && (
          <p className="flex flex-wrap items-center gap-2 pb-2 text-sm text-neutral-700">
            <PersonChip name={me} /> leads <strong>{myCount.leads}</strong> here
            {myCount.actions > 0 && <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">✔︎ {myCount.actions} open for {firstName(me)}</span>}
          </p>
        )}
      </div>

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
                  if (item) moveTo(item, col.key);
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
                    viewer={viewer}
                    forMe={mineById.get(item.id) ?? 0}
                    busy={moving}
                    prompt={() => promptFor(item)}
                    onWorkSaved={onWorkSaved}
                    onOpen={() => setOpenId(item.id)}
                    onMove={(to) => moveTo(item, to)}
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
          viewer={viewer}
          tablesMissing={tablesMissing}
          prompt={() => promptFor(openItem)}
          onClose={() => setOpenId(null)}
          onWorkSaved={onWorkSaved}
          onRequestMove={(to) => moveTo(openItem, to)}
          onGuidanceChange={(update) => setGuidance((prev) => update(prev))}
          onNotesChange={(update) => setNotes((prev) => update(prev))}
          onActionsChange={(update) => setActions((prev) => update(prev))}
        />
      )}
    </div>
  );
}

function StageCard({
  item,
  work,
  viewer,
  forMe,
  busy,
  prompt,
  onWorkSaved,
  onOpen,
  onMove,
}: {
  item: TrackerItem;
  work: DraftStageWork | null;
  viewer: string | null;
  forMe: number;
  busy: boolean;
  prompt: () => string;
  onWorkSaved: (row: DraftStageWork) => void;
  onOpen: () => void;
  onMove: (to: BoardColumn) => void;
}) {
  const column = columnOf(item);
  const submitted = column === "submitted";
  const eff = effectiveFields(item);
  const due = submitted ? null : daysLeftLabel(eff.deadline);

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
        {eff.lead ? <PersonChip name={eff.lead} /> : <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">No lead</span>}
        {forMe > 0 && <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">✔︎ {forMe} for you</span>}
        {item.fit_status !== "fit" && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.fit_status === "not_fit" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
            {item.fit_status === "not_fit" ? "⚠ Not fit (override)" : "⚠ Unreviewed (override)"}
          </span>
        )}
      </div>
      <MoveToggle column={column} disabled={busy} onMove={onMove} compact />
      <StageClaude item={item} stage={stageOf(item)} work={work} viewer={viewer} prompt={prompt} onSaved={onWorkSaved} compact readOnly={submitted} />
      <button onClick={onOpen} className="self-start rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
        Open workspace
      </button>
    </div>
  );
}
