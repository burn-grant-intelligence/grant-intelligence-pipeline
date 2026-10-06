"use client";

// The "Breakdown" panel that opens under an opportunity in the Application
// Tracker. Two parts:
//   1. The pipeline fields (category, lead, status, programme, funder,
//      description, funding type, countries, products, ticket size, amount,
//      deadline, link, submission date). Each saves as soon as you leave the
//      field. "✨ Fill with Gemini" fills the ones still empty and
//      double-checks the link (app/api/opportunity-autofill/route.ts).
//   2. Meeting notes by date, each with its action points (who, what, by
//      when). Notes can be emailed from your own mail app, and a meeting
//      action point can be saved as a calendar invite so Outlook reminds you.
//      Typing a teammate's name (Hussein, @Sammy, @Everyone) tags them: it is
//      coloured as you type, a sentence tagging one person is offered as an
//      action point, and the person sees it in their desk
//      (components/TeamInbox.tsx). Action points can be review / input
//      requests, assigned to Everyone, and replied to (with tags).
// Everything entered here is what the Management Dashboard's "Opportunity
// pipeline" tab shows and exports to Excel.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  EVERYONE, FUNDING_TYPES, LEADS, PIPELINE_CATEGORIES, PIPELINE_STATUSES, PRODUCT_TYPES, STATUS_GROUPS,
  canonicalLead, cleanClickUpUrl, dueState, effectiveFields, emailOf, firstName, fmtDate, meetingIcs, money, notesEmailLink, todayIso, trackerStatusFor,
  type DueState,
} from "@/lib/pipeline";
import { mentionsIn, recipientsFor, suggestActions, tagColor } from "@/lib/mentions";
import {
  ACTION_KINDS, actionNotifications, friendlyError, kindIcon, kindLabel, noteNotifications, replyNotifications, sendNotifications,
  type NotificationDraft,
} from "@/lib/collab";
import { MentionText, MentionTextarea } from "@/components/Mentions";
import { normalizeStage } from "@/lib/drafting";
import { applyReviewPlan, fromLabel, leadChangePatch, openReviewFor, planReviewSync } from "@/lib/eligibilityReview";
import type { ActionItem, ActionKind, ActionReply, DraftStage, Grant, OpportunityNote, PipelineStatusCode, TrackerItem } from "@/lib/types";

// Short stage names for the badges on notes written in the Draft Application workspace.
const STAGE_BADGE: Record<DraftStage, string> = { concept: "💡 Concept", first_draft: "✍️ First draft" };

type ItemPatch = Partial<TrackerItem>;

export const DUE_STYLES: Record<DueState, string> = {
  overdue: "bg-red-100 text-red-700",
  today: "bg-orange-100 text-orange-700",
  soon: "bg-amber-100 text-amber-800",
  later: "bg-neutral-100 text-neutral-600",
  none: "bg-neutral-100 text-neutral-500",
  done: "bg-emerald-100 text-emerald-700",
};
export function dueText(a: ActionItem) {
  const st = dueState(a);
  if (st === "done") return "Done";
  if (!a.due_date) return "No date";
  if (st === "overdue") return `Overdue · ${fmtDate(a.due_date)}`;
  if (st === "today") return "Due today";
  return `Due ${fmtDate(a.due_date)}`;
}

