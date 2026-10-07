// Team collaboration helpers: who gets notified, what shows in a person's
// desk, and "Remove from tracker" — shared by the Application Tracker and the
// Draft Application workspace.
// Tables: supabase/team_collaboration_migration_2026-10-06.sql.

import { supabase } from "./supabaseClient";
import { EVERYONE, canonicalLead, dueState, myOpenActions, todayIso } from "./pipeline";
import { excerptsByPerson, mentionsIn, recipientsFor } from "./mentions";
import type { ActionItem, ActionKind, ActionReply, OpportunityNote, TeamNotification, TrackerItem } from "./types";

export const ACTION_KINDS: { value: ActionKind; label: string; icon: string; placeholder: string }[] = [
  { value: "task", label: "Task", icon: "", placeholder: "What needs to be done — type a name to tag, e.g. Hussein" },
  { value: "meeting", label: "Meeting", icon: "🤝", placeholder: "Purpose of the meeting" },
  { value: "review", label: "Review request", icon: "👀", placeholder: "What to review, e.g. please review my concept note" },
  { value: "input", label: "Input / help", icon: "🙋", placeholder: "What you need, e.g. your input on the budget section" },
];
export const kindIcon = (k: ActionKind | string) => ACTION_KINDS.find((x) => x.value === k)?.icon ?? "";
export const kindLabel = (k: ActionKind | string) => ACTION_KINDS.find((x) => x.value === k)?.label ?? "Task";

/** Not removed with "Remove & discard". */
export const isLive = (item: Pick<TrackerItem, "removed_at"> | null | undefined) => !!item && !item.removed_at;

export type NotificationDraft = Pick<TeamNotification, "recipient" | "kind" | "tracker_item_id" | "note_id" | "action_id" | "reply_id" | "from_person" | "excerpt">;

const clip = (s: string, max = 220) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Everyone tagged in meeting notes (each gets the sentence they were tagged in). */
export function noteNotifications(note: Pick<OpportunityNote, "id" | "tracker_item_id" | "notes">, author: string | null): NotificationDraft[] {
  const out: NotificationDraft[] = [];
  const seen = new Set<string>();
  for (const [person, excerpt] of excerptsByPerson(note.notes)) {
    for (const recipient of recipientsFor([person], author)) {
      if (seen.has(recipient)) continue;
      seen.add(recipient);
      out.push({ recipient, kind: person === EVERYONE ? "everyone" : "mention", tracker_item_id: note.tracker_item_id, note_id: note.id, action_id: null, reply_id: null, from_person: author, excerpt });
    }
  }
  return out;
}

/**
 * People tagged in an action point's text. The assignee is not notified
 * separately: the action point itself is in their desk (and an action point
 * for Everyone is in everybody's).
 */
export function actionNotifications(action: Pick<ActionItem, "id" | "tracker_item_id" | "description" | "assignee">, author: string | null): NotificationDraft[] {
  const tagged = mentionsIn(action.description);
  const skip = new Set([canonicalLead(action.assignee)]);
  if (action.assignee === EVERYONE) return [];
  return recipientsFor(tagged, author)
    .filter((r) => !skip.has(r))
    .map((recipient) => ({
      recipient,
      kind: tagged.includes(EVERYONE) ? "everyone" : "mention",
      tracker_item_id: action.tracker_item_id,
      note_id: null,
      action_id: action.id,
      reply_id: null,
      from_person: author,
      excerpt: clip(action.description),
    }));
}

/**
 * A reply goes to whoever asked (the action point's creator), whoever it is
 * assigned to, everyone who already replied, and anyone tagged in it.
 */
export function replyNotifications(
  reply: Pick<ActionReply, "id" | "body" | "tracker_item_id">,
  action: Pick<ActionItem, "id" | "created_by" | "assignee">,
  earlier: Pick<ActionReply, "author">[],
  author: string | null
): NotificationDraft[] {
  const tagged = mentionsIn(reply.body);
  const taggedPeople = new Set(recipientsFor(tagged, author));
  const involved = recipientsFor(
    [action.created_by, action.assignee === EVERYONE ? null : action.assignee, ...earlier.map((r) => r.author)].filter(Boolean) as string[],
    author
  );
  const all = [...new Set([...involved, ...taggedPeople])];
  return all.map((recipient) => ({
    recipient,
    kind: taggedPeople.has(recipient) && !involved.includes(recipient) ? (tagged.includes(EVERYONE) ? "everyone" : "mention") : "reply",
    tracker_item_id: reply.tracker_item_id,
    note_id: null,
    action_id: action.id,
    reply_id: reply.id,
    from_person: author,
    excerpt: clip(reply.body),
  }));
}

