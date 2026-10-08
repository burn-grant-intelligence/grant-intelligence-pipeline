// Run: npx tsx test/taskManager.test.ts
// The Task Manager (lib/taskManager.ts): dates, chat channels, weekly tasks, calendar.
import {
  addDays, calendarEntries, canSee, dayLabel, dmChannel, dmPartner, isDm, monthGrid, unreadCount, weekDays, weekFor, weekLabel, weekStart, workItems,
} from "../lib/taskManager";
import type { ActionItem, KeyPriority, TeamEvent, TeamTask, TrackerItem } from "../lib/types";

let failed = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};
const S = "Sammy Mwathi", H = "Hussein Kiarie", C = "Christine Theuri";

// ── dates ──
check(weekStart("2026-10-08") === "2026-10-05" && weekStart("2026-10-05") === "2026-10-05" && weekStart("2026-10-11") === "2026-10-05", "weeks start on Monday (Thu 8 Oct → Mon 5 Oct; Sunday belongs to the week before)");
check(addDays("2026-10-30", 3) === "2026-11-02" && addDays("2026-03-01", -1) === "2026-02-28", "adding days crosses months");
check(weekDays("2026-10-05").join() === "2026-10-05,2026-10-06,2026-10-07,2026-10-08,2026-10-09,2026-10-10,2026-10-11", "seven days Monday to Sunday");
check(dayLabel("2026-10-08") === "Thu 8 Oct" && weekLabel("2026-10-05") === "5 – 11 Oct 2026" && weekLabel("2026-09-28") === "28 Sep – 4 Oct 2026", "labels");
const g = monthGrid(2026, 9);
check(g.length === 42 && g[0] === "2026-09-28" && g.includes("2026-10-31"), "October 2026 grid starts Monday 28 Sep, six weeks");

// ── chat ──
const dm = dmChannel("Sammy", H);
check(dm === `dm:${H}|${S}` && dmChannel(H, S) === dm, "a direct message has one channel whoever opens it");
check(isDm(dm) && !isDm("general") && dmPartner(dm, S) === H && dmPartner(dm, H) === S, "the other person in a direct message");
check(canSee("general", null) && canSee(dm, S) && !canSee(dm, C) && !canSee(dm, null), "channels for all, direct messages only for the two people");
const msgs = [
  { channel: "general", author: H, created_at: "2026-10-08T09:00:00Z" },
  { channel: "general", author: S, created_at: "2026-10-08T09:05:00Z" },
  { channel: "general", author: H, created_at: "2026-10-08T09:10:00Z" },
];
check(unreadCount(msgs, "general", null, S) === 2 && unreadCount(msgs, "general", "2026-10-08T09:00:00Z", S) === 1 && unreadCount(msgs, "general", null, null) === 3, "unread: after the last look, not counting your own");

// ── weekly tasks ──
const now = "2026-10-01T08:00:00Z";
const item = (id: string, title: string, over: Partial<TrackerItem> = {}): TrackerItem =>
  ({ id, grant: { id: `g-${id}`, title, funder: "F", deadline: "2026-10-09" }, owner: S, status: "drafting", removed_at: null, created_at: now, updated_at: now, ...over }) as unknown as TrackerItem;
