"use client";

// The "👀 Eligibility review" part of an Eligibility Tracker card.
//
// When the check says "Needs further review", the lead gets a review action
// point automatically (lib/eligibilityReview.ts). Here they write quick notes
// on why it fits or not and pick ✓ Fits / ✕ Not a fit — that closes the
// review, sets Fit / Not fit, and the notes stay at the bottom of the card
// (and as a reply on the action point in the Application Tracker). The review
// can be handed to someone else, or asked for on any opportunity.

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { LEADS, canonicalLead, firstName, fmtDate } from "@/lib/pipeline";
import { tagColor } from "@/lib/mentions";
import { friendlyError, replyNotifications, sendNotifications, type NotificationDraft } from "@/lib/collab";
import {
  ELIGIBILITY_CHECK,
  REVIEW_ORIGIN,
  decisionOf,
  fromLabel,
  needsReview,
  outcomeBody,
  reassignPatch,
  reviewActionText,
  type Decision,
} from "@/lib/eligibilityReview";
import { MentionText, MentionTextarea } from "@/components/Mentions";
import type { ActionItem, ActionReply, TrackerItem } from "@/lib/types";

export function PersonChip({ name, prefix }: { name: string | null | undefined; prefix?: string }) {
  const person = canonicalLead(name);
  if (!person) return null;
  const isBot = person === ELIGIBILITY_CHECK;
  return (
    <span
      style={isBot ? undefined : tagColor(person)}
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${isBot ? "bg-neutral-100 text-neutral-500" : ""}`}
    >
      {prefix}
      {isBot ? "Eligibility check" : person}
    </span>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${fmtDate(iso.slice(0, 10))}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function EligibilityReview({
  item,
  reviews,
  replies,
  viewer,
  onActionsChange,
  onRepliesChange,
  onItemPatch,
  onError,
}: {
  item: TrackerItem;
  /** This opportunity's review action points (open and finished), oldest first. */
  reviews: ActionItem[];
  replies: ActionReply[];
  viewer: string | null;
  onActionsChange: (update: (prev: ActionItem[]) => ActionItem[]) => void;
  onRepliesChange: (update: (prev: ActionReply[]) => ActionReply[]) => void;
  onItemPatch: (patch: Partial<TrackerItem>) => void;
  onError: (msg: string | null) => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const open = reviews.find((a) => !a.done) ?? null;
  const lead = canonicalLead(item.owner);
  const summary = item.grant?.eligibility_report?.summary ?? null;
  const flagged = needsReview(item);
  const me = canonicalLead(viewer);
  const history = reviews.flatMap((a) => replies.filter((r) => r.action_id === a.id).map((r) => ({ r, a })));

  // Hand the open review to someone else, or ask someone for one.
  async function askFor(person: string) {
    if (!person) return;
    onError(null);
    setBusy(true);
    if (open) {
      const patch = reassignPatch(open, person, summary);
      const { error } = await supabase.from("action_items").update(patch).eq("id", open.id);
      setBusy(false);
      if (error) return onError(friendlyError(error.message));
      onActionsChange((prev) => prev.map((a) => (a.id === open.id ? { ...a, ...patch } : a)));
    } else {
      const row = {
        tracker_item_id: item.id,
        note_id: null,
        kind: "review",
        origin: REVIEW_ORIGIN,
        description: reviewActionText(person, summary, !flagged),
        meeting_with: null,
        assignee: person,
        due_date: null,
        created_by: me ?? ELIGIBILITY_CHECK,
      };
      const { data, error } = await supabase.from("action_items").insert(row).select().single();
      setBusy(false);
      if (error) return onError(/origin|schema cache/i.test(error.message) ? "Asking for a review needs supabase/eligibility_review_migration_2026-10-06.sql — run it in Supabase." : friendlyError(error.message));
      onActionsChange((prev) => [...prev, data as ActionItem]);
    }
    setAskOpen(false);
  }

  // Save the reviewer's notes; with a decision, also close the review and set Fit / Not fit.
  async function submit(decision: Decision) {
    if (!open) return;
    const body = outcomeBody(decision, notes);
    if (!body) return;
    onError(null);
    setBusy(true);
    const { data, error } = await supabase
      .from("action_replies")
      .insert({ action_id: open.id, tracker_item_id: item.id, author: me, body })
      .select()
      .single();
    if (error || !data) {
      setBusy(false);
      return onError(friendlyError(error?.message ?? "Could not save the review notes."));
    }
    const reply = data as ActionReply;
    onRepliesChange((prev) => [...prev, reply]);

    // Whoever asked, earlier repliers and anyone tagged — plus the lead, so they
    // see how the reviewer judged it.
    const earlier = replies.filter((r) => r.action_id === open.id);
    const drafts: NotificationDraft[] = replyNotifications(reply, open, earlier, me);
    if (lead && lead !== me && !drafts.some((d) => d.recipient === lead)) {
      drafts.push({ recipient: lead, kind: "reply", tracker_item_id: item.id, note_id: null, action_id: open.id, reply_id: reply.id, from_person: me, excerpt: body.slice(0, 220) });
    }
    const nErr = await sendNotifications(drafts);

    if (decision) {
      const now = new Date().toISOString();
      const [a, t] = await Promise.all([
        supabase.from("action_items").update({ done: true, done_at: now }).eq("id", open.id),
        supabase.from("tracker_items").update({ fit_status: decision, fit_source: "manual", updated_at: now }).eq("id", item.id),
      ]);
      const err = a.error ?? t.error;
      if (err) {
        setBusy(false);
        return onError(err.message);
      }
      onActionsChange((prev) => prev.map((x) => (x.id === open.id ? { ...x, done: true, done_at: now } : x)));
      onItemPatch({ fit_status: decision, fit_source: "manual" });
    }
    if (nErr) onError(nErr);
    setNotes("");
    setBusy(false);
  }

  const askPicker = (label: string) => (
    <label className="flex items-center gap-1.5 text-xs text-neutral-600">
      {label}
      <select
        value=""
        disabled={busy}
        onChange={(e) => askFor(e.target.value)}
        aria-label={label}
        className="rounded-md border border-neutral-300 bg-white px-1.5 py-1 text-xs text-neutral-800"
      >
        <option value="">Choose…</option>
        {LEADS.filter((n) => n !== canonicalLead(open?.assignee)).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );

  // Nothing to show: not flagged, no review asked, no history.
  if (!open && !flagged && !history.length) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        {askOpen ? (
          <>
            {askPicker("👀 Ask for a review:")}
            <button onClick={() => setAskOpen(false)} className="text-neutral-400 hover:text-neutral-700">
              Cancel
            </button>
          </>
        ) : (
          <button onClick={() => setAskOpen(true)} className="underline decoration-neutral-300 hover:text-[var(--accent)]">
            👀 Ask someone to review this
          </button>
        )}
      </div>
    );
  }

  return (
    <section aria-label="Eligibility review" className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">👀 Eligibility review</p>
        {open && askPicker("Hand to")}
      </div>

      {open ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-neutral-800">
            <span className="font-medium">With</span>
            <PersonChip name={open.assignee} />
            {canonicalLead(open.assignee) === lead && <span className="text-xs text-neutral-500">(the lead)</span>}
            <span className="text-xs text-neutral-500">
              · asked by {fromLabel(open.created_by)} · {fmtDate(open.created_at.slice(0, 10))}
            </span>
          </p>
          <p className="text-sm text-neutral-700">
            <MentionText text={open.description} />
          </p>
          {!me ? (
            <p className="text-xs text-amber-800">Pick your name in “View as” above to write the review.</p>
          ) : (
            <>
              {me !== canonicalLead(open.assignee) && (
                <p className="text-xs text-amber-800">
                  You&apos;re viewing as {firstName(me)}; this review is with {firstName(open.assignee)}. You can still add your notes.
                </p>
              )}
              <MentionTextarea
                value={notes}
                onChange={setNotes}
                minRows={2}
                ariaLabel="Review notes"
                placeholder="Quick notes: why it fits or not after your review — type a name to tag someone (e.g. Hussein)"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => submit("fit")}
                  disabled={busy}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  ✓ Fits — mark Fit
                </button>
                <button
                  onClick={() => submit("not_fit")}
                  disabled={busy}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
                >
                  ✕ Not a fit
                </button>
                <button
                  onClick={() => submit(null)}
                  disabled={busy || !notes.trim()}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
                >
                  Save note, keep open
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        flagged && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {lead ? (
              <span>Needs further review — {firstName(lead)} (the lead) is tagged once the review opens. Or</span>
            ) : (
              <span>
                Needs further review, but there&apos;s no lead yet. Pick a lead in the Application Tracker (Breakdown → Lead) and
                they&apos;ll be tagged here automatically — or
              </span>
            )}
            {askPicker("ask now:")}
          </div>
        )
      )}

      {history.length > 0 && (
        <ul className="flex flex-col gap-2">
          {history.map(({ r, a }) => {
            const decision = decisionOf(r.body);
            return (
              <li
                key={r.id}
                className={`rounded-md border-l-4 bg-white px-3 py-2 text-sm ${
                  decision === "fit" ? "border-emerald-500" : decision === "not_fit" ? "border-red-500" : "border-neutral-300"
                }`}
              >
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                  <PersonChip name={r.author ?? "Someone"} />
                  <span>{when(r.created_at)}</span>
                  {a.done && a.id !== open?.id && <span className="text-neutral-400">· review closed</span>}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-neutral-800">
                  <MentionText text={r.body} />
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {!open && !flagged && (
        <div className="text-xs text-neutral-500">
          {askOpen ? askPicker("👀 Ask for another review:") : (
            <button onClick={() => setAskOpen(true)} className="underline decoration-neutral-300 hover:text-[var(--accent)]">
              👀 Ask for another review
            </button>
          )}
        </div>
      )}
    </section>
  );
}