export function downloadIcs(a: ActionItem, opportunity: string) {
  if (!a.due_date) return;
  const ics = meetingIcs({
    uid: a.id,
    title: `${a.kind === "meeting" ? `Meeting${a.meeting_with ? ` with ${a.meeting_with}` : ""}` : "Action"} – ${opportunity}`,
    description: `${a.description}\n\nOpportunity: ${opportunity}`,
    date: a.due_date,
    attendees: [emailOf(a.assignee)].filter(Boolean) as string[],
  });
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${(a.meeting_with || opportunity).replace(/[^\w\- ]+/g, "").slice(0, 40) || "meeting"}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function OpportunityBreakdown({
  item,
  viewer,
  notes,
  actions,
  onItemChange,
  onGrantChange,
  onNotesChange,
  onActionsChange,
}: {
  item: TrackerItem;
  viewer: string | null;
  notes: OpportunityNote[];
  actions: ActionItem[];
  onItemChange: (patch: ItemPatch) => void;
  onGrantChange: (patch: Partial<Grant>) => void;
  onNotesChange: (update: (prev: OpportunityNote[]) => OpportunityNote[]) => void;
  onActionsChange: (update: (prev: ActionItem[]) => ActionItem[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);
  const [fillMessage, setFillMessage] = useState<string | null>(null);
  // Bumped after Gemini fills fields so the inputs show the new values.
  const [version, setVersion] = useState(0);
  const eff = effectiveFields(item);
  const grant = item.grant;
  const opportunity = eff.programName || "(untitled opportunity)";

  async function save(patch: ItemPatch) {
    setError(null);
    const { error: e } = await supabase.from("tracker_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", item.id);
    if (e) {
      setError(
        /clickup_url/i.test(e.message)
          ? "The ClickUp link column is missing — run supabase/draft_stages_migration_2026-10-02.sql in Supabase first."
          : /pipeline_|program_name|ticket_size|target_countries|product_types|submission_date|schema cache/i.test(e.message)
            ? "The Opportunity Pipeline columns are missing — run supabase/opportunity_pipeline_migration_2026-10-01.sql in Supabase first."
            : e.message
      );
      return false;
    }
    onItemChange(patch);
    return true;
  }

  const saveText = (field: keyof TrackerItem, raw: string) => {
    const value = raw.trim() || null;
    if ((item[field] ?? null) === value) return;
    save({ [field]: value } as ItemPatch);
  };

  // Picking a lead links them to the opportunity's eligibility review: if the
  // check said "Needs further review", they get the 👀 review action point
  // (or the open one moves to them from the previous lead).
  async function saveLead(owner: string | null) {
    const oldLead = item.owner;
    if (!(await save({ owner }))) return;
    const summary = grant?.eligibility_report?.summary;
    const open = openReviewFor(item.id, actions);
    const patch = leadChangePatch(open, oldLead, owner, summary);
    if (open && patch) {
      const { error: e } = await supabase.from("action_items").update(patch).eq("id", open.id);
      if (e) return setError(e.message);
      onActionsChange((prev) => prev.map((a) => (a.id === open.id ? { ...a, ...patch } : a)));
      return;
    }
    const res = await applyReviewPlan(supabase, planReviewSync([{ ...item, owner }], actions));
    if (res.error) setError(res.error);
    if (res.created.length) onActionsChange((prev) => [...prev, ...res.created]);
  }

  async function saveStatus(code: string) {
    if (!code) return save({ pipeline_status: null });
    const status = trackerStatusFor(code as PipelineStatusCode, item.status);
    save({ pipeline_status: code as PipelineStatusCode, status });
  }

  async function saveFundingType(value: string) {
    if (!grant) return;
    const { error: e } = await supabase.from("grants").update({ type_of_funding: value || null }).eq("id", grant.id);
    if (e) return setError(e.message);
    onGrantChange({ type_of_funding: value || null });
  }

  function toggleProduct(p: string) {
    const current = item.product_types ?? [];
    const next = current.includes(p) ? current.filter((x) => x !== p) : [...current, p];
    save({ product_types: next.length ? next : null });
  }

  async function fillWithGemini() {
    setFilling(true);
    setFillMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/opportunity-autofill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackerItemId: item.id }),
      });
      // Read as text first: when the server crashes, times out or the route is
      // missing, the reply is an HTML/plain-text page, not JSON.
      const raw = await res.text();
      let json: { error?: string; tracker?: unknown; grant?: Record<string, unknown>; filled?: string[] } | null = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      if (!json) {
        const snippet = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
        if (res.status === 404) {
          setError("The server has no /api/opportunity-autofill route yet (HTTP 404). Check that app/api/opportunity-autofill/route.ts is on GitHub and that the latest Vercel deployment finished successfully.");
        } else if (res.status === 504 || res.status === 408 || /TIMEOUT/i.test(raw)) {
          setError(`The request timed out on the server (HTTP ${res.status}) — reading the page and asking Gemini took too long. Try again, or check the Vercel function logs for /api/opportunity-autofill.`);
        } else if (res.status === 401 || res.status === 403) {
          setError(`The server refused the request (HTTP ${res.status}). If Vercel Deployment Protection is on, the API route needs the same access as the rest of the site.`);
        } else {
          setError(`The server returned an unexpected reply (HTTP ${res.status})${snippet ? `: "${snippet}"` : ""}. Check the Vercel function logs for /api/opportunity-autofill.`);
        }
        return;
      }
      if (!res.ok) {
        setError(json.error ?? `Gemini could not fill this in (HTTP ${res.status}).`);
        return;
      }
      onItemChange(json.tracker as ItemPatch);
      if (json.grant && Object.keys(json.grant).length) onGrantChange(json.grant);
      setVersion((v) => v + 1);
      const n = (json.filled ?? []).length;
      setFillMessage(n ? `Filled ${n} empty field${n > 1 ? "s" : ""}. Nothing you typed was changed.` : "Nothing new to fill — the empty fields weren't stated on the page.");
    } catch (err) {
      setError(`Could not reach the app's server${err instanceof Error && err.message ? ` (${err.message})` : ""}. Check your internet connection and that the site is deployed, then try again.`);
    } finally {
      setFilling(false);
    }
  }

  const k = (name: string) => `${name}-${version}`;

  return (
    <div className="flex flex-col gap-5 border-t border-neutral-100 pt-4">
      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* ── 1. Breakdown fields ── */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Breakdown</h4>
          <div className="flex items-center gap-2">
            {fillMessage && <span className="text-xs text-emerald-700">{fillMessage}</span>}
            <button
              onClick={fillWithGemini}
              disabled={filling}
              title="Reads the opportunity's page and fills the fields that are still empty. Also double-checks the link."
              className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent)] hover:bg-orange-50 disabled:cursor-wait disabled:opacity-50"
            >
              {filling ? "Reading the opportunity…" : "✨ Fill with Gemini"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Category">
            <select value={item.pipeline_category ?? ""} onChange={(e) => save({ pipeline_category: (e.target.value || null) as TrackerItem["pipeline_category"] })} className={inputCls}>
              <option value="">Select…</option>
              {PIPELINE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Lead">
            <select value={canonicalLead(item.owner) ?? ""} onChange={(e) => saveLead(e.target.value || null)} className={inputCls}>
              <option value="">Unassigned</option>
              {LEADS.map((n) => <option key={n} value={n}>{n}</option>)}
              {item.owner && !LEADS.includes(canonicalLead(item.owner)!) && <option value={item.owner}>{item.owner}</option>}
            </select>
          </Field>
          <Field label="Status" hint="Also moves the card on the Management Dashboard board.">
            <select value={item.pipeline_status ?? ""} onChange={(e) => saveStatus(e.target.value)} className={inputCls}>
              <option value="">Select…</option>
              {STATUS_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {PIPELINE_STATUSES.filter((s) => s.group === g).map((s) => <option key={s.code} value={s.code}>{s.code}. {s.label}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field label="Program name">
            <input key={k("program")} defaultValue={item.program_name ?? ""} placeholder={grant?.title ?? ""} onBlur={(e) => saveText("program_name", e.target.value)} className={inputCls} />
          </Field>
          <Field label="Funder">
            <input key={k("funder")} defaultValue={item.pipeline_funder ?? ""} placeholder={grant?.funder ?? ""} onBlur={(e) => saveText("pipeline_funder", e.target.value)} className={inputCls} />
          </Field>
          <Field label="Type of funding">
            <select value={grant?.type_of_funding ?? ""} onChange={(e) => saveFundingType(e.target.value)} className={inputCls} disabled={!grant}>
              <option value="">Select…</option>
              {FUNDING_TYPES.map((f) => <option key={f} value={f}>{f}</option>)}
              {grant?.type_of_funding && !(FUNDING_TYPES as readonly string[]).includes(grant.type_of_funding) && <option value={grant.type_of_funding}>{grant.type_of_funding}</option>}
            </select>
          </Field>

          <Field label="Ticket size">
            <input key={k("ticket")} defaultValue={item.ticket_size ?? ""} placeholder={grant?.amount ? money(grant.amount, grant.currency ?? "USD") : "e.g. USD 100k – 1M per project"} onBlur={(e) => saveText("ticket_size", e.target.value)} className={inputCls} />
          </Field>
          <Field label="Requested amount (USD)">
            <input
              key={k("requested")}
              type="number"
              min="0"
              defaultValue={item.requested_amount_usd ?? ""}
              placeholder="e.g. 500000"
              onBlur={(e) => {
                const v = e.target.value.trim();
                const n = v ? Number(v) : null;
                if (n !== null && Number.isNaN(n)) return setError("Requested amount must be a number.");
                if ((item.requested_amount_usd ?? null) !== n) save({ requested_amount_usd: n });
              }}
              className={inputCls}
            />
          </Field>
          <Field label="Target country/ies" hint="Separate with commas.">
            <input
              key={k("countries")}
              defaultValue={(item.target_countries ?? []).join(", ")}
              placeholder={grant?.eligible_countries?.join(", ") ?? "e.g. Kenya, Uganda"}
              onBlur={(e) => {
                const list = [...new Set(e.target.value.split(",").map((c) => c.trim()).filter(Boolean))];
                if (list.join("|") !== (item.target_countries ?? []).join("|")) save({ target_countries: list.length ? list : null });
              }}
              className={inputCls}
            />
          </Field>

          <Field label="Deadline" hint={!item.pipeline_deadline && grant?.deadline ? `From the grant record: ${fmtDate(grant.deadline)}` : undefined}>
            <input key={k("deadline")} type="date" defaultValue={item.pipeline_deadline ?? ""} onBlur={(e) => saveText("pipeline_deadline", e.target.value)} className={inputCls} />
          </Field>
          <Field label="Submission date">
            <input key={k("submitted")} type="date" defaultValue={item.submission_date ?? ""} onBlur={(e) => saveText("submission_date", e.target.value)} className={inputCls} />
          </Field>
          <Field label="Link" hint="The link you put here is the one the eligibility check and ✨ Fill with Gemini read. It is never replaced automatically.">
            <input key={k("link")} type="url" defaultValue={item.pipeline_link ?? ""} placeholder={eff.link || "https://…"} onBlur={(e) => saveText("pipeline_link", e.target.value)} className={inputCls} />
            {item.link_check_note && (
              <p className={`mt-1 text-xs ${item.link_check_note.startsWith("Link checked") ? "text-emerald-700" : "text-amber-700"}`}>
                {item.link_check_note.startsWith("Link checked") ? "✓ " : "⚠ "}
                {item.link_check_note}
                {item.link_checked_at ? ` (${fmtDate(item.link_checked_at.slice(0, 10))})` : ""}
              </p>
            )}
          </Field>
          <Field label="ClickUp" hint="Paste this opportunity's ClickUp task or list link. Shown as an “Open in ClickUp” button here and in Draft Application.">
            <div className="flex items-center gap-2">
              <input
                key={k("clickup")}
                type="url"
                defaultValue={item.clickup_url ?? ""}
                placeholder="https://app.clickup.com/t/…"
                onBlur={(e) => {
                  const raw = e.target.value;
                  const clean = cleanClickUpUrl(raw);
                  if (raw.trim() && !clean) return setError("That doesn't look like a web link — paste the ClickUp task or list URL (starting with https://).");
                  if ((item.clickup_url ?? null) !== clean) save({ clickup_url: clean });
                }}
                className={`${inputCls} flex-1`}
              />
              {item.clickup_url && (
                <a href={item.clickup_url} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
                  Open ↗
                </a>
              )}
            </div>
          </Field>
        </div>

        <Field label="Description">
          <textarea key={k("description")} rows={4} defaultValue={item.pipeline_description ?? ""} placeholder={grant?.description ?? "What the opportunity funds, who can apply, size and timeline…"} onBlur={(e) => saveText("pipeline_description", e.target.value)} className={inputCls} />
        </Field>

        <Field label="Product type" hint="Select one or more.">
          <div className="flex flex-wrap gap-2">
            {PRODUCT_TYPES.map((p) => {
              const on = (item.product_types ?? []).includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleProduct(p)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400"}`}
                >
                  {on ? "✓ " : ""}{p}
                </button>
              );
            })}
          </div>
        </Field>
      </section>

      {/* ── 2. Meeting notes & action points ── */}
      <NotesSection
        item={item}
        opportunity={opportunity}
        viewer={viewer}
        notes={notes}
        actions={actions}
        onNotesChange={onNotesChange}
        onActionsChange={onActionsChange}
        onError={setError}
      />
    </div>
  );
}

// ───────────────────────── notes & action points ─────────────────────────

type DraftAction = { kind: ActionKind; description: string; meeting_with: string; assignee: string; due_date: string; autoAssign: boolean };
// The assignee follows the person tagged in the text until you pick one yourself.
const emptyDraft = (viewer: string | null, over: Partial<DraftAction> = {}): DraftAction => ({ kind: "task", description: "", meeting_with: "", assignee: viewer ?? "", due_date: "", autoAssign: true, ...over });

function withAutoAssign(d: DraftAction, viewer: string | null): DraftAction {
  if (!d.autoAssign) return d;
  const people = mentionsIn(d.description);
  const tagged = people.length === 1 ? people[0] : null;
  return { ...d, assignee: tagged ?? viewer ?? "" };
}

// Replies on the action points of these opportunities (action_replies).
function useReplies(trackerItemIds: string[]) {
  const [replies, setReplies] = useState<ActionReply[]>([]);
  const key = trackerItemIds.join(",");
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    supabase
      .from("action_replies")
      .select("*")
      .in("tracker_item_id", key.split(","))
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (!cancelled) setReplies((data ?? []) as ActionReply[]);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return [replies, setReplies] as const;
}
export { useReplies };

// Also used by the Draft Application workspace (components/DraftWorkspace.tsx)
// with `stage`: new notes and action points are tagged with that stage, and
// the list can be narrowed to it.
export function NotesSection({
  item,
  opportunity,
  viewer,
  notes,
  actions,
  onNotesChange,
  onActionsChange,
  onError,
  stage,
}: {
  item: TrackerItem;
  opportunity: string;
  viewer: string | null;
  notes: OpportunityNote[];
  actions: ActionItem[];
  onNotesChange: (update: (prev: OpportunityNote[]) => OpportunityNote[]) => void;
  onActionsChange: (update: (prev: ActionItem[]) => ActionItem[]) => void;
  onError: (msg: string | null) => void;
  stage?: DraftStage;
}) {
  const [adding, setAdding] = useState(false);
  const [onlyStage, setOnlyStage] = useState(false); // start with everything, incl. Application Tracker meetings
  const [meetingDate, setMeetingDate] = useState(todayIso());
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<DraftAction[]>([]);
  const [saving, setSaving] = useState(false);
  const [quick, setQuick] = useState<DraftAction | null>(null);
  const [replies, setReplies] = useReplies([item.id]);
  const [sent, setSent] = useState<string | null>(null);

  const narrow = !!stage && onlyStage;
  const shownNotes = narrow ? notes.filter((n) => n.stage && normalizeStage(n.stage) === stage) : notes;
  const sortedNotes = [...shownNotes].sort((a, b) => b.meeting_date.localeCompare(a.meeting_date) || b.created_at.localeCompare(a.created_at));
  const looseActions = actions.filter((a) => (!a.note_id || !notes.some((n) => n.id === a.note_id)) && (!narrow || (a.stage && normalizeStage(a.stage) === stage)));
  const missingTables = (m: string) =>
    /opportunity_notes|action_items|schema cache|does not exist|permission denied/i.test(m) && !/kind|replies|notifications/i.test(m)
      ? "The notes tables are missing or locked — run supabase/opportunity_pipeline_migration_2026-10-01.sql in Supabase first."
      : stage && /stage/i.test(m)
        ? "The notes can't be tagged with a stage yet — run supabase/draft_stages_migration_2026-10-02.sql in Supabase first."
        : friendlyError(m);

  // Sentences in the notes that tag one person, not yet added as action points.
  const suggestions = suggestActions(text).filter((s) => !drafts.some((d) => d.description.trim() === s.description));

  const toRow = (d: DraftAction, noteId: string | null) => ({
    tracker_item_id: item.id,
    note_id: noteId,
    kind: d.kind,
    description: d.description.trim(),
    meeting_with: d.kind === "meeting" ? d.meeting_with.trim() || null : null,
    assignee: d.assignee || null,
    due_date: d.due_date || null,
    created_by: viewer,
    ...(stage ? { stage } : {}),
  });

  // Tagged people hear about it in their desk.
  async function notify(drafts: NotificationDraft[]) {
    const err = await sendNotifications(drafts);
    if (err) return onError(err);
    const people = [...new Set(drafts.map((d) => firstName(d.recipient)))];
    setSent(people.length ? `Tagged ${people.join(", ")} — they'll see it in their desk.` : null);
  }

  async function saveNote() {
    if (!text.trim()) return;
    setSaving(true);
    onError(null);
    const { data: note, error } = await supabase
      .from("opportunity_notes")
      .insert({ tracker_item_id: item.id, meeting_date: meetingDate, notes: text.trim(), author: viewer, ...(stage ? { stage } : {}) })
      .select()
      .single();
    if (error || !note) {
      setSaving(false);
      return onError(missingTables(error?.message ?? "Could not save the notes."));
    }
    onNotesChange((prev) => [note as OpportunityNote, ...prev]);
    const pending: NotificationDraft[] = noteNotifications(note as OpportunityNote, viewer);
    const rows = drafts.filter((d) => d.description.trim()).map((d) => toRow(d, note.id));
    if (rows.length) {
      const { data: saved, error: aErr } = await supabase.from("action_items").insert(rows).select();
      if (aErr) onError(missingTables(aErr.message));
      else {
        const list = (saved ?? []) as ActionItem[];
        onActionsChange((prev) => [...prev, ...list]);
        // someone tagged in the notes AND an action point hears about it once
        for (const a of list) for (const n of actionNotifications(a, viewer)) if (!pending.some((p) => p.recipient === n.recipient)) pending.push(n);
      }
    }
    await notify(pending);
    setSaving(false);
    setAdding(false);
    setText("");
    setDrafts([]);
    setMeetingDate(todayIso());
  }

  async function saveQuick() {
    if (!quick || !quick.description.trim()) return;
    const { data, error } = await supabase.from("action_items").insert(toRow(quick, null)).select().single();
    if (error) return onError(missingTables(error.message));
    onActionsChange((prev) => [...prev, data as ActionItem]);
    setQuick(null);
    await notify(actionNotifications(data as ActionItem, viewer));
  }

  async function toggleDone(a: ActionItem) {
    const patch = { done: !a.done, done_at: !a.done ? new Date().toISOString() : null };
    const { error } = await supabase.from("action_items").update(patch).eq("id", a.id);
    if (error) return onError(missingTables(error.message));
    onActionsChange((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...patch } : x)));
  }

  async function removeAction(a: ActionItem) {
    if (!confirm("Delete this action point?")) return;
    const { error } = await supabase.from("action_items").delete().eq("id", a.id);
    if (error) return onError(missingTables(error.message));
    onActionsChange((prev) => prev.filter((x) => x.id !== a.id));
  }

  async function removeNote(n: OpportunityNote) {
    if (!confirm(`Delete the notes from ${fmtDate(n.meeting_date)}? Their action points are kept.`)) return;
    const { error } = await supabase.from("opportunity_notes").delete().eq("id", n.id);
    if (error) return onError(missingTables(error.message));
    onNotesChange((prev) => prev.filter((x) => x.id !== n.id));
    onActionsChange((prev) => prev.map((x) => (x.note_id === n.id ? { ...x, note_id: null } : x)));
  }

  const row = (a: ActionItem) => (
    <ActionRow
      key={a.id}
      a={a}
      opportunity={opportunity}
      viewer={viewer}
      onToggle={toggleDone}
      onRemove={removeAction}
      replies={replies.filter((r) => r.action_id === a.id)}
      onReplied={(r) => setReplies((prev) => [...prev, r])}
      onError={onError}
    />
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Meeting notes &amp; action points</h4>
        <div className="flex flex-wrap items-center gap-2">
          {stage && (
            <div className="flex overflow-hidden rounded-md border border-neutral-200 text-xs">
              <button onClick={() => setOnlyStage(true)} className={`px-2.5 py-1.5 ${onlyStage ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50"}`}>
                This stage
              </button>
              <button onClick={() => setOnlyStage(false)} className={`px-2.5 py-1.5 ${!onlyStage ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50"}`}>
                All stages
              </button>
            </div>
          )}
          <button onClick={() => setQuick(quick ? null : emptyDraft(viewer))} className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
            + Action point
          </button>
          <button
            onClick={() => setQuick(quick ? null : emptyDraft(viewer, { kind: "review", assignee: "", autoAssign: true }))}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
            title="Ask someone to review your work, or ask for input or help — type their name to tag them"
          >
            👀 Ask for review / input
          </button>
          <button
            onClick={() => {
              setAdding(!adding);
              if (!adding && drafts.length === 0) setDrafts([emptyDraft(viewer)]);
            }}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
          >
            {adding ? "Cancel" : "+ Meeting notes"}
          </button>
        </div>
      </div>

      {sent && (
        <p className="flex items-center justify-between rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {sent}
          <button onClick={() => setSent(null)} className="text-emerald-700 hover:text-emerald-900" aria-label="Dismiss">✕</button>
        </p>
      )}

      {quick && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <DraftActionRow draft={quick} viewer={viewer} onChange={setQuick} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setQuick(null)} className="text-xs text-neutral-500 hover:text-neutral-800">Cancel</button>
            <button onClick={saveQuick} disabled={!quick.description.trim()} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
              {quick.kind === "review" || quick.kind === "input" ? "Send request" : "Save action point"}
            </button>
          </div>
        </div>
      )}

      {adding && (
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-semibold text-neutral-500">Meeting date</label>
            <input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} className={`${baseInput} w-auto`} />
            {!viewer && <span className="text-xs text-amber-700">Tip: pick your name in “Viewing as” so notes show who wrote them.</span>}
          </div>
          <MentionTextarea
            value={text}
            onChange={setText}
            minRows={5}
            ariaLabel="Meeting notes"
            placeholder="What was discussed, decisions taken… e.g. Hussein will help facilitate the donor meeting"
          />
          {suggestions.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-neutral-300 bg-white p-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Turn into action points?</p>
              {suggestions.map((s) => (
                <button
                  key={s.description}
                  type="button"
                  onClick={() =>
                    setDrafts((prev) => [
                      ...prev.filter((d) => d.description.trim()),
                      emptyDraft(viewer, { description: s.description, assignee: s.person, autoAssign: false }),
                    ])
                  }
                  className="flex items-start gap-2 rounded px-1.5 py-1 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                >
                  <span className="mt-0.5 text-xs font-semibold text-[var(--accent)]">＋</span>
                  <MentionText text={s.description} />
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold text-neutral-500">Action points</p>
            {drafts.map((d, i) => (
              <DraftActionRow
                key={i}
                draft={d}
                viewer={viewer}
                onChange={(nd) => setDrafts((prev) => prev.map((x, j) => (j === i ? nd : x)))}
                onRemove={() => setDrafts((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
            <button onClick={() => setDrafts((prev) => [...prev, emptyDraft(viewer)])} className="w-fit text-xs font-medium text-[var(--accent)] hover:underline">
              + Add another action point
            </button>
          </div>
          <div className="flex justify-end">
            <button onClick={saveNote} disabled={!text.trim() || saving} className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              {saving ? "Saving…" : "Save notes"}
            </button>
          </div>
        </div>
      )}

      {sortedNotes.length === 0 && looseActions.length === 0 && !adding && !quick && (
        <p className="text-sm text-neutral-400">{narrow ? "No meeting notes at this stage yet." : "No meeting notes yet."}</p>
      )}

      {sortedNotes.map((n) => {
        const noteActions = actions.filter((a) => a.note_id === n.id);
        return (
          <div key={n.id} id={`note-${n.id}`} className="rounded-lg border border-neutral-200 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-neutral-800">
                {fmtDate(n.meeting_date)}
                {n.author && <span className="ml-2 text-xs font-normal text-neutral-400">by {n.author}</span>}
                {n.stage && <span className="ml-2 rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">{STAGE_BADGE[normalizeStage(n.stage)]}</span>}
              </p>
              <div className="flex items-center gap-3 text-xs">
                <a
                  href={notesEmailLink({ opportunity, note: n, actions: noteActions, extraTo: recipientsFor(mentionsIn(n.notes), null).map(emailOf).filter(Boolean) as string[] })}
                  className="font-medium text-[var(--accent)] hover:underline"
                  title="Opens your mail app with the notes and action points, addressed to the people responsible and the people tagged"
                >
                  ✉ Email notes
                </a>
                <button onClick={() => removeNote(n)} className="text-neutral-300 hover:text-red-500" title="Delete these notes">✕</button>
              </div>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6 text-neutral-700">
              <MentionText text={n.notes} />
            </p>
            {noteActions.length > 0 && <ul className="mt-3 flex flex-col gap-1.5">{noteActions.map(row)}</ul>}
          </div>
        );
      })}

      {looseActions.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Other action points &amp; requests</p>
          <ul className="flex flex-col gap-1.5">{looseActions.map(row)}</ul>
        </div>
      )}
    </section>
  );
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${fmtDate(iso.slice(0, 10))}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function ActionRow({
  a,
  opportunity,
  onToggle,
  onRemove,
  showOpportunity,
  viewer = null,
  replies,
  onReplied,
  onError,
  startOpen = false,
}: {
  a: ActionItem;
  opportunity: string;
  onToggle: (a: ActionItem) => void;
  onRemove?: (a: ActionItem) => void;
  showOpportunity?: boolean;
  viewer?: string | null;
  /** Given → the row shows its replies and a reply box. */
  replies?: ActionReply[];
  onReplied?: (r: ActionReply) => void;
  onError?: (msg: string | null) => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const icon = kindIcon(a.kind);
  const isRequest = a.kind === "review" || a.kind === "input";
  const mine = !!viewer && (canonicalLead(a.assignee) === canonicalLead(viewer) || a.assignee === EVERYONE);

  async function postReply(markDone: boolean) {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    const { data, error } = await supabase
      .from("action_replies")
      .insert({ action_id: a.id, tracker_item_id: a.tracker_item_id, author: viewer, body })
      .select()
      .single();
    if (error || !data) {
      setPosting(false);
      return onError?.(friendlyError(error?.message ?? "Could not save the reply."));
    }
    const reply = data as ActionReply;
    const err = await sendNotifications(replyNotifications(reply, a, replies ?? [], viewer));
    if (err) onError?.(err);
    onReplied?.(reply);
    if (markDone && !a.done) onToggle(a);
    setDraft("");
    setPosting(false);
  }

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <input type="checkbox" checked={a.done} onChange={() => onToggle(a)} className="h-4 w-4 accent-[var(--accent)]" title={a.done ? "Mark as not done" : "Mark as done"} />
      <span className={a.done ? "text-neutral-400 line-through" : "text-neutral-700"}>
        {icon && `${icon} `}
        {a.kind === "meeting" && a.meeting_with ? <strong className="font-medium">Meeting with {a.meeting_with}: </strong> : null}
        {isRequest && <strong className="font-medium">{kindLabel(a.kind)}{a.created_by ? ` from ${fromLabel(a.created_by)}` : ""}: </strong>}
        <MentionText text={a.description} />
        {showOpportunity && <span className="text-neutral-400"> — {opportunity}</span>}
      </span>
      {a.assignee && (
        <span style={tagColor(canonicalLead(a.assignee) ?? a.assignee)} className="rounded-full px-2 py-0.5 text-[11px] font-medium" title="Who it's for">
          {a.assignee === EVERYONE ? "👥 Everyone" : canonicalLead(a.assignee)}
        </span>
      )}
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${DUE_STYLES[dueState(a)]}`}>{dueText(a)}</span>
      {a.kind === "meeting" && a.due_date && !a.done && (
        <button onClick={() => downloadIcs(a, opportunity)} className="text-xs font-medium text-[var(--accent)] hover:underline" title="Download a calendar invite — open it to add the meeting to Outlook with a reminder the day before">
          📅 Add to calendar
        </button>
      )}
      {replies && (
        <button onClick={() => setOpen(!open)} className="text-xs font-medium text-neutral-500 hover:text-[var(--accent)]" aria-expanded={open}>
          💬 {replies.length ? `${replies.length} repl${replies.length > 1 ? "ies" : "y"}` : "Reply"}
        </button>
      )}
      {onRemove && <button onClick={() => onRemove(a)} className="text-xs text-neutral-300 hover:text-red-500" title="Delete">✕</button>}
      {replies && open && (
        <div className="ml-6 flex basis-full flex-col gap-2 border-l-2 border-neutral-200 pl-3">
          {replies.map((r) => (
            <div key={r.id} className="text-sm">
              <p className="text-xs text-neutral-400">
                <span className="font-semibold text-neutral-600">{r.author ? canonicalLead(r.author) : "Someone"}</span> · {fmtWhen(r.created_at)}
              </p>
              <p className="whitespace-pre-wrap text-neutral-700">
                <MentionText text={r.body} />
              </p>
            </div>
          ))}
          {!viewer && <p className="text-xs text-amber-700">Pick your name in “Viewing as” so your reply shows who wrote it.</p>}
          <MentionTextarea
            value={draft}
            onChange={setDraft}
            minRows={1}
            hint={false}
            ariaLabel="Reply"
            placeholder="Reply — say how you approached it, tag someone (e.g. Sammy)…"
            onSubmit={() => postReply(false)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button onClick={() => postReply(false)} disabled={!draft.trim() || posting} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
              {posting ? "Sending…" : "Reply"}
            </button>
            {mine && !a.done && (
              <button onClick={() => postReply(true)} disabled={!draft.trim() || posting} className="rounded-md border border-emerald-600 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
                Reply &amp; mark done ✓
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function DraftActionRow({ draft, viewer, onChange, onRemove }: { draft: DraftAction; viewer: string | null; onChange: (d: DraftAction) => void; onRemove?: () => void }) {
  const kind = ACTION_KINDS.find((k) => k.value === draft.kind) ?? ACTION_KINDS[0];
  return (
    <div className="flex flex-wrap items-start gap-2">
      <select value={draft.kind} onChange={(e) => onChange({ ...draft, kind: e.target.value as ActionKind })} className={`${baseInput} w-auto`} aria-label="Kind of action point">
        {ACTION_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.icon ? `${k.icon} ` : ""}
            {k.label}
          </option>
        ))}
      </select>
      {draft.kind === "meeting" && (
        <input value={draft.meeting_with} onChange={(e) => onChange({ ...draft, meeting_with: e.target.value })} placeholder="With whom (name, organisation)" className={`${baseInput} w-56`} />
      )}
      <div className="min-w-[220px] flex-1">
        <MentionTextarea
          value={draft.description}
          onChange={(v) => onChange(withAutoAssign({ ...draft, description: v }, viewer))}
          minRows={1}
          hint={false}
          ariaLabel="Action point"
          placeholder={kind.placeholder}
        />
      </div>
      <select
        value={draft.assignee}
        onChange={(e) => onChange({ ...draft, assignee: e.target.value, autoAssign: false })}
        className={`${baseInput} w-auto`}
        aria-label="Who"
        title={draft.autoAssign ? "Follows the name you tag — or pick someone" : undefined}
      >
        <option value="">Who?</option>
        {LEADS.map((n) => <option key={n} value={n}>{n}</option>)}
        <option value={EVERYONE}>👥 Everyone</option>
      </select>
      <input type="date" value={draft.due_date} onChange={(e) => onChange({ ...draft, due_date: e.target.value })} title={draft.kind === "meeting" ? "Meeting date" : "Due date"} className={`${baseInput} w-auto`} />
      {onRemove && <button onClick={onRemove} className="mt-1.5 text-neutral-300 hover:text-red-500" title="Remove">✕</button>}
    </div>
  );
}

// Width is kept separate so rows of small inputs can sit side by side.
const baseInput = "rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-800 focus:border-[var(--accent)] focus:outline-none";
const inputCls = `${baseInput} w-full`;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[11px] text-neutral-400">{hint}</p>}
    </div>
  );
}
