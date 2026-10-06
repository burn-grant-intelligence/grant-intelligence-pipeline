// One Claude chat per application stage (Draft Application tab).
//
// claude.ai can't hand the app back the link of a chat it opens, so the flow
// is: "Start in Claude" copies the stage prompt and opens BURN's Claude
// project → the writer pastes the new chat's link back → from then on the
// stage's button opens that same chat for everyone. Pure helpers, covered by
// test/claudeLinks.test.ts. Needs supabase/draft_claude_links_migration_2026-10-07.sql.

import type { DraftStage, DraftStageWork } from "./types";

const CLAUDE_HOSTS = /(^|\.)claude\.(ai|com)$/i;

/** A pasted Claude chat / project / Cowork link, cleaned — or why it was refused. */
export function cleanClaudeUrl(raw: string): { url: string | null; error: string | null } {
  const text = raw.trim();
  if (!text) return { url: null, error: null };
  // People often paste "Here's the chat: https://…" — take the first link in it.
  const found = /https?:\/\/\S+/i.exec(text)?.[0] ?? (/^[\w.-]+\.\w+\//.test(text) ? `https://${text}` : text);
  let u: URL;
  try {
    u = new URL(found.replace(/[)\].,>]+$/, ""));
  } catch {
    return { url: null, error: "That isn't a link. Copy the chat's address from Claude (it starts with https://claude.ai/…)." };
  }
  if (!CLAUDE_HOSTS.test(u.hostname)) return { url: null, error: `That's a ${u.hostname} link. Paste the Claude chat link (https://claude.ai/…).` };
  u.protocol = "https:";
  return { url: u.toString(), error: null };
}

export type ClaudeState = "linked" | "started" | "new";

/** linked: a chat link is saved · started: someone pressed Start but no link yet · new */
export function claudeState(work: Pick<DraftStageWork, "claude_url" | "claude_started_at"> | null | undefined): ClaudeState {
  if (work?.claude_url) return "linked";
  if (work?.claude_started_at) return "started";
  return "new";
}

export const stageWord = (stage: DraftStage | "submitted") => (stage === "first_draft" || stage === "submitted" ? "first draft" : "concept");
