"use client";

// "My desk": everything waiting for the person picked in "Viewing as", open
// straight away at the top of the Application Tracker (no dropdown):
//   • For you to do — action points assigned to you or to Everyone
//   • Tagged & replies — where someone tagged you (Hussein, @Hussein,
//     @Everyone), replied to your action point, or removed your opportunity
//   • Waiting on others — what you asked someone else to do, with their replies
// Refreshes every minute and when you come back to the tab.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { supabase } from "@/lib/supabaseClient";
import { canonicalLead, effectiveFields, firstName } from "@/lib/pipeline";
import { deskFor, friendlyError, markSeen } from "@/lib/collab";
import type { ActionItem, ActionReply, TeamNotification, TrackerItem } from "@/lib/types";
import { ActionRow, useReplies } from "@/components/OpportunityBreakdown";
import { MentionText } from "@/components/Mentions";

const REFRESH_MS = 60_000;
const OPEN_KEY = "grant-intelligence.desk-open";

const KIND_TEXT: Record<string, { icon: string; verb: string }> = {
  mention: { icon: "🏷️", verb: "tagged you" },
  everyone: { icon: "👥", verb: "tagged everyone" },
  reply: { icon: "💬", verb: "replied" },
  removed: { icon: "🗑️", verb: "removed your opportunity" },
  chat: { icon: "💬", verb: "tagged you in the team chat" },
};

// Open or folded — remembered per browser.
const OPEN_EVENT = "grant-intelligence-desk-open";
let openFallback = true;
function readOpen(): boolean {
  try {
    const v = window.localStorage.getItem(OPEN_KEY);
    return v === null ? openFallback : v !== "0";
  } catch {
    return openFallback;
  }
}
function writeOpen(next: boolean) {
  openFallback = next;
  try {
    window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
  } catch {
    // remembered for this visit only
  }
  window.dispatchEvent(new Event(OPEN_EVENT));
}
function subscribeOpen(cb: () => void) {
  window.addEventListener(OPEN_EVENT, cb);
  return () => window.removeEventListener(OPEN_EVENT, cb);
}

const ago = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
};

