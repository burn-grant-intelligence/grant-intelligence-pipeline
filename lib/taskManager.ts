// Management Dashboard → "Task Manager": team chat, weekly tasks and the
// calendar. Pure helpers (dates, channels, who sees what) so
// test/taskManager.test.ts covers them. Screen: components/TaskManager.tsx.
// Tables: team_messages, team_tasks, team_events
// (supabase/management_tools_migration_2026-10-08.sql). Action points from
// the opportunities (action_items) show up in the weekly tasks and calendar too.

import { EVERYONE, LEADS, canonicalLead, effectiveFields } from "./pipeline";
import type { ActionItem, KeyPriority, TeamEvent, TeamMessage, TeamTask, TrackerItem } from "./types";

// ── dates (local calendar days as "YYYY-MM-DD") ──

export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};
export const addDays = (iso: string, n: number) => {
  const d = parseDay(iso);
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
/** The Monday of the week `iso` falls in. */
export function weekStart(iso: string): string {
  const d = parseDay(iso);
  const back = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - back);
  return isoDay(d);
}
export const weekDays = (monday: string) => Array.from({ length: 7 }, (_, i) => addDays(monday, i));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon 12 Oct" */
export const dayLabel = (iso: string) => {
  const d = parseDay(iso);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};
/** "12 – 18 Oct 2026" */
export function weekLabel(monday: string): string {
  const a = parseDay(monday);
  const b = parseDay(addDays(monday, 6));
  const left = a.getMonth() === b.getMonth() ? `${a.getDate()}` : `${a.getDate()} ${MON[a.getMonth()]}`;
  return `${left} – ${b.getDate()} ${MON[b.getMonth()]} ${b.getFullYear()}`;
}
export const monthLabel = (year: number, month: number) => `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month]} ${year}`;
/** Six Monday-first weeks covering the month (42 days). */
export function monthGrid(year: number, month: number): string[] {
  const first = isoDay(new Date(year, month, 1));
  const start = weekStart(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

// ── chat ──

export const CHANNELS: { key: string; label: string; about: string }[] = [
  { key: "general", label: "general", about: "Anything for the whole grants team" },
  { key: "grant-writing", label: "grant-writing", about: "Drafts, reviews and submissions" },
  { key: "management", label: "management", about: "Updates and decisions for management" },
];
export const dmChannel = (a: string, b: string) => `dm:${[canonicalLead(a) ?? a, canonicalLead(b) ?? b].sort().join("|")}`;
export const isDm = (channel: string) => channel.startsWith("dm:");
export function dmPeople(channel: string): string[] {
  return isDm(channel) ? channel.slice(3).split("|") : [];
}
/** The other person in a direct message. */
export function dmPartner(channel: string, me: string | null): string | null {
  const people = dmPeople(channel);
  const self = canonicalLead(me);
  return people.find((p) => p !== self) ?? people[0] ?? null;
}
/** Channels are for everyone; a direct message only for the two people in it. */
export function canSee(channel: string, me: string | null): boolean {
  if (!isDm(channel)) return true;
  const self = canonicalLead(me);
  return !!self && dmPeople(channel).includes(self);
}
/** Messages in a channel after the last time `me` looked at it, not counting their own. */
export function unreadCount(messages: Pick<TeamMessage, "channel" | "author" | "created_at">[], channel: string, lastSeen: string | null, me: string | null): number {
  const self = canonicalLead(me);
  return messages.filter((m) => m.channel === channel && canonicalLead(m.author) !== self && (!lastSeen || m.created_at > lastSeen)).length;
}

// ── weekly tasks ──

export type WorkItem = {
  key: string;
  source: "task" | "action";
  id: string;
  title: string;
  assignee: string | null;
  due: string | null;
  done: boolean;
  opportunity: string | null;
  trackerItemId: string | null;
  kind: string; // "task", or the action point's kind (task, meeting, review, input)
};

const titleOf = (items: TrackerItem[], id: string | null | undefined) => {
  const it = id ? items.find((i) => i.id === id) : null;
  return it ? effectiveFields(it).programName || it.grant?.title || null : null;
};

/** Team tasks and the opportunities' action points as one list. Action points of removed opportunities are left out. */
export function workItems(tasks: TeamTask[], actions: ActionItem[], items: TrackerItem[]): WorkItem[] {
  const live = new Set(items.filter((i) => !i.removed_at).map((i) => i.id));
  return [
    ...tasks.map<WorkItem>((t) => ({
      key: `task-${t.id}`,
      source: "task",
      id: t.id,
      title: t.title,
      assignee: canonicalLead(t.assignee),
      due: t.due_date,
      done: t.done,
      opportunity: titleOf(items, t.tracker_item_id),
      trackerItemId: t.tracker_item_id,
      kind: "task",
    })),
    ...actions
      .filter((a) => live.has(a.tracker_item_id))
      .map<WorkItem>((a) => ({
        key: `action-${a.id}`,
        source: "action",
        id: a.id,
        title: a.description,
        assignee: canonicalLead(a.assignee),
        due: a.due_date,
        done: a.done,
        opportunity: titleOf(items, a.tracker_item_id),
        trackerItemId: a.tracker_item_id,
        kind: a.kind,
      })),
  ];
}

/** Whose list an item shows in: its assignee, or every list when it is for Everyone. */
export function isFor(w: Pick<WorkItem, "assignee">, person: string): boolean {
  return w.assignee === person || w.assignee === EVERYONE;
}

/**
 * What a person has on in a week: items due that week, open items overdue
 * from before it (only when looking at this week or later), and open team
 * tasks with no date. Sorted by date, undated last.
 */
export function weekFor(all: WorkItem[], person: string, monday: string, today: string): WorkItem[] {
  const sunday = addDays(monday, 6);
  const current = weekStart(today) <= monday;
  return all
    .filter((w) => isFor(w, person))
    .filter((w) => {
      if (w.due) {
        if (w.due >= monday && w.due <= sunday) return true;
        return current && !w.done && w.due < monday && w.due < today;
      }
      return w.source === "task" && !w.done;
    })
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(a.done) - Number(b.done) || a.title.localeCompare(b.title));
}

export const TEAM_PEOPLE = LEADS;

// ── calendar ──

export type CalendarEntry = {
  key: string;
  date: string;
  kind: "meeting" | "deadline" | "action-meeting";
  title: string;
  time: string | null;
  people: string[]; // empty = the whole team
  detail: string | null;
  eventId?: string;
};

/** Meetings, meeting action points and opportunity deadlines, by day. `person` narrows it to what concerns them. */
export function calendarEntries(
  events: TeamEvent[],
  actions: ActionItem[],
  items: TrackerItem[],
  priorities: KeyPriority[],
  person: string | null
): CalendarEntry[] {
  const self = canonicalLead(person);
  const live = items.filter((i) => !i.removed_at && i.status !== "lost");
  const out: CalendarEntry[] = [];
  for (const e of events) {
    const people = (e.attendees ?? []).map((a) => canonicalLead(a) ?? a);
    if (self && people.length && !people.includes(self)) continue;
    out.push({
      key: `event-${e.id}`,
      date: e.event_date.slice(0, 10),
      kind: "meeting",
      title: e.title,
      time: e.start_time ? `${e.start_time}${e.end_time ? `–${e.end_time}` : ""}` : null,
      people,
      detail: e.location,
      eventId: e.id,
    });
  }
  const liveIds = new Set(live.map((i) => i.id));
  for (const a of actions) {
    if (a.kind !== "meeting" || !a.due_date || a.done || !liveIds.has(a.tracker_item_id)) continue;
    const who = canonicalLead(a.assignee);
    if (self && who && who !== self && who !== EVERYONE) continue;
    out.push({ key: `action-${a.id}`, date: a.due_date.slice(0, 10), kind: "action-meeting", title: a.meeting_with ? `Meeting with ${a.meeting_with}` : a.description, time: null, people: who ? [who] : [], detail: titleOf(items, a.tracker_item_id) });
  }
  const seen = new Set<string>();
  for (const i of live) {
    const e = effectiveFields(i);
    if (!/^\d{4}-\d{2}-\d{2}/.test(e.deadline) || i.status === "won" || i.status === "implementation" || i.status === "submitted") continue;
    if (self && e.lead && e.lead !== self) continue;
    seen.add((e.programName || "").toLowerCase());
    out.push({ key: `deadline-${i.id}`, date: e.deadline.slice(0, 10), kind: "deadline", title: `Deadline: ${e.programName || "(untitled)"}`, time: null, people: e.lead ? [e.lead] : [], detail: e.funder || null });
  }
  for (const p of priorities) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(p.deadline ?? "") || seen.has((p.opportunity ?? "").toLowerCase())) continue;
    const lead = canonicalLead(p.lead);
    if (self && lead && lead !== self) continue;
    out.push({ key: `priority-${p.id}`, date: (p.deadline as string).slice(0, 10), kind: "deadline", title: `Deadline: ${p.opportunity}`, time: null, people: lead ? [lead] : [], detail: "Key priority" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "99").localeCompare(b.time ?? "99"));
}
