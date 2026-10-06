// Run: npx tsx test/claudeLinks.test.ts
// One Claude chat per draft stage (lib/claudeLinks.ts) and the workspace History timeline.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "test";

async function main() {
  const { claudeState, cleanClaudeUrl, stageWord } = await import("../lib/claudeLinks");
  const { historyEntries } = await import("../components/DraftWorkspace");
  let failed = 0;
  const check = (ok: boolean, label: string) => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  };

  // ── pasted links ──
  check(cleanClaudeUrl("https://claude.ai/chat/abc-123").url === "https://claude.ai/chat/abc-123", "a claude.ai chat link is kept");
  check(cleanClaudeUrl("  Here's the chat: https://claude.ai/chat/xyz). ").url === "https://claude.ai/chat/xyz", "link pulled out of pasted text, trailing punctuation dropped");
  check(cleanClaudeUrl("claude.ai/project/123/chat").url === "https://claude.ai/project/123/chat", "missing https:// is added");
  check(cleanClaudeUrl("http://claude.ai/chat/1").url === "https://claude.ai/chat/1", "http becomes https");
  check(!!cleanClaudeUrl("https://www.claude.com/x").url, "claude.com allowed");
  check(cleanClaudeUrl("https://burn.sharepoint.com/doc").url === null && /sharepoint/.test(cleanClaudeUrl("https://burn.sharepoint.com/doc").error ?? ""), "non-Claude link refused with a reason");
  check(cleanClaudeUrl("https://evilclaude.ai/x").url === null, "look-alike domain refused");
  check(cleanClaudeUrl("not a link").url === null && !!cleanClaudeUrl("not a link").error, "plain text refused");
  check(cleanClaudeUrl("   ").url === null && cleanClaudeUrl("   ").error === null, "empty is just empty");

  // ── button state ──
  check(claudeState(null) === "new", "no row → Start");
  check(claudeState({ claude_url: null, claude_started_at: "2026-10-06T10:00:00Z" }) === "started", "started, no link yet");
  check(claudeState({ claude_url: "https://claude.ai/chat/1", claude_started_at: null }) === "linked", "linked → Open chat");
  check(stageWord("concept") === "concept" && stageWord("first_draft") === "first draft" && stageWord("submitted") === "first draft", "stage words");

  // ── history ──
  const item = {
    id: "t1", status: "drafting", submission_date: null,
    grant: { eligibility_checked_at: "2026-10-01T08:00:00Z", eligibility_verdict: "needs_review", eligibility_report: { summary: "Country unclear." } },
  } as never;
  const entries = historyEntries({
    item,
    notes: [{ id: "n1", tracker_item_id: "t1", meeting_date: "2026-10-02", notes: "Hussein to call the donor.", author: "Sammy Mwathi", stage: null, created_at: "2026-10-02T09:00:00Z", updated_at: "" }],
    actions: [
      { id: "a1", tracker_item_id: "t1", note_id: null, kind: "review", origin: "eligibility_review", description: "Sammy, the eligibility check needs your further review.", meeting_with: null, assignee: "Sammy Mwathi", due_date: null, done: true, done_at: null, created_by: "Eligibility check", created_at: "2026-10-01T08:00:01Z" },
      { id: "a2", tracker_item_id: "t1", note_id: null, kind: "task", description: "Budget draft", meeting_with: null, assignee: "Hussein Kiarie", due_date: null, done: false, done_at: null, created_by: "Sammy Mwathi", stage: "concept", created_at: "2026-10-03T09:00:00Z" },
    ],
    replies: [{ id: "r1", action_id: "a1", author: "Sammy Mwathi", body: "✓ Fits — partner covers it", created_at: "2026-10-01T12:00:00Z" }],
    moves: [{ id: "m1", tracker_item_id: "t1", from_stage: null, to_stage: "concept", moved_by: "Sammy Mwathi", open_items: [], moved_at: "2026-10-04T09:00:00Z" }],
    works: [{ id: "w1", tracker_item_id: "t1", stage: "concept", claude_url: "https://claude.ai/chat/1", claude_url_by: "Sammy Mwathi", claude_url_at: "2026-10-05T09:00:00Z" } as never],
    guidance: [{ id: "g1", tracker_item_id: "t1", guidance_date: "2026-10-04", source: "Donor meeting", given_by: "PO", text: "Lead with Kenya", author: "Bornventure Kinoti", created_at: "2026-10-04T10:00:00Z" }],
  });
  check(entries.length === 8, `all 8 things in one timeline (${entries.length})`);
  check(entries[0].text.startsWith("Linked the concept") && entries[entries.length - 1].text.startsWith("Needs further review"), "newest first, eligibility check oldest");
  check(entries.find((e) => e.key === "n-n1")?.where === "Application Tracker", "a note written in the Application Tracker says so");
  check(entries.find((e) => e.key === "a-a1")?.kind === "eligibility" && entries.find((e) => e.key === "r-r1")?.icon === "🟢", "eligibility review and its Fit reply are under Eligibility");
  check(entries.find((e) => e.key === "a-a2")?.where === "Draft · Concept" && /open · for Hussein/.test(entries.find((e) => e.key === "a-a2")?.extra ?? ""), "drafting action point shows stage and who it's for");

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exit(failed ? 1 : 0);
}
main();
