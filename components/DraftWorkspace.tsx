"use client";

// The workspace for one application in the Draft Application tab. Opens over
// the board for the stage the application is at (Concept, or First draft once
// it moves on):
//
//   ✨ Claude              — the stage's Claude chat: start it once, paste its link,
//                           and everyone opens the same chat (components/StageClaude.tsx).
//   Meeting notes          — meeting notes and action points with tagging, review
//                           and input requests (same as the Application Tracker).
//   Management guidance    — steer from management (role, countries, products,
//                           budget, red lines). Goes into the Claude prompt.
//   Donor guidance         — what the donor wants beyond the call text. Goes into the prompt.
//   Notes                  — the team's free notes for this stage. Go into the prompt.
//   History                — everything on this opportunity in one timeline.
// Moving an application between Concept, First draft and Submitted is done by
// dragging its card on the board.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { canonicalLead, effectiveFields, fmtDate, todayIso } from "@/lib/pipeline";
import { MIGRATION_HINT, columnOf, daysLeftLabel, donorGuidance, isMissingDraftTables, managementGuidance, stageMeta, stageOf } from "@/lib/drafting";
import { kindIcon } from "@/lib/collab";
import { ELIGIBILITY_CHECK, decisionOf, isReviewAction } from "@/lib/eligibilityReview";
import type { ActionItem, DraftGuidance, DraftStage, DraftStageMove, DraftStageWork, OpportunityNote, TrackerItem } from "@/lib/types";
import { NotesSection, useReplies } from "@/components/OpportunityBreakdown";
import { MentionText } from "@/components/Mentions";
import { PersonChip } from "@/components/EligibilityReview";
import StageClaude from "@/components/StageClaude";

type Tab = "meetings" | "management" | "donor" | "notes" | "history";
const TABS: { key: Tab; label: string }[] = [
  { key: "meetings", label: "🤝 Meeting notes" },
  { key: "management", label: "🧭 Management guidance" },
  { key: "donor", label: "🎯 Donor guidance" },
  { key: "notes", label: "📝 Notes" },
  { key: "history", label: "🕘 History" },
];

const baseInput = "rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-800 focus:border-[var(--accent)] focus:outline-none";
const inputCls = `${baseInput} w-full`;
const primaryBtn = "rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-40";

