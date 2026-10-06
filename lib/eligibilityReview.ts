// Eligibility reviews routed to the lead.
//
// When the eligibility check says an opportunity "Needs further review", the
// opportunity's lead (Application Tracker → Breakdown → Lead) gets a 👀 review
// action point, tagged by name: "Sammy, the eligibility check needs your
// further review: …". It shows in their desk and on the Eligibility Tracker
// card. Their review notes are replies on it; picking Fit / Not fit closes it.
//
// The planner below is pure (no database) so test/eligibilityReview.test.ts
// covers it. `applyReviewPlan` writes the plan with whichever Supabase client
// it is given — the browser's (tabs) or the service-role one (the API route).
// Needs supabase/eligibility_review_migration_2026-10-06.sql.

import { TEAM, canonicalLead, firstName } from "./pipeline";
import type { ActionItem, ActionReply } from "./types";

/** `created_by` on review requests the app makes itself. */
export const ELIGIBILITY_CHECK = "Eligibility check";
/** `origin` on those action points. */
export const REVIEW_ORIGIN = "eligibility_review";

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const isTeam = (name: string | null | undefined) => !!name && TEAM.some((t) => t.name === canonicalLead(name));

/** The action point's text; the first name makes it a coloured tag. */
export function reviewActionText(person: string, summary?: string | null, asked = false): string {
  const who = firstName(person) || person;
  const why = summary?.trim() ? `: ${clip(summary.trim(), 260)}` : ".";
  return asked
    ? `${who}, please review whether this opportunity fits BURN${why}`
    : `${who}, the eligibility check needs your further review${why}`;
}

/** Shown as "Review request from …". */
export const fromLabel = (createdBy: string | null | undefined) =>
  createdBy === ELIGIBILITY_CHECK ? "the eligibility check" : firstName(createdBy) || createdBy || "";

export type ReviewItem = {
  id: string;
  owner: string | null;
  fit_status?: "unreviewed" | "fit" | "not_fit" | null;
  fit_source?: "auto" | "manual" | null;
  removed_at?: string | null;
  grant?: {
    eligibility_verdict?: "fit" | "not_fit" | "needs_review" | null;
    eligibility_checked_at?: string | null;
    eligibility_report?: { summary?: string | null } | null;
  } | null;
};

export type ReviewAction = Pick<ActionItem, "id" | "tracker_item_id" | "assignee" | "done" | "created_at" | "created_by" | "description"> & {
  origin?: string | null;
};

/** A person made the Fit / Not fit call (same rule as lib/eligibility/applyVerdict.ts). */
export function humanDecided(item: ReviewItem): boolean {
  const status = item.fit_status ?? "unreviewed";
  return item.fit_source === "manual" || (!item.fit_source && status !== "unreviewed");
}

/** The check said "Needs further review" and nobody has decided yet. */
export function needsReview(item: ReviewItem): boolean {
  return !item.removed_at && item.grant?.eligibility_verdict === "needs_review" && !humanDecided(item);
}

export const isReviewAction = (a: { origin?: string | null }) => a.origin === REVIEW_ORIGIN;
export const openReviewFor = <A extends ReviewAction>(itemId: string, actions: A[]) =>
  actions.find((a) => a.tracker_item_id === itemId && isReviewAction(a) && !a.done) ?? null;

export type NewReviewAction = {
  tracker_item_id: string;
  note_id: null;
  kind: "review";
  origin: typeof REVIEW_ORIGIN;
  description: string;
  meeting_with: null;
  assignee: string;
  due_date: null;
  created_by: string;
};

export type ReviewPlan = {
  create: NewReviewAction[];
  /** Open reviews no longer needed; `body` is the closing reply. */
  close: { id: string; tracker_item_id: string; body: string }[];
};

const VERDICT_WORD = { fit: "Fit", not_fit: "Not a fit", needs_review: "Needs further review" } as const;

/**
 * What to create or close so that every opportunity needing review has one
 * open review with its lead, and none is left open once it's decided.
 *
 *  - Needs review + lead + no open review → create one for the lead, unless a
 *    review was already finished after the latest check (someone looked at
 *    this check's result; a re-check that still says "needs review" asks again).
 *  - No lead → nothing yet; it is created once a lead is picked.
 *  - Open review but no longer needs review (a person picked Fit / Not fit, or
 *    a re-check decided it) → close it with a short reply saying why.
 *  - Removed opportunities are left alone.
 */
export function planReviewSync(items: ReviewItem[], actions: ReviewAction[]): ReviewPlan {
  const plan: ReviewPlan = { create: [], close: [] };
  for (const item of items) {
    if (item.removed_at) continue;
    const reviews = actions.filter((a) => a.tracker_item_id === item.id && isReviewAction(a));
    const open = reviews.find((a) => !a.done);
    if (needsReview(item)) {
      if (open) continue;
      const lead = canonicalLead(item.owner);
      if (!lead || !isTeam(lead)) continue;
      const checkedAt = item.grant?.eligibility_checked_at ?? "";
      if (reviews.some((a) => a.done && (!checkedAt || a.created_at >= checkedAt))) continue;
      plan.create.push({
        tracker_item_id: item.id,
        note_id: null,
        kind: "review",
        origin: REVIEW_ORIGIN,
        description: reviewActionText(lead, item.grant?.eligibility_report?.summary),
        meeting_with: null,
        assignee: lead,
        due_date: null,
        created_by: ELIGIBILITY_CHECK,
      });
    } else if (open && open.created_by === ELIGIBILITY_CHECK) {
      // Only reviews the check asked for close by themselves; a review a person
      // asked for stays until someone ticks it off.
      const status = item.fit_status ?? "unreviewed";
      const body = humanDecided(item)
        ? `Marked ${status === "fit" ? "Fit" : "Not fit"} — review closed.`
        : item.grant?.eligibility_verdict
          ? `Re-check says ${VERDICT_WORD[item.grant.eligibility_verdict]} — review closed automatically.`
          : "Review closed.";
      plan.close.push({ id: open.id, tracker_item_id: item.id, body });
    }
  }
  return plan;
}