export default function TeamInbox({
  viewer,
  items,
  actions,
  onToggleAction,
  onOpen,
  onRefresh,
}: {
  viewer: string | null;
  items: TrackerItem[];
  actions: ActionItem[];
  onToggleAction: (a: ActionItem) => void;
  /** Open an opportunity's Breakdown (and scroll to a note, if given). */
  onOpen: (trackerItemId: string, anchorId?: string) => void;
  /** Reload action points (they live in the tracker page). */
  onRefresh?: () => void;
}) {
  const [notifications, setNotifications] = useState<TeamNotification[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const open = useSyncExternalStore(subscribeOpen, readOpen, () => true);
  const [showWaiting, setShowWaiting] = useState(false);
  const [openThread, setOpenThread] = useState<string | null>(null);

  const load = useCallback(async () => {
    const me = canonicalLead(viewer);
    if (!me) return;
    const { data, error } = await supabase
      .from("team_notifications")
      .select("*")
      .eq("recipient", me)
      .is("seen_at", null)
      .order("created_at", { ascending: false })
      .limit(100);
    setNotice(error ? friendlyError(error.message) : null);
    setNotifications((data ?? []) as TeamNotification[]);
  }, [viewer]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const tick = () => {
      load();
      onRefresh?.();
    };
    const timer = setInterval(tick, REFRESH_MS);
    const onFocus = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load, onRefresh]);

  const desk = useMemo(() => deskFor(viewer, { items, actions, notifications }), [viewer, items, actions, notifications]);
  const threadItemIds = useMemo(
    () => [...new Set([...desk.open, ...desk.asked].map((a) => a.tracker_item_id).concat(desk.mentions.map((n) => n.tracker_item_id ?? "").filter(Boolean)))].sort(),
    [desk]
  );
  const [replies, setReplies] = useReplies(threadItemIds);

  const titleOf = (id: string | null) => {
    const it = items.find((i) => i.id === id);
    if (!it) return "(removed opportunity)";
    const eff = effectiveFields(it);
    const lead = canonicalLead(it.owner);
    return `${eff.programName || "(untitled)"}${lead ? ` · ${firstName(lead)}'s application` : ""}`;
  };

  async function seen(ids: string[]) {
    const err = await markSeen(ids);
    if (err) return setNotice(err);
    setNotifications((prev) => prev.filter((n) => !ids.includes(n.id)));
  }

  const toggle = (next: boolean) => writeOpen(next);

  function onReplied(r: ActionReply) {
    setReplies((prev) => [...prev, r]);
    // replying answers the tags/replies about that action point
    const answered = desk.mentions.filter((n) => n.action_id === r.action_id).map((n) => n.id);
    if (answered.length) seen(answered);
  }

  if (!viewer) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-500">
        Choose your name in “Viewing as” to see your desk: your action points, where you were tagged, and replies.
      </div>
    );
  }

  const total = desk.open.length + desk.mentions.length;
  const actionById = new Map(actions.map((a) => [a.id, a]));

  return (
    <section aria-label="My desk" className="rounded-lg border border-orange-200 bg-orange-50/90 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button onClick={() => toggle(!open)} className="flex flex-wrap items-center gap-2 text-left" aria-expanded={open}>
          <span className="text-sm font-semibold text-neutral-800">🗂️ {firstName(viewer)}&apos;s desk</span>
          <Chip tone={desk.overdue ? "red" : desk.open.length ? "orange" : "green"}>
            {desk.open.length ? `${desk.open.length} to do` : "Nothing to do"}
            {desk.overdue ? ` · ${desk.overdue} overdue` : ""}
          </Chip>
          {desk.mentions.length > 0 && <Chip tone="blue">{desk.mentions.length} new tag{desk.mentions.length > 1 ? "s" : ""} &amp; repl{desk.mentions.length > 1 ? "ies" : "y"}</Chip>}
          {desk.asked.length > 0 && <Chip tone="grey">{desk.asked.length} waiting on others</Chip>}
          <span className="text-xs text-neutral-400">{open ? "▴" : "▾"}</span>
        </button>
        {open && desk.mentions.length > 1 && (
          <button onClick={() => seen(desk.mentions.map((n) => n.id))} className="text-xs font-medium text-neutral-500 hover:text-neutral-800">
            Mark all tags as seen
          </button>
        )}
      </div>

      {notice && <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{notice}</p>}

      {open && (
        <div className="mt-3 flex flex-col gap-4">
          {total === 0 && desk.asked.length === 0 && <p className="text-sm text-emerald-700">All clear — nothing waiting for you. 🎉</p>}

          {desk.open.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">For you to do</p>
              <ul className="flex flex-col gap-2">
                {desk.open.map((a) => (
                  <DeskRow key={a.id} onOpen={() => onOpen(a.tracker_item_id)}>
                    <ActionRow
                      a={a}
                      opportunity={titleOf(a.tracker_item_id)}
                      onToggle={onToggleAction}
                      showOpportunity
                      viewer={viewer}
                      replies={replies.filter((r) => r.action_id === a.id)}
                      onReplied={onReplied}
                      onError={setNotice}
                    />
                  </DeskRow>
                ))}
              </ul>
            </div>
          )}

          {desk.mentions.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Tagged &amp; replies</p>
              <ul className="flex flex-col gap-2">
                {desk.mentions.map((n) => {
                  const k = KIND_TEXT[n.kind] ?? KIND_TEXT.mention;
                  const action = n.action_id ? actionById.get(n.action_id) : undefined;
                  const where = n.note_id ? "in meeting notes" : n.action_id ? (n.reply_id ? "on an action point" : "in an action point") : "";
                  return (
                    <li key={n.id} className="rounded-md border border-white bg-white/80 px-3 py-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="text-xs text-neutral-500">
                            {k.icon} <span className="font-semibold text-neutral-700">{n.from_person ? firstName(n.from_person) : "Someone"}</span> {k.verb} {where}
                            {n.tracker_item_id && <> · <span className="text-neutral-600">{titleOf(n.tracker_item_id)}</span></>} · {ago(n.created_at)}
                          </p>
                          {n.excerpt && (
                            <p className="mt-0.5 whitespace-pre-wrap text-neutral-700">
                              <MentionText text={n.excerpt} />
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-xs">
                          {action && (
                            <button onClick={() => setOpenThread(openThread === n.id ? null : n.id)} className="font-medium text-neutral-600 hover:text-[var(--accent)]">
                              💬 Reply
                            </button>
                          )}
                          {n.tracker_item_id && n.kind !== "removed" && (
                            <button
                              onClick={() => {
                                onOpen(n.tracker_item_id as string, n.note_id ? `note-${n.note_id}` : undefined);
                                seen([n.id]);
                              }}
                              className="font-medium text-[var(--accent)] hover:underline"
                            >
                              Open →
                            </button>
                          )}
                          <button onClick={() => seen([n.id])} className="font-medium text-neutral-500 hover:text-emerald-700" title="Mark as seen">
                            ✓ Seen
                          </button>
                        </div>
                      </div>
                      {action && openThread === n.id && (
                        <ul className="mt-2 border-t border-neutral-100 pt-2">
                          <ActionRow
                            a={action}
                            opportunity={titleOf(action.tracker_item_id)}
                            onToggle={onToggleAction}
                            viewer={viewer}
                            replies={replies.filter((r) => r.action_id === action.id)}
                            onReplied={onReplied}
                            onError={setNotice}
                            startOpen
                          />
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {desk.asked.length > 0 && (
            <div>
              <button onClick={() => setShowWaiting(!showWaiting)} className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 hover:text-neutral-800">
                Waiting on others ({desk.asked.length}) {showWaiting ? "▴" : "▾"}
              </button>
              {showWaiting && (
                <ul className="flex flex-col gap-2">
                  {desk.asked.map((a) => (
                    <DeskRow key={a.id} onOpen={() => onOpen(a.tracker_item_id)}>
                      <ActionRow
                        a={a}
                        opportunity={titleOf(a.tracker_item_id)}
                        onToggle={onToggleAction}
                        showOpportunity
                        viewer={viewer}
                        replies={replies.filter((r) => r.action_id === a.id)}
                        onReplied={onReplied}
                        onError={setNotice}
                      />
                    </DeskRow>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DeskRow({ children, onOpen }: { children: React.ReactNode; onOpen: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-white bg-white/80 px-3 py-2">
      <ul className="min-w-0 flex-1">{children}</ul>
      <button onClick={onOpen} className="shrink-0 pt-0.5 text-xs font-medium text-[var(--accent)] hover:underline">
        Open →
      </button>
    </div>
  );
}

function Chip({ tone, children }: { tone: "red" | "orange" | "green" | "blue" | "grey"; children: React.ReactNode }) {
  const cls = {
    red: "bg-red-100 text-red-700",
    orange: "bg-orange-100 text-orange-700",
    green: "bg-emerald-50 text-emerald-700",
    blue: "bg-sky-100 text-sky-800",
    grey: "bg-neutral-100 text-neutral-600",
  }[tone];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}