const items = [item("t1", "EU Call Ethiopia"), item("t2", "Old one", { removed_at: now }), item("t3", "Lost one", { status: "lost" })];
const task = (id: string, title: string, assignee: string | null, due: string | null, done = false): TeamTask => ({ id, title, notes: null, assignee, due_date: due, done, done_at: null, tracker_item_id: id === "k2" ? "t1" : null, created_by: H, created_at: now, updated_at: now });
const act = (id: string, desc: string, assignee: string | null, due: string | null, over: Partial<ActionItem> = {}): ActionItem => ({ id, tracker_item_id: "t1", note_id: null, kind: "task", description: desc, meeting_with: null, assignee, due_date: due, done: false, done_at: null, created_by: H, created_at: now, ...over });
const tasks = [task("k1", "Send budget", S, "2026-10-07"), task("k2", "Draft Q1", S, null), task("k3", "Team lunch", "Everyone", "2026-10-09"), task("k4", "Old thing", S, "2026-09-20"), task("k5", "Next week thing", S, "2026-10-14"), task("k6", "Done before", S, "2026-09-21", true)];
const actions = [act("a1", "Call the donor", "Sammy", "2026-10-06"), act("a2", "Removed opp action", S, "2026-10-06", { tracker_item_id: "t2" }), act("a3", "Hussein's thing", H, "2026-10-06")];
const all = workItems(tasks, actions, items);
check(all.length === 8 && !all.some((w) => w.id === "a2"), "tasks and action points together; removed opportunities' action points left out");
check(all.find((w) => w.id === "a1")?.assignee === S && all.find((w) => w.id === "k2")?.opportunity === "EU Call Ethiopia", "first names resolve; a task can belong to an opportunity");
const week = weekFor(all, S, "2026-10-05", "2026-10-08");
check(week.map((w) => w.id).join() === "k4,a1,k1,k3,k2", "Sammy's week: overdue first, then by date, Everyone's tasks, undated tasks last; next week and old done ones out: " + week.map((w) => w.id).join());
check(!weekFor(all, H, "2026-10-05", "2026-10-08").some((w) => w.id === "k1") && weekFor(all, H, "2026-10-05", "2026-10-08").some((w) => w.id === "k3"), "Hussein doesn't see Sammy's tasks but sees Everyone's");
check(!weekFor(all, S, "2026-09-28", "2026-10-08").some((w) => w.id === "k4"), "a past week shows only what was due in it, no carried-over overdue items");
check(weekFor(all, S, "2026-10-12", "2026-10-08").map((w) => w.id).includes("k5"), "next week shows next week's tasks");

// ── calendar ──
const ev = (id: string, date: string, attendees: string[], start: string | null = "10:00"): TeamEvent => ({ id, title: `Meeting ${id}`, event_date: date, start_time: start, end_time: start ? "11:00" : null, attendees, location: "https://teams.microsoft.com/x", notes: null, tracker_item_id: null, created_by: H, created_at: now });
const events = [ev("e1", "2026-10-08", []), ev("e2", "2026-10-08", [H, C], "09:00"), ev("e3", "2026-10-09", [S])];
const meetingAction = act("a4", "Prep call", S, "2026-10-10", { kind: "meeting", meeting_with: "the donor" });
const prios: KeyPriority[] = [
  { id: "p1", opportunity: "EU Call Ethiopia", deadline: "2026-10-09", lead: "Sammy", sort_order: 0, created_at: now, updated_at: now },
  { id: "p2", opportunity: "Untracked call", deadline: "2026-10-20", lead: "Christine", sort_order: 1, created_at: now, updated_at: now },
  { id: "p3", opportunity: "Undated", deadline: "TBD", lead: null, sort_order: 2, created_at: now, updated_at: now },
];
const allEntries = calendarEntries(events, [...actions, meetingAction], items, prios, null);
check(allEntries.filter((e) => e.kind === "meeting").length === 3 && allEntries.some((e) => e.kind === "action-meeting" && e.title === "Meeting with the donor"), "meetings and meeting action points");
check(allEntries.filter((e) => e.kind === "deadline").map((e) => e.title).join("|") === "Deadline: EU Call Ethiopia|Deadline: Untracked call", "deadlines from the tracker and dated key priorities, no doubles, removed/lost/undated left out");
const day8 = allEntries.filter((e) => e.date === "2026-10-08");
check(day8[0].key === "event-e2" && day8[1].key === "event-e1", "a day's entries by time");
const sammy = calendarEntries(events, [...actions, meetingAction], items, prios, S);
check(sammy.some((e) => e.key === "event-e1") && sammy.some((e) => e.key === "event-e3") && !sammy.some((e) => e.key === "event-e2"), "View as Sammy: whole-team meetings and his own, not others'");
check(!sammy.some((e) => e.title === "Deadline: Untracked call") && sammy.some((e) => e.title === "Deadline: EU Call Ethiopia"), "View as Sammy: deadlines he leads");

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
