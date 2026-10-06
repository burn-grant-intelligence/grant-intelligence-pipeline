"use client";

// Header bell, on every tab: how much is waiting in your desk (open action
// points + new tags and replies). Click it to open your desk in the
// Application Tracker. Refreshes every minute.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { firstName, canonicalLead } from "@/lib/pipeline";
import { deskFor } from "@/lib/collab";
import { useViewer } from "@/lib/viewer";
import type { ActionItem, TeamNotification, TrackerItem } from "@/lib/types";

const REFRESH_MS = 60_000;

export default function DeskBell({ onOpen }: { onOpen: () => void }) {
  const viewer = useViewer();
  const [counts, setCounts] = useState<{ todo: number; tags: number; overdue: number } | null>(null);

  const load = useCallback(async () => {
    const me = canonicalLead(viewer);
    if (!me) return setCounts(null);
    const [items, actions, notes] = await Promise.all([
      supabase.from("tracker_items").select("*"),
      supabase.from("action_items").select("*").eq("done", false),
      supabase.from("team_notifications").select("*").eq("recipient", me).is("seen_at", null),
    ]);
    const desk = deskFor(me, {
      items: (items.data ?? []) as TrackerItem[],
      actions: (actions.data ?? []) as ActionItem[],
      notifications: notes.error ? [] : ((notes.data ?? []) as TeamNotification[]),
    });
    setCounts({ todo: desk.open.length, tags: desk.mentions.length, overdue: desk.overdue });
  }, [viewer]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, REFRESH_MS);
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  if (!viewer) {
    return (
      <button onClick={onOpen} className="rounded-full bg-white/80 px-3 py-1.5 text-xs font-medium text-[var(--ink)] shadow-sm hover:bg-white" title="Pick your name in “Viewing as” (Application Tracker) to see your desk">
        👤 Choose your name
      </button>
    );
  }
  const total = (counts?.todo ?? 0) + (counts?.tags ?? 0);
  const tone = counts?.overdue ? "bg-red-600 text-white" : total ? "bg-[var(--accent)] text-white" : "bg-emerald-600 text-white";
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-2 rounded-full bg-white/90 px-3 py-1.5 text-sm font-medium text-[var(--ink)] shadow-sm hover:bg-white"
      title={counts ? `${counts.todo} to do${counts.overdue ? ` (${counts.overdue} overdue)` : ""} · ${counts.tags} new tag(s) & replies — open your desk` : "Open your desk"}
      aria-label={`${firstName(viewer)}'s desk: ${total} waiting`}
    >
      🔔 {firstName(viewer)}
      <span className={`min-w-6 rounded-full px-1.5 text-center text-xs font-semibold ${tone}`}>{counts ? total : "…"}</span>
    </button>
  );
}
