"use client";

// Management Dashboard → "Task Manager": the team's own Teams / Asana corner.
//
//   💬 Team chat            channels for the whole team plus direct messages,
//                           with tagging (a tag lands in that person's desk)
//   ✅ Weekly tasks          what each person has on this week: their tasks and
//                           the action points from the opportunities
//   📅 Calendar & meetings   meetings, meeting action points and deadlines
//
// "View as" is the same choice as on the other tabs (lib/viewer.ts).
// Helpers: lib/taskManager.ts. Tables: supabase/management_tools_migration_2026-10-08.sql.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { EVERYONE, LEADS, canonicalLead, effectiveFields, firstName, todayIso } from "@/lib/pipeline";
import { mentionsIn, recipientsFor, tagColor } from "@/lib/mentions";
import { sendNotifications, type NotificationDraft } from "@/lib/collab";
import { setViewer, useViewer } from "@/lib/viewer";
import {
  CHANNELS, addDays, calendarEntries, canSee, dayLabel, dmChannel, dmPartner, isDm, monthGrid, monthLabel, parseDay,
  unreadCount, weekDays, weekFor, weekLabel, weekStart, workItems, type CalendarEntry, type WorkItem,
} from "@/lib/taskManager";
import { MentionText, MentionTextarea } from "@/components/Mentions";
import type { ActionItem, KeyPriority, TeamEvent, TeamMessage, TeamTask, TrackerItem } from "@/lib/types";

const MIGRATION = "The Task Manager needs supabase/management_tools_migration_2026-10-08.sql. Run it once in Supabase.";
const isMissing = (m: string) => /team_messages|team_tasks|team_events|schema cache|does not exist/i.test(m);

type Section = "chat" | "tasks" | "calendar";

const card = "rounded-lg border border-neutral-200 bg-white";
const input = "rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 focus:border-[var(--accent)] focus:outline-none";
const primary = "rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40";

function Avatar({ name, size = 32 }: { name: string | null; size?: number }) {
  const full = canonicalLead(name) ?? "?";
  const initials = full === EVERYONE ? "👥" : full.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
  const c = full === EVERYONE ? { background: "#e5e5e5", color: "#404040" } : tagColor(full);
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold" style={{ ...c, width: size, height: size, fontSize: size * 0.38 }}>
      {initials}
    </span>
  );
}