/**
 * When the lead changes, the open review follows them if it was still with the
 * old lead (or nobody). A review someone handed to another person stays put.
 * Returns the patch to write, or null.
 */
export function leadChangePatch(
  open: ReviewAction | null,
  oldLead: string | null,
  newLead: string | null,
  summary?: string | null
): { assignee: string; description: string } | null {
  const next = canonicalLead(newLead);
  if (!open || !next || !isTeam(next)) return null;
  const current = canonicalLead(open.assignee);
  if (current === next) return null;
  if (current && current !== canonicalLead(oldLead)) return null;
  return reassignPatch(open, next, summary);
}

/** Hand a review to someone else; the generated text follows the new name. */
export function reassignPatch(open: ReviewAction, person: string, summary?: string | null) {
  const generated =
    open.description === reviewActionText(open.assignee ?? "", summary) ||
    open.description === reviewActionText(open.assignee ?? "", summary, true) ||
    /^\S+, (the eligibility check needs your further review|please review whether this opportunity fits BURN)/.test(open.description);
  const asked = /please review whether/.test(open.description);
  return { assignee: person, description: generated ? reviewActionText(person, summary, asked) : open.description };
}

// ── Review outcome ──

export type Decision = "fit" | "not_fit" | null;

/** The reply body a reviewer's decision becomes. */
export function outcomeBody(decision: Decision, notes: string): string {
  const n = notes.trim();
  if (!decision) return n;
  const head = decision === "fit" ? "✓ Fits" : "✕ Not a fit";
  return n ? `${head} — ${n}` : head;
}

/** "fit" / "not_fit" when a reply records a decision, else null. */
export function decisionOf(body: string): Decision {
  if (/^✓ Fits\b/.test(body)) return "fit";
  if (/^✕ Not a fit\b/.test(body)) return "not_fit";
  return null;
}

// ── Writing a plan ──

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from: (table: string) => any };

const UNIQUE_VIOLATION = "23505";
export const reviewMigrationHint =
  "Routing eligibility reviews to the lead needs supabase/eligibility_review_migration_2026-10-06.sql — run it in Supabase.";
const looksLikeMissingOrigin = (m: string) => /origin|schema cache|does not exist/i.test(m);

/**
 * Write a plan. Returns what was created / closed (to update the screen) and
 * an error message, if any. Safe to run from two browsers at once: the unique
 * index stops a second open review, and a review is only closed once.
 */
export async function applyReviewPlan(
  db: Db,
  plan: ReviewPlan
): Promise<{ created: ActionItem[]; closed: { id: string; reply: ActionReply | null }[]; error: string | null }> {
  const created: ActionItem[] = [];
  const closed: { id: string; reply: ActionReply | null }[] = [];
  let error: string | null = null;

  for (const row of plan.create) {
    const { data, error: e } = await db.from("action_items").insert(row).select().single();
    if (e) {
      if (e.code === UNIQUE_VIOLATION) continue; // someone else just created it
      error = looksLikeMissingOrigin(e.message ?? "") ? reviewMigrationHint : e.message;
      break;
    }
    if (data) created.push(data as ActionItem);
  }

  const now = new Date().toISOString();
  for (const c of plan.close) {
    const { data, error: e } = await db
      .from("action_items")
      .update({ done: true, done_at: now })
      .eq("id", c.id)
      .eq("done", false)
      .select();
    if (e) {
      error = e.message;
      break;
    }
    if (!data?.length) continue; // already closed elsewhere
    const { data: reply } = await db
      .from("action_replies")
      .insert({ action_id: c.id, tracker_item_id: c.tracker_item_id, author: ELIGIBILITY_CHECK, body: c.body })
      .select()
      .single();
    closed.push({ id: c.id, reply: (reply as ActionReply) ?? null });
  }
  return { created, closed, error };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── "Viewing as" in the Eligibility Tracker ──

export type NextStep = { key: "review" | "check" | "decide" | "waiting"; label: string; rank: number };

/**
 * What the person viewing needs to do on this opportunity, if anything:
 * their review → run the check (they lead it, not checked yet) → decide Fit /
 * Not fit → waiting on someone else's review.
 */
export function nextStepFor(
  item: ReviewItem,
  actions: ReviewAction[],
  viewer: string | null
): NextStep | null {
  const me = canonicalLead(viewer);
  if (!me || item.removed_at) return null;
  const open = openReviewFor(item.id, actions);
  if (open && canonicalLead(open.assignee) === me) return { key: "review", label: "👀 Your review is needed", rank: 0 };
  if (canonicalLead(item.owner) !== me) return null;
  if (!item.grant?.eligibility_checked_at) return { key: "check", label: "▶ Run the eligibility check", rank: 1 };
  if (open) return { key: "waiting", label: `⏳ Waiting on ${firstName(open.assignee) || "someone"}'s review`, rank: 3 };
  if (humanDecided(item) || (item.fit_status ?? "unreviewed") !== "unreviewed") return null;
  return { key: "decide", label: "Decide Fit / Not fit", rank: 2 };
}