export default function DraftWorkspace({
  item,
  works,
  guidance,
  notes,
  actions,
  viewer,
  tablesMissing,
  prompt,
  onClose,
  onWorkSaved,
  onGuidanceChange,
  onNotesChange,
  onActionsChange,
}: {
  item: TrackerItem;
  works: DraftStageWork[];
  guidance: DraftGuidance[];
  notes: OpportunityNote[];
  actions: ActionItem[];
  viewer: string | null;
  tablesMissing: boolean;
  /** The current stage's Claude prompt. */
  prompt: () => string;
  onClose: () => void;
  onWorkSaved: (row: DraftStageWork) => void;
  onGuidanceChange: (update: (prev: DraftGuidance[]) => DraftGuidance[]) => void;
  onNotesChange: (update: (prev: OpportunityNote[]) => OpportunityNote[]) => void;
  onActionsChange: (update: (prev: ActionItem[]) => ActionItem[]) => void;
}) {
  const stage = stageOf(item);
  const column = columnOf(item);
  const submitted = column === "submitted";
  const [tab, setTab] = useState<Tab>("meetings");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<DraftStageMove[]>([]);
  const [replies] = useReplies([item.id]);
  const eff = effectiveFields(item);
  const opportunity = eff.programName || "(untitled opportunity)";
  const work = works.find((w) => w.stage === stage) ?? null;

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("draft_stage_history")
      .select("*")
      .eq("tracker_item_id", item.id)
      .order("moved_at", { ascending: false })
      .then(({ data }) => {
        if (!cancelled) setHistory((data as DraftStageMove[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.draft_stage, item.status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const due = submitted ? null : daysLeftLabel(eff.deadline);

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--ink)]/40 p-3 sm:p-6">
      <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-5xl flex-col gap-4 rounded-2xl bg-white p-4 shadow-2xl sm:p-6">
        {/* ── header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {eff.funder && <p className="text-xs text-[var(--ink-muted)]">{eff.funder}</p>}
            <h3 className="text-lg font-semibold leading-snug text-[var(--ink)]">{opportunity}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              {due && <span className={`rounded-full px-2 py-0.5 font-medium ${due.tone}`}>{due.text}</span>}
              {eff.deadline && <span>Deadline {fmtDate(eff.deadline)}</span>}
              {eff.lead ? <PersonChip name={eff.lead} prefix="Lead: " /> : <span>No lead yet</span>}
              {eff.link && (
                <a href={eff.link} target="_blank" rel="noopener noreferrer" className="underline decoration-neutral-300 hover:text-[var(--accent)]">
                  Call page ↗
                </a>
              )}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800" title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* ── the stage's Claude chat ── */}
        <StageClaude item={item} stage={stage} work={work} viewer={viewer} prompt={prompt} onSaved={onWorkSaved} readOnly={submitted} />

        {tablesMissing && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{MIGRATION_HINT}</div>}
        {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

        {/* ── tabs ── */}
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-neutral-200">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-[var(--accent)] font-semibold text-[var(--ink)]" : "border-transparent text-neutral-500 hover:text-neutral-800"}`}
            >
              {t.label}
              {t.key === "management" && managementGuidance(guidance).length > 0 && <span className="ml-1 text-xs text-neutral-400">({managementGuidance(guidance).length})</span>}
              {t.key === "donor" && donorGuidance(guidance).length > 0 && <span className="ml-1 text-xs text-neutral-400">({donorGuidance(guidance).length})</span>}
              {t.key === "notes" && work?.stage_notes?.trim() && <span className="ml-1 text-xs text-neutral-400">•</span>}
            </button>
          ))}
        </div>

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
            stage={stage}
          />
        )}
        {tab === "management" && <GuidanceTab kind="management" item={item} guidance={managementGuidance(guidance)} viewer={viewer} onChange={onGuidanceChange} onError={setError} />}
        {tab === "donor" && <GuidanceTab kind="donor" item={item} guidance={donorGuidance(guidance)} viewer={viewer} onChange={onGuidanceChange} onError={setError} />}
        {tab === "notes" && <StageNotes item={item} stage={stage} work={work} onSaved={onWorkSaved} onError={setError} readOnly={false} />}
        {tab === "history" && <HistoryTab item={item} notes={notes} actions={actions} replies={replies} moves={history} works={works} guidance={guidance} />}
      </div>
    </div>
  );
}

// ───────────────────────── Management and donor guidance ─────────────────────────
// One table, told apart by `source`: "Management…" is management's steer, the rest is the donor's.

const GUIDANCE_KINDS = {
  management: {
    sources: ["Management meeting", "Management email", "Management"],
    title: "Add management guidance",
    help: "What management wants before and during the writing: our role (lead or partner), countries, products, budget ceiling and red lines. It goes into the Claude prompt.",
    who: "Who said it (e.g. CEO)",
    placeholder: "e.g. Lead with Kenya and Tanzania only. Keep the budget under USD 250k and partner with county governments. Do not promise carbon credits.",
    list: "Management guidance",
  },
  donor: {
    sources: ["Donor call / RFP", "Donor meeting", "Donor email", "Other"],
    title: "Add donor guidance",
    help: "What the donor wants beyond the call text: priorities, what they score, red lines, word limits. It goes into the Claude prompt.",
    who: "Who said it (e.g. programme officer)",
    placeholder: "e.g. The donor wants women-led distribution and verified usage data. Maximum 2 pages. No carbon revenue in the budget.",
    list: "Donor guidance",
  },
} as const;

function GuidanceTab({
  kind,
  item,
  guidance,
  viewer,
  onChange,
  onError,
}: {
  kind: "management" | "donor";
  item: TrackerItem;
  guidance: DraftGuidance[];
  viewer: string | null;
  onChange: (update: (prev: DraftGuidance[]) => DraftGuidance[]) => void;
  onError: (m: string | null) => void;
}) {
  const [date, setDate] = useState(todayIso());
  const cfg = GUIDANCE_KINDS[kind];
  const [source, setSource] = useState<string>(cfg.sources[0]);
  const [givenBy, setGivenBy] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!text.trim()) return;
    setSaving(true);
    onError(null);
    const { data, error } = await supabase
      .from("draft_guidance")
      .insert({ tracker_item_id: item.id, guidance_date: date || todayIso(), source, given_by: givenBy.trim() || null, text: text.trim(), author: canonicalLead(viewer) })
      .select()
      .single();
    setSaving(false);
    if (error) return onError(isMissingDraftTables(error.message) ? MIGRATION_HINT : error.message);
    onChange((prev) => [...prev, data as DraftGuidance]);
    setText("");
    setGivenBy("");
  }

  async function remove(g: DraftGuidance) {
    if (!confirm("Delete this guidance for everyone?")) return;
    const { error } = await supabase.from("draft_guidance").delete().eq("id", g.id);
    if (error) return onError(error.message);
    onChange((prev) => prev.filter((x) => x.id !== g.id));
  }

  const sorted = [...guidance].sort((a, b) => b.guidance_date.localeCompare(a.guidance_date) || b.created_at.localeCompare(a.created_at));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
        <p className="text-sm font-medium text-neutral-800">{cfg.title}</p>
        <p className="text-xs text-neutral-500">{cfg.help}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${baseInput} w-40`} aria-label="Date" />
          <select value={source} onChange={(e) => setSource(e.target.value)} className={`${baseInput} w-auto`} aria-label="Where it came from">
            {cfg.sources.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <input value={givenBy} onChange={(e) => setGivenBy(e.target.value)} placeholder={cfg.who} className={`${baseInput} w-56`} />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          aria-label={cfg.list}
          placeholder={cfg.placeholder}
          className={inputCls}
        />
        <div className="flex justify-end">
          <button onClick={add} disabled={!text.trim() || saving} className={primaryBtn}>
            {saving ? "Saving…" : `Save ${kind} guidance`}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{cfg.list} ({guidance.length})</p>
        {sorted.length === 0 && <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">Nothing yet.</p>}
        {sorted.map((g) => (
          <div key={g.id} className="rounded-lg border border-neutral-200 p-2.5 text-sm">
            <p className="whitespace-pre-wrap text-neutral-800">
              <MentionText text={g.text} />
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
              <span className="rounded-full bg-orange-50 px-2 py-0.5 font-medium text-[var(--accent)]">{fmtDate(g.guidance_date)}</span>
              {g.source && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{g.source}</span>}
              {g.given_by && <span className="rounded-full bg-neutral-100 px-2 py-0.5">from {g.given_by}</span>}
              {g.author && <span>added by {g.author}</span>}
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

// ───────────────────────── Notes (go into the prompt) ─────────────────────────

function StageNotes({
  item,
  stage,
  work,
  onSaved,
  onError,
  readOnly,
}: {
  item: TrackerItem;
  stage: DraftStage;
  work: DraftStageWork | null;
  onSaved: (row: DraftStageWork) => void;
  onError: (m: string | null) => void;
  readOnly: boolean;
}) {
  const saved = work?.stage_notes ?? "";
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = text !== saved;

  async function save() {
    setSaving(true);
    onError(null);
    const { data, error } = await supabase
      .from("draft_stage_work")
      .upsert({ tracker_item_id: item.id, stage, stage_notes: text.trim() || null, updated_by: null, updated_at: new Date().toISOString() }, { onConflict: "tracker_item_id,stage" })
      .select()
      .single();
    setSaving(false);
    if (error) return onError(isMissingDraftTables(error.message) ? MIGRATION_HINT : error.message);
    onSaved(data as DraftStageWork);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 2500);
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
      <p className="text-sm font-medium text-neutral-800">Notes for this stage</p>
      <p className="text-xs text-neutral-500">
        Anything else Claude should know while writing: a point to stress, a figure to use, a story to tell, something to avoid. These notes go into the Claude prompt.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        aria-label="Notes for this stage"
        disabled={readOnly}
        placeholder="e.g. Open with the founding story. Stress the women-led distribution pilot in Kisumu. Use the 2025 impact figures, not the 2024 ones."
        className={inputCls}
      />
      <div className="flex items-center justify-end gap-3">
        {justSaved && <span className="text-xs text-emerald-600">Saved ✓</span>}
        <button onClick={save} disabled={!dirty || saving || readOnly} className={primaryBtn}>
          {saving ? "Saving…" : "Save notes"}
        </button>
      </div>
    </section>
  );
}

// ───────────────────────── History ─────────────────────────

type Kind = "notes" | "actions" | "eligibility" | "drafting";
type Entry = { key: string; at: string; kind: Kind; icon: string; who: string | null; where: string; text: string; extra?: string };

const KIND_LABELS: { key: Kind | "all"; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "notes", label: "📝 Meeting notes" },
  { key: "actions", label: "✔︎ Action points" },
  { key: "eligibility", label: "✅ Eligibility" },
  { key: "drafting", label: "✍️ Drafting" },
];

const stageWhere = (s: DraftStage | null | undefined) => (s ? `Draft · ${stageMeta(s).short}` : "Application Tracker");
const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fmtDate(iso);
  return /T/.test(iso) ? `${fmtDate(iso.slice(0, 10))}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : fmtDate(iso);
};
const VERDICT = { fit: "Fit", not_fit: "Not a fit", needs_review: "Needs further review" } as const;

/** Everything recorded on one opportunity, newest first. Exported for tests. */
export function historyEntries(input: {
  item: TrackerItem;
  notes: OpportunityNote[];
  actions: ActionItem[];
  replies: { id: string; action_id: string; author: string | null; body: string; created_at: string }[];
  moves: DraftStageMove[];
  works: DraftStageWork[];
  guidance: DraftGuidance[];
}): Entry[] {
  const { item, notes, actions, replies, moves, works, guidance } = input;
  const out: Entry[] = [];
  for (const n of notes) {
    out.push({ key: `n-${n.id}`, at: n.created_at || n.meeting_date, kind: "notes", icon: "📝", who: n.author, where: stageWhere(n.stage), text: n.notes, extra: `Meeting ${fmtDate(n.meeting_date)}` });
  }
  const byId = new Map(actions.map((a) => [a.id, a]));
  for (const a of actions) {
    const review = isReviewAction(a);
    const status = a.done ? "done" : a.assignee ? `open · for ${a.assignee}` : "open";
    out.push({
      key: `a-${a.id}`,
      at: a.created_at,
      kind: review ? "eligibility" : "actions",
      icon: review ? "👀" : kindIcon(a.kind) || "✔︎",
      who: a.created_by,
      where: review ? "Eligibility review" : stageWhere(a.stage),
      text: a.description,
      extra: status,
    });
  }
  for (const r of replies) {
    const a = byId.get(r.action_id);
    const review = !!a && isReviewAction(a);
    const decision = decisionOf(r.body);
    out.push({
      key: `r-${r.id}`,
      at: r.created_at,
      kind: review ? "eligibility" : "actions",
      icon: decision === "fit" ? "🟢" : decision === "not_fit" ? "🔴" : "💬",
      who: r.author,
      where: review ? "Eligibility review" : "Reply",
      text: r.body,
      extra: a ? `on: ${a.description.length > 90 ? `${a.description.slice(0, 89)}…` : a.description}` : undefined,
    });
  }
  const g = item.grant;
  if (g?.eligibility_checked_at && g.eligibility_verdict) {
    out.push({
      key: "elig",
      at: g.eligibility_checked_at,
      kind: "eligibility",
      icon: "✅",
      who: ELIGIBILITY_CHECK,
      where: "Eligibility check",
      text: `${VERDICT[g.eligibility_verdict]}${g.eligibility_report?.summary ? ` — ${g.eligibility_report.summary}` : ""}`,
    });
  }
  for (const m of moves) {
    out.push({ key: `m-${m.id}`, at: m.moved_at, kind: "drafting", icon: "➡️", who: m.moved_by, where: "Draft Application", text: `${m.from_stage ? `${stageMeta(m.from_stage).label} → ` : ""}${stageMeta(m.to_stage).label}` });
  }
  if (item.status === "submitted" && item.submission_date) {
    out.push({ key: "submitted", at: item.submission_date, kind: "drafting", icon: "📨", who: null, where: "Draft Application", text: "Submitted to the funder" });
  }
  for (const w of works) {
    if (w.claude_url && w.claude_url_at) {
      out.push({ key: `c-${w.id}`, at: w.claude_url_at, kind: "drafting", icon: "✨", who: w.claude_url_by ?? null, where: `Draft · ${stageMeta(w.stage).short}`, text: `Linked the ${stageMeta(w.stage).label.toLowerCase()} Claude chat`, extra: w.claude_url });
    } else if (w.claude_started_at) {
      out.push({ key: `cs-${w.id}`, at: w.claude_started_at, kind: "drafting", icon: "✨", who: w.claude_started_by ?? null, where: `Draft · ${stageMeta(w.stage).short}`, text: `Started the ${stageMeta(w.stage).label.toLowerCase()} in Claude` });
    }
  }
  for (const gd of guidance) {
    out.push({ key: `g-${gd.id}`, at: gd.created_at || gd.guidance_date, kind: "drafting", icon: "🧭", who: gd.author, where: `Guidance · ${gd.source ?? ""}`.replace(/ · $/, ""), text: gd.text, extra: gd.given_by ? `from ${gd.given_by}` : undefined });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function HistoryTab(props: Parameters<typeof historyEntries>[0]) {
  const [filter, setFilter] = useState<Kind | "all">("all");
  const entries = useMemo(() => historyEntries(props), [props]);
  const shown = filter === "all" ? entries : entries.filter((e) => e.kind === filter);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {KIND_LABELS.map((k) => {
          const n = k.key === "all" ? entries.length : entries.filter((e) => e.kind === k.key).length;
          return (
            <button
              key={k.key}
              onClick={() => setFilter(k.key)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === k.key ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"}`}
            >
              {k.label} ({n})
            </button>
          );
        })}
      </div>
      {shown.length === 0 && <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">Nothing recorded yet.</p>}
      <ol className="flex flex-col gap-2">
        {shown.map((e) => (
          <li key={e.key} className="flex gap-3 rounded-lg border border-neutral-200 p-2.5 text-sm">
            <span aria-hidden className="text-base leading-6">{e.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                {e.who && <PersonChip name={e.who} />}
                <span>{when(e.at)}</span>
                <span className="rounded-full bg-neutral-100 px-2 py-0.5">{e.where}</span>
                {e.extra && !e.extra.startsWith("http") && <span className="text-neutral-400">{e.extra}</span>}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-neutral-800">
                <MentionText text={e.text} />
              </p>
              {e.extra?.startsWith("http") && (
                <a href={e.extra} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--accent)] underline">
                  Open chat ↗
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