export default function TaskManager({ items, priorities }: { items: TrackerItem[]; priorities: KeyPriority[] }) {
  const viewer = useViewer();
  const me = canonicalLead(viewer);
  const [section, setSection] = useState<Section>("chat");
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMessages = useCallback(async () => {
    const { data, error: e } = await supabase.from("team_messages").select("*").order("created_at", { ascending: false }).limit(500);
    if (e) {
      if (isMissing(e.message)) setNotice(MIGRATION);
      return;
    }
    setMessages(((data as TeamMessage[]) ?? []).slice().reverse());
  }, []);

  const loadAll = useCallback(async () => {
    const [t, ev, a] = await Promise.all([
      supabase.from("team_tasks").select("*").order("due_date", { ascending: true }),
      supabase.from("team_events").select("*").order("event_date", { ascending: true }),
      supabase.from("action_items").select("*"),
    ]);
    const missing = [t.error, ev.error].find((e) => e && isMissing(e.message));
    if (missing) setNotice(MIGRATION);
    setTasks((t.data as TeamTask[]) ?? []);
    setEvents((ev.data as TeamEvent[]) ?? []);
    setActions((a.data as ActionItem[]) ?? []);
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      loadMessages();
      loadAll();
    }, 0);
    // The chat refreshes every few seconds while the page is open.
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") loadMessages();
    }, 5000);
    const onFocus = () => {
      loadMessages();
      loadAll();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadMessages, loadAll]);

  // Unread messages for the person viewing, across channels they can see.
  const [seen, setSeen] = useSeenMap(me);
  const unreadTotal = useMemo(() => {
    if (!me) return 0;
    const chans = new Set(messages.map((m) => m.channel).filter((c) => canSee(c, me)));
    let n = 0;
    for (const c of chans) n += unreadCount(messages, c, seen[c] ?? null, me);
    return n;
  }, [messages, seen, me]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-neutral-100 p-1">
          {(
            [
              ["chat", "💬 Team chat"],
              ["tasks", "✅ Weekly tasks"],
              ["calendar", "📅 Calendar & meetings"],
            ] as [Section, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSection(k)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${section === k ? "bg-[var(--accent)] text-white" : "text-neutral-600 hover:text-neutral-900"}`}
            >
              {label}
              {k === "chat" && unreadTotal > 0 && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{unreadTotal}</span>}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          View as
          <select value={me ?? ""} onChange={(e) => setViewer(e.target.value || null)} aria-label="View as" className={`${input} min-w-[200px] normal-case tracking-normal`}>
            <option value="">Everyone (whole team)</option>
            {LEADS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {notice && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{notice}</div>}
      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {section === "chat" && <TeamChat me={me} messages={messages} setMessages={setMessages} reload={loadMessages} seen={seen} setSeen={setSeen} onError={setError} />}
      {section === "tasks" && <WeeklyTasks me={me} items={items} tasks={tasks} setTasks={setTasks} actions={actions} setActions={setActions} onError={setError} />}
      {section === "calendar" && <TeamCalendar me={me} items={items} priorities={priorities} events={events} setEvents={setEvents} actions={actions} onError={setError} />}
    </div>
  );
}

// ───────────────────────── read markers ─────────────────────────

function useSeenMap(me: string | null): [Record<string, string>, (channel: string, at: string) => void] {
  const key = `grant-intelligence.chat-seen.${me ?? "anyone"}`;
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        setMap(JSON.parse(window.localStorage.getItem(key) ?? "{}"));
      } catch {
        setMap({});
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [key]);
  const mark = useCallback(
    (channel: string, at: string) => {
      setMap((prev) => {
        if (prev[channel] && prev[channel] >= at) return prev;
        const next = { ...prev, [channel]: at };
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // storage blocked: kept for this visit
        }
        return next;
      });
    },
    [key]
  );
  return [map, mark];
}

// ───────────────────────── team chat ─────────────────────────

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function TeamChat({
  me,
  messages,
  setMessages,
  reload,
  seen,
  setSeen,
  onError,
}: {
  me: string | null;
  messages: TeamMessage[];
  setMessages: (u: (prev: TeamMessage[]) => TeamMessage[]) => void;
  reload: () => void;
  seen: Record<string, string>;
  setSeen: (channel: string, at: string) => void;
  onError: (m: string | null) => void;
}) {
  const [channel, setChannel] = useState("general");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const active = canSee(channel, me) ? channel : "general";
  const shown = useMemo(() => messages.filter((m) => m.channel === active), [messages, active]);
  const others = LEADS.filter((n) => n !== me);

  // Mark as read, and keep the newest message in view.
  const last = shown[shown.length - 1];
  useEffect(() => {
    if (last && me) setSeen(active, last.created_at);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last, active, me, setSeen]);

  async function send() {
    const body = draft.trim();
    if (!body || !me) return;
    setSending(true);
    onError(null);
    const { data, error } = await supabase.from("team_messages").insert({ channel: active, author: me, body }).select().single();
    setSending(false);
    if (error) return onError(isMissing(error.message) ? MIGRATION : error.message);
    setMessages((prev) => [...prev, data as TeamMessage]);
    setDraft("");
    // Anyone tagged gets it in their desk (Application Tracker → My desk).
    const where = isDm(active) ? "a direct message" : `#${active}`;
    const people = isDm(active) ? [...mentionsIn(body), dmPartner(active, me) ?? ""].filter(Boolean) : mentionsIn(body);
    const drafts: NotificationDraft[] = recipientsFor([...new Set(people)], me).map((recipient) => ({
      recipient,
      kind: "chat",
      tracker_item_id: null,
      note_id: null,
      action_id: null,
      reply_id: null,
      from_person: me,
      excerpt: `${where}: ${body.length > 200 ? `${body.slice(0, 199)}…` : body}`,
    }));
    if (drafts.length) await sendNotifications(drafts);
    reload();
  }

  async function remove(m: TeamMessage) {
    if (!confirm("Delete this message for everyone?")) return;
    const { error } = await supabase.from("team_messages").delete().eq("id", m.id);
    if (error) return onError(error.message);
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
  }

  const badge = (c: string) => {
    const n = me && c !== active ? unreadCount(messages, c, seen[c] ?? null, me) : 0;
    return n > 0 ? <span className="ml-auto rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{n}</span> : null;
  };
  const channelBtn = (c: string, label: React.ReactNode) => (
    <button
      key={c}
      onClick={() => setChannel(c)}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${active === c ? "bg-[var(--accent)] font-semibold text-white" : "text-neutral-700 hover:bg-neutral-100"}`}
    >
      {label}
      {badge(c)}
    </button>
  );

  const about = isDm(active) ? `Direct message with ${dmPartner(active, me)}` : CHANNELS.find((c) => c.key === active)?.about ?? "";

  return (
    <div className={`${card} grid min-h-[560px] overflow-hidden md:grid-cols-[230px_1fr]`}>
      <aside className="flex flex-col gap-4 border-b border-neutral-200 bg-neutral-50 p-3 md:border-b-0 md:border-r">
        <div>
          <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Channels</p>
          {CHANNELS.map((c) => channelBtn(c.key, <span># {c.label}</span>))}
        </div>
        <div>
          <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Direct messages</p>
          {me ? (
            others.map((n) =>
              channelBtn(
                dmChannel(me, n),
                <span className="flex items-center gap-2">
                  <Avatar name={n} size={20} />
                  {n}
                </span>
              )
            )
          ) : (
            <p className="px-1 text-xs text-neutral-500">Pick your name in “View as” to send direct messages.</p>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 flex-col">
        <header className="border-b border-neutral-200 px-4 py-2.5">
          <p className="font-semibold text-neutral-800">{isDm(active) ? dmPartner(active, me) : `# ${active}`}</p>
          <p className="text-xs text-neutral-500">{about}</p>
        </header>
        <div ref={listRef} className="flex max-h-[460px] min-h-[300px] flex-1 flex-col gap-0.5 overflow-y-auto px-4 py-3" aria-label="Messages">
          {shown.length === 0 && <p className="m-auto text-sm text-neutral-400">No messages yet. Say hello 👋</p>}
          {shown.map((m, i) => {
            const prev = shown[i - 1];
            const grouped = prev && prev.author === m.author && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
            const newDay = !prev || prev.created_at.slice(0, 10) !== m.created_at.slice(0, 10);
            return (
              <div key={m.id}>
                {newDay && (
                  <div className="my-2 flex items-center gap-2 text-[11px] text-neutral-400">
                    <span className="h-px flex-1 bg-neutral-200" />
                    {dayLabel(m.created_at.slice(0, 10))}
                    <span className="h-px flex-1 bg-neutral-200" />
                  </div>
                )}
                <div className={`group flex gap-3 rounded-md px-1 hover:bg-neutral-50 ${grouped && !newDay ? "" : "mt-2"}`}>
                  <div className="w-8">{(!grouped || newDay) && <Avatar name={m.author} />}</div>
                  <div className="min-w-0 flex-1">
                    {(!grouped || newDay) && (
                      <p className="text-sm">
                        <span className="font-semibold text-neutral-800">{canonicalLead(m.author) ?? "Someone"}</span>
                        <span className="ml-2 text-[11px] text-neutral-400">{timeOf(m.created_at)}</span>
                      </p>
                    )}
                    <p className="whitespace-pre-wrap break-words text-sm text-neutral-800">
                      <MentionText text={m.body} />
                    </p>
                  </div>
                  {me && canonicalLead(m.author) === me && (
                    <button onClick={() => remove(m)} className="self-start text-xs text-neutral-300 opacity-0 hover:text-red-500 group-hover:opacity-100" title="Delete">
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <footer className="border-t border-neutral-200 p-3">
          {me ? (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <MentionTextarea
                  value={draft}
                  onChange={setDraft}
                  minRows={1}
                  ariaLabel="Message"
                  placeholder={`Message ${isDm(active) ? firstName(dmPartner(active, me)) : `#${active}`} · type a name to tag someone · Ctrl+Enter to send`}
                  onSubmit={send}
                  hint={false}
                />
              </div>
              <button onClick={send} disabled={!draft.trim() || sending} className={primary}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">Pick your name in “View as” above to write in the chat.</p>
          )}
        </footer>
      </section>
    </div>
  );
}

// ───────────────────────── weekly tasks ─────────────────────────

const KIND_ICON: Record<string, string> = { task: "✔︎", meeting: "🤝", review: "👀", input: "🙋" };

function WeeklyTasks({
  me,
  items,
  tasks,
  setTasks,
  actions,
  setActions,
  onError,
}: {
  me: string | null;
  items: TrackerItem[];
  tasks: TeamTask[];
  setTasks: (u: (prev: TeamTask[]) => TeamTask[]) => void;
  actions: ActionItem[];
  setActions: (u: (prev: ActionItem[]) => ActionItem[]) => void;
  onError: (m: string | null) => void;
}) {
  const today = todayIso();
  const [monday, setMonday] = useState(weekStart(today));
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState<string>(me ?? EVERYONE);
  const [due, setDue] = useState(today);
  const [opp, setOpp] = useState("");
  const [saving, setSaving] = useState(false);

  const all = useMemo(() => workItems(tasks, actions, items), [tasks, actions, items]);
  const people = me ? [me] : LEADS;
  const days = weekDays(monday);
  const live = useMemo(() => items.filter((i) => !i.removed_at && i.status !== "lost"), [items]);

  async function add() {
    if (!title.trim()) return;
    setSaving(true);
    onError(null);
    const { data, error } = await supabase
      .from("team_tasks")
      .insert({ title: title.trim(), assignee: assignee || null, due_date: due || null, tracker_item_id: opp || null, created_by: me })
      .select()
      .single();
    setSaving(false);
    if (error) return onError(isMissing(error.message) ? MIGRATION : error.message);
    setTasks((prev) => [...prev, data as TeamTask]);
    setTitle("");
    if (assignee && assignee !== me && assignee !== EVERYONE) {
      await sendNotifications([{ recipient: assignee, kind: "mention", tracker_item_id: opp || null, note_id: null, action_id: null, reply_id: null, from_person: me, excerpt: `New task for you: ${title.trim()}` }]);
    }
  }

  async function toggle(w: WorkItem) {
    const now = new Date().toISOString();
    const patch = { done: !w.done, done_at: w.done ? null : now };
    const { error } = await supabase.from(w.source === "task" ? "team_tasks" : "action_items").update(patch).eq("id", w.id);
    if (error) return onError(error.message);
    if (w.source === "task") setTasks((prev) => prev.map((t) => (t.id === w.id ? { ...t, ...patch } : t)));
    else setActions((prev) => prev.map((a) => (a.id === w.id ? { ...a, ...patch } : a)));
  }

  async function remove(w: WorkItem) {
    if (w.source !== "task" || !confirm("Delete this task?")) return;
    const { error } = await supabase.from("team_tasks").delete().eq("id", w.id);
    if (error) return onError(error.message);
    setTasks((prev) => prev.filter((t) => t.id !== w.id));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={`${card} flex flex-wrap items-center justify-between gap-3 p-3`}>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonday(addDays(monday, -7))} className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50" aria-label="Previous week">
            ‹
          </button>
          <p className="min-w-[170px] text-center text-sm font-semibold text-neutral-800">{weekLabel(monday)}</p>
          <button onClick={() => setMonday(addDays(monday, 7))} className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50" aria-label="Next week">
            ›
          </button>
          {monday !== weekStart(today) && (
            <button onClick={() => setMonday(weekStart(today))} className="text-xs font-medium text-[var(--accent)] hover:underline">
              This week
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="New task, e.g. Send the budget to Christine" className={`${input} w-72`} aria-label="New task" />
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={input} aria-label="For">
            <option value={EVERYONE}>👥 Everyone</option>
            {LEADS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={input} aria-label="Due" />
          <select value={opp} onChange={(e) => setOpp(e.target.value)} className={`${input} max-w-[200px]`} aria-label="Opportunity">
            <option value="">No opportunity</option>
            {live.map((i) => (
              <option key={i.id} value={i.id}>
                {effectiveFields(i).programName || "(untitled)"}
              </option>
            ))}
          </select>
          <button onClick={add} disabled={!title.trim() || saving} className={primary}>
            + Add task
          </button>
        </div>
      </div>

      <div className={`grid gap-3 ${people.length === 1 ? "" : "md:grid-cols-2 xl:grid-cols-4"}`}>
        {people.map((p) => {
          const list = weekFor(all, p, monday, today);
          const open = list.filter((w) => !w.done).length;
          return (
            <section key={p} className={`${card} flex flex-col`} aria-label={`${p}'s week`}>
              <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2.5">
                <Avatar name={p} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-neutral-800">{p}</p>
                  <p className="text-[11px] text-neutral-500">
                    {open} open · {list.length - open} done
                  </p>
                </div>
              </header>
              <ul className="flex flex-col divide-y divide-neutral-100">
                {list.length === 0 && <li className="px-3 py-6 text-center text-sm text-neutral-400">Nothing this week.</li>}
                {list.map((w) => {
                  const overdue = !w.done && !!w.due && w.due < today;
                  const inWeek = !!w.due && days.includes(w.due);
                  return (
                    <li key={w.key} className="group flex items-start gap-2 px-3 py-2">
                      <input type="checkbox" checked={w.done} onChange={() => toggle(w)} className="mt-1 h-4 w-4 accent-[var(--accent)]" aria-label={`Done: ${w.title}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm ${w.done ? "text-neutral-400 line-through" : "text-neutral-800"}`}>
                          {w.source === "action" && <span className="mr-1">{KIND_ICON[w.kind] ?? "✔︎"}</span>}
                          <MentionText text={w.title} />
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className={overdue ? "font-semibold text-red-600" : inWeek ? "text-neutral-500" : "text-neutral-400"}>
                            {w.due ? `${overdue ? "Overdue · " : ""}${dayLabel(w.due)}` : "No date"}
                          </span>
                          {w.assignee === EVERYONE && <span className="rounded-full bg-neutral-100 px-1.5 text-neutral-600">👥 Everyone</span>}
                          {w.opportunity && <span className="max-w-[180px] truncate rounded-full bg-orange-50 px-1.5 text-[var(--accent)]">{w.opportunity}</span>}
                          <span className="text-neutral-400">{w.source === "action" ? "action point" : "task"}</span>
                        </p>
                      </div>
                      {w.source === "task" && (
                        <button onClick={() => remove(w)} className="text-xs text-neutral-300 opacity-0 hover:text-red-500 group-hover:opacity-100" title="Delete">
                          ✕
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="text-xs text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.45)]">
        Each list shows the person&apos;s tasks and their action points from the opportunities due this week, anything overdue, and tasks with no date. Ticking an action point here ticks it in the Application Tracker too.
      </p>
    </div>
  );
}

// ───────────────────────── calendar and meetings ─────────────────────────

const ENTRY_STYLE: Record<CalendarEntry["kind"], string> = {
  meeting: "bg-blue-100 text-blue-800",
  "action-meeting": "bg-violet-100 text-violet-800",
  deadline: "bg-red-100 text-red-700",
};

function TeamCalendar({
  me,
  items,
  priorities,
  events,
  setEvents,
  actions,
  onError,
}: {
  me: string | null;
  items: TrackerItem[];
  priorities: KeyPriority[];
  events: TeamEvent[];
  setEvents: (u: (prev: TeamEvent[]) => TeamEvent[]) => void;
  actions: ActionItem[];
  onError: (m: string | null) => void;
}) {
  const today = todayIso();
  const t = parseDay(today);
  const [ym, setYm] = useState({ y: t.getFullYear(), m: t.getMonth() });
  const [selected, setSelected] = useState(today);
  const entries = useMemo(() => calendarEntries(events, actions, items, priorities, me), [events, actions, items, priorities, me]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [entries]);
  const grid = monthGrid(ym.y, ym.m);
  const monthPrefix = `${ym.y}-${String(ym.m + 1).padStart(2, "0")}`;
  const dayEntries = byDay.get(selected) ?? [];
  const upcoming = entries.filter((e) => e.date >= today && e.date <= addDays(today, 14) && e.kind !== "deadline").slice(0, 8);

  const move = (delta: number) => setYm(({ y, m }) => ({ y: m + delta < 0 ? y - 1 : m + delta > 11 ? y + 1 : y, m: (m + delta + 12) % 12 }));

  async function removeEvent(id: string) {
    if (!confirm("Delete this meeting for everyone?")) return;
    const { error } = await supabase.from("team_events").delete().eq("id", id);
    if (error) return onError(error.message);
    setEvents((prev) => prev.filter((e) => e.id !== id));
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
      <section className={`${card} p-3`} aria-label="Calendar">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => move(-1)} className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50" aria-label="Previous month">
              ‹
            </button>
            <p className="min-w-[150px] text-center font-semibold text-neutral-800">{monthLabel(ym.y, ym.m)}</p>
            <button onClick={() => move(1)} className="rounded-md border border-neutral-300 px-2.5 py-1 text-sm hover:bg-neutral-50" aria-label="Next month">
              ›
            </button>
            <button
              onClick={() => {
                setYm({ y: t.getFullYear(), m: t.getMonth() });
                setSelected(today);
              }}
              className="text-xs font-medium text-[var(--accent)] hover:underline"
            >
              Today
            </button>
          </div>
          <p className="hidden gap-2 text-[11px] sm:flex">
            <span className="rounded bg-blue-100 px-1.5 text-blue-800">Meeting</span>
            <span className="rounded bg-violet-100 px-1.5 text-violet-800">Meeting action point</span>
            <span className="rounded bg-red-100 px-1.5 text-red-700">Deadline</span>
          </p>
        </div>
        <div className="grid grid-cols-7 border-l border-t border-neutral-200 text-xs">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="border-b border-r border-neutral-200 bg-neutral-50 px-2 py-1 font-semibold text-neutral-500">
              {d}
            </div>
          ))}
          {grid.map((d) => {
            const list = byDay.get(d) ?? [];
            const inMonth = d.startsWith(monthPrefix);
            return (
              <button
                key={d}
                onClick={() => setSelected(d)}
                className={`flex min-h-[92px] flex-col gap-0.5 border-b border-r border-neutral-200 p-1 text-left align-top hover:bg-orange-50/50 ${inMonth ? "bg-white" : "bg-neutral-50 text-neutral-400"} ${selected === d ? "ring-2 ring-inset ring-[var(--accent)]" : ""}`}
                aria-label={dayLabel(d)}
              >
                <span className={`mb-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${d === today ? "bg-[var(--accent)] font-bold text-white" : ""}`}>{parseDay(d).getDate()}</span>
                {list.slice(0, 3).map((e) => (
                  <span key={e.key} className={`truncate rounded px-1 text-[10.5px] leading-4 ${ENTRY_STYLE[e.kind]}`} title={e.title}>
                    {e.time ? `${e.time.split("–")[0]} ` : ""}
                    {e.title}
                  </span>
                ))}
                {list.length > 3 && <span className="px-1 text-[10px] text-neutral-500">+{list.length - 3} more</span>}
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex flex-col gap-3">
        <section className={`${card} p-3`} aria-label="Selected day">
          <p className="mb-2 text-sm font-semibold text-neutral-800">{dayLabel(selected)}</p>
          {dayEntries.length === 0 && <p className="text-sm text-neutral-400">Nothing on this day.</p>}
          <ul className="flex flex-col gap-2">
            {dayEntries.map((e) => (
              <li key={e.key} className={`rounded-md px-2.5 py-2 text-sm ${ENTRY_STYLE[e.kind]}`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">
                    {e.time && <span className="mr-1 tabular-nums">{e.time}</span>}
                    {e.title}
                  </p>
                  {e.eventId && (
                    <button onClick={() => removeEvent(e.eventId as string)} className="text-xs opacity-50 hover:opacity-100" title="Delete">
                      ✕
                    </button>
                  )}
                </div>
                {e.detail && (/^https?:\/\//i.test(e.detail) ? <a href={e.detail} target="_blank" rel="noopener noreferrer" className="break-all text-xs underline">Join link ↗</a> : <p className="text-xs opacity-80">{e.detail}</p>)}
                <p className="mt-0.5 text-[11px] opacity-70">{e.people.length ? e.people.map((p) => firstName(p) || p).join(", ") : "Whole team"}</p>
              </li>
            ))}
          </ul>
        </section>
        <NewMeeting date={selected} me={me} items={items} onSaved={(ev) => setEvents((prev) => [...prev, ev])} onError={onError} />
        <section className={`${card} p-3`} aria-label="Coming up">
          <p className="mb-2 text-sm font-semibold text-neutral-800">Coming up · next 2 weeks{me ? ` · ${firstName(me)}` : ""}</p>
          {upcoming.length === 0 && <p className="text-sm text-neutral-400">No meetings planned.</p>}
          <ul className="flex flex-col gap-1 text-sm">
            {upcoming.map((e) => (
              <li key={e.key} className="flex gap-2">
                <span className="w-24 shrink-0 text-xs text-neutral-500">{dayLabel(e.date)}</span>
                <span className="text-neutral-800">
                  {e.time && <span className="mr-1 tabular-nums text-neutral-500">{e.time.split("–")[0]}</span>}
                  {e.title}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function NewMeeting({ date, me, items, onSaved, onError }: { date: string; me: string | null; items: TrackerItem[]; onSaved: (e: TeamEvent) => void; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(date);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("11:00");
  const [people, setPeople] = useState<string[]>([]);
  const [where, setWhere] = useState("");
  const [opp, setOpp] = useState("");
  const [saving, setSaving] = useState(false);
  const live = items.filter((i) => !i.removed_at && i.status !== "lost");

  useEffect(() => {
    const t = window.setTimeout(() => setDay(date), 0);
    return () => window.clearTimeout(t);
  }, [date]);

  async function save() {
    if (!title.trim() || !day) return;
    setSaving(true);
    onError(null);
    const { data, error } = await supabase
      .from("team_events")
      .insert({ title: title.trim(), event_date: day, start_time: start || null, end_time: end || null, attendees: people, location: where.trim() || null, tracker_item_id: opp || null, created_by: me })
      .select()
      .single();
    setSaving(false);
    if (error) return onError(isMissing(error.message) ? MIGRATION : error.message);
    onSaved(data as TeamEvent);
    const invited = recipientsFor(people.length ? people : [EVERYONE], me);
    if (invited.length) {
      await sendNotifications(invited.map((recipient) => ({ recipient, kind: "mention", tracker_item_id: opp || null, note_id: null, action_id: null, reply_id: null, from_person: me, excerpt: `Meeting ${dayLabel(day)}${start ? ` at ${start}` : ""}: ${title.trim()}` })));
    }
    setTitle("");
    setWhere("");
    setPeople([]);
    setOpen(false);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${card} px-3 py-2 text-left text-sm font-medium text-[var(--accent)] hover:bg-orange-50`}>
        + Schedule a meeting on {dayLabel(date)}
      </button>
    );
  }
  return (
    <section className={`${card} flex flex-col gap-2 p-3`} aria-label="New meeting">
      <p className="text-sm font-semibold text-neutral-800">New meeting</p>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly grants check-in" className={input} aria-label="Meeting title" autoFocus />
      <div className="flex flex-wrap gap-2">
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={input} aria-label="Date" />
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={input} aria-label="Starts" />
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={input} aria-label="Ends" />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Who">
        {LEADS.map((n) => {
          const on = people.includes(n);
          return (
            <button key={n} type="button" onClick={() => setPeople((prev) => (on ? prev.filter((x) => x !== n) : [...prev, n]))} className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-[var(--accent)] bg-orange-50 font-semibold text-[var(--accent)]" : "border-neutral-300 text-neutral-600"}`} aria-pressed={on}>
              {firstName(n)}
            </button>
          );
        })}
        <span className="self-center text-[11px] text-neutral-400">{people.length ? "" : "nobody picked = whole team"}</span>
      </div>
      <input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="Where: room, or a Teams / Meet link" className={input} aria-label="Where" />
      <select value={opp} onChange={(e) => setOpp(e.target.value)} className={input} aria-label="About">
        <option value="">Not about one opportunity</option>
        {live.map((i) => (
          <option key={i.id} value={i.id}>
            {effectiveFields(i).programName || "(untitled)"}
          </option>
        ))}
      </select>
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="rounded-md px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100">
          Cancel
        </button>
        <button onClick={save} disabled={!title.trim() || saving} className={primary}>
          {saving ? "Saving…" : "Save meeting"}
        </button>
      </div>
    </section>
  );
}
