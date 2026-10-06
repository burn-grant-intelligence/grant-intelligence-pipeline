"use client";

// The Claude button for one stage of an application (Concept or First draft).
//
//   No chat yet   → "✨ Start concept in Claude": copies the stage prompt, opens
//                   BURN's Claude project, and asks for the new chat's link.
//   Started       → the link box stays open, and everyone sees who started it,
//                   so nobody opens a second chat by accident.
//   Linked        → "✨ Open concept chat ↗" opens the same chat every time,
//                   for the whole team.
// Helpers: lib/claudeLinks.ts.

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { CLAUDE_PROJECT_URL } from "@/lib/drafting";
import { canonicalLead, firstName, fmtDate } from "@/lib/pipeline";
import { claudeState, cleanClaudeUrl, stageWord } from "@/lib/claudeLinks";
import type { DraftStage, DraftStageWork, TrackerItem } from "@/lib/types";

const MIGRATION = "Saving Claude links needs supabase/draft_claude_links_migration_2026-10-07.sql — run it in Supabase.";
const friendly = (m: string) => (/claude_|schema cache|does not exist/i.test(m) ? MIGRATION : m);

export default function StageClaude({
  item,
  stage,
  work,
  viewer,
  prompt,
  onSaved,
  compact = false,
  readOnly = false,
}: {
  item: TrackerItem;
  stage: DraftStage;
  work: DraftStageWork | null;
  viewer: string | null;
  /** The stage prompt (built only when needed). */
  prompt: () => string;
  onSaved: (row: DraftStageWork) => void;
  compact?: boolean;
  /** Submitted: only open the chat, if there is one. */
  readOnly?: boolean;
}) {
  const state = claudeState(work);
  const word = stageWord(stage);
  const [linking, setLinking] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = canonicalLead(viewer);
  const showBox = !readOnly && (linking || state === "started");

  async function save(patch: Partial<DraftStageWork>): Promise<boolean> {
    setBusy(true);
    const { data, error: e } = await supabase
      .from("draft_stage_work")
      .upsert({ tracker_item_id: item.id, stage, ...patch, updated_at: new Date().toISOString() }, { onConflict: "tracker_item_id,stage" })
      .select()
      .single();
    setBusy(false);
    if (e) {
      setError(friendly(e.message));
      return false;
    }
    onSaved(data as DraftStageWork);
    return true;
  }

  async function start() {
    if (state === "started" && !confirm(`${firstName(work?.claude_started_by) || "Someone"} already started a ${word} chat. Start another one anyway?`)) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(prompt());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      // Clipboard can be blocked in some browsers — the project still opens.
    }
    window.open(CLAUDE_PROJECT_URL, "_blank", "noopener,noreferrer");
    await save({ claude_started_by: me, claude_started_at: new Date().toISOString() });
    setLinking(true);
  }

  async function link() {
    const { url, error: e } = cleanClaudeUrl(draft);
    if (e || !url) return setError(e ?? "Paste the chat link first.");
    setError(null);
    if (await save({ claude_url: url, claude_url_by: me, claude_url_at: new Date().toISOString() })) {
      setDraft("");
      setLinking(false);
    }
  }

  const btn = compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";

  if (readOnly && state !== "linked") return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {state === "linked" ? (
          <a
            href={work!.claude_url!}
            target="_blank"
            rel="noopener noreferrer"
            className={`rounded-md bg-[var(--accent)] font-semibold text-white hover:opacity-90 ${btn}`}
            title={`The ${word} chat in Claude — the same one for the whole team`}
          >
            ✨ Open {word} chat ↗
          </a>
        ) : (
          !readOnly && (
            <button
              onClick={start}
              disabled={busy}
              className={`rounded-md font-semibold disabled:opacity-50 ${btn} ${
                state === "started" ? "border border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50" : "bg-[var(--accent)] text-white hover:opacity-90"
              }`}
              title={`Copies the ${word} prompt and opens BURN's Claude project`}
            >
              {copied ? "Prompt copied ✓" : state === "started" ? "Start again" : `✨ Start ${word} in Claude`}
            </button>
          )
        )}
        {state === "linked" && !readOnly && !linking && (
          <button onClick={() => setLinking(true)} className="text-[11px] text-neutral-400 underline decoration-neutral-300 hover:text-neutral-700">
            change link
          </button>
        )}
      </div>

      {state === "linked" && !compact && (
        <p className="text-[11px] text-neutral-500">
          Linked{work?.claude_url_by ? ` by ${firstName(work.claude_url_by)}` : ""}
          {work?.claude_url_at ? ` · ${fmtDate(work.claude_url_at.slice(0, 10))}` : ""} — everyone opens this same chat.
        </p>
      )}

      {showBox && (
        <div className="flex flex-col gap-1 rounded-md border border-orange-200 bg-orange-50/70 p-2">
          <p className="text-[11px] text-neutral-700">
            {copied
              ? "Prompt copied — paste it into a new chat in the project. Then copy that chat's link and paste it here:"
              : state === "started"
                ? `${firstName(work?.claude_started_by) || "Someone"} started the ${word} chat${work?.claude_started_at ? ` on ${fmtDate(work.claude_started_at.slice(0, 10))}` : ""}. Paste its link so the team uses the same chat:`
                : `Paste the ${word} chat link (Claude or Cowork):`}
          </p>
          <div className="flex gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && link()}
              placeholder="https://claude.ai/chat/…"
              aria-label={`${word} chat link`}
              className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-800"
            />
            <button onClick={link} disabled={busy || !draft.trim()} className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40">
              Save link
            </button>
            {linking && state !== "started" && (
              <button onClick={() => { setLinking(false); setError(null); }} className="text-xs text-neutral-400 hover:text-neutral-700">
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