/** Tell the lead their opportunity was removed (unless they removed it). */
export function removedNotification(item: Pick<TrackerItem, "id" | "owner">, by: string | null, title: string, reason: string | null): NotificationDraft[] {
  const lead = canonicalLead(item.owner);
  if (!lead || lead === canonicalLead(by)) return [];
  return [{ recipient: lead, kind: "removed", tracker_item_id: item.id, note_id: null, action_id: null, reply_id: null, from_person: by, excerpt: clip(`Removed "${title}"${reason ? ` — ${reason}` : ""}`) }];
}

const missingTable = (m: string) =>
  /team_notifications|action_replies|removed_at|schema cache|does not exist|kind_check|violates check/i.test(m)
    ? "Tagging, replies and Remove need supabase/team_collaboration_migration_2026-10-06.sql — run it in Supabase."
    : m;

/** Save notifications. Returns an error message, or null. */
export async function sendNotifications(drafts: NotificationDraft[]): Promise<string | null> {
  if (!drafts.length) return null;
  const { error } = await supabase.from("team_notifications").insert(drafts);
  return error ? missingTable(error.message) : null;
}

export const friendlyError = missingTable;

// ── A person's desk ──

export type Desk = {
  open: ActionItem[]; // assigned to me (or Everyone), not done
  mentions: TeamNotification[]; // tagged / replied to / removed, not yet seen
  asked: ActionItem[]; // I asked someone else, still open
  overdue: number;
};

export function deskFor(
  viewer: string | null,
  data: { items: Pick<TrackerItem, "id" | "removed_at">[]; actions: ActionItem[]; notifications: TeamNotification[] },
  today = todayIso()
): Desk {
  const me = canonicalLead(viewer);
  if (!me) return { open: [], mentions: [], asked: [], overdue: 0 };
  const live = new Set(data.items.filter(isLive).map((i) => i.id));
  const actions = data.actions.filter((a) => live.has(a.tracker_item_id));
  const open = myOpenActions(actions, me, today);
  const mentions = data.notifications
    .filter((n) => canonicalLead(n.recipient) === me && !n.seen_at && (n.kind === "removed" || !n.tracker_item_id || live.has(n.tracker_item_id)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const asked = actions
    .filter((a) => !a.done && canonicalLead(a.created_by) === me && a.assignee && canonicalLead(a.assignee) !== me)
    .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
  return { open, mentions, asked, overdue: open.filter((a) => dueState(a, today) === "overdue").length };
}

// ── Remove & discard ──

/**
 * Take an opportunity out of the Application Tracker and every tab after it.
 * Nothing is deleted. By default the grant goes back to the Grant Scanner as an
 * ordinary, untracked opportunity (the Scanner already treats a removed item as
 * not tracked); with `discard` it is also hidden in the Scanner. Tracking it
 * again from the Scanner brings the removed item back with its notes.
 */
export async function removeOpportunity(item: TrackerItem, by: string | null, reason: string | null, title: string, discard = false): Promise<string | null> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("tracker_items")
    .update({ removed_at: now, removed_by: by, removed_reason: reason, updated_at: now })
    .eq("id", item.id);
  if (error) return missingTable(error.message);
  if (item.grant_id) {
    const { error: gErr } = await supabase
      .from("grants")
      .update(discard ? { discarded: true, discarded_at: now } : { discarded: false, discarded_at: null })
      .eq("id", item.grant_id);
    if (gErr) return gErr.message;
  }
  return sendNotifications(removedNotification(item, by, title, reason));
}

/** Bring a removed opportunity back (and un-discard it in the Grant Scanner). */
export async function restoreOpportunity(item: TrackerItem): Promise<string | null> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("tracker_items").update({ removed_at: null, removed_by: null, removed_reason: null, updated_at: now }).eq("id", item.id);
  if (error) return missingTable(error.message);
  if (item.grant_id) {
    const { error: gErr } = await supabase.from("grants").update({ discarded: false, discarded_at: null }).eq("id", item.grant_id);
    if (gErr) return gErr.message;
  }
  return null;
}

/** Mark notifications as seen. */
export async function markSeen(ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const { error } = await supabase.from("team_notifications").update({ seen_at: new Date().toISOString() }).in("id", ids);
  return error ? missingTable(error.message) : null;
}
