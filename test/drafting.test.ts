// Run: npx tsx test/drafting.test.ts
import {
  BOARD_COLUMNS, STAGES, buildClaudePrompt, columnOf, daysLeftLabel, guidanceBlock, isMissingDraftTables, WRITING_STANDARDS, managementGuidance, donorGuidance, buildDecodePrompt, buildReviewPrompt, carryForward, changedAnswers, countChars, countWords,
  draftAsText, extractJson, findMarkers, limitCheck, localChecks, mergeBrief, nextStage, normalizeBrief, normalizeReview, normalizeStage,
  notesForStage, openItems, pickLearnings, planMove, prevStage, stageOf,
} from "../lib/drafting";
import { cleanClickUpUrl } from "../lib/pipeline";
import type { DraftBrief, DraftGuidance, DraftLearning, DraftStageWork, OpportunityNote, TrackerItem } from "../lib/types";

let failed = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

// ── stages ──
check(STAGES.map((s) => s.key).join() === "concept,first_draft", "two stages in order: concept, first draft");
check(STAGES.every((s) => s.checklist.length >= 6 && s.reviewFocus.length >= 5 && s.mindset.length >= 4), "every stage has a checklist, a review focus and a mindset");
check(new Set(STAGES.flatMap((s) => s.checklist.map((c) => `${s.key}:${c.id}`))).size === STAGES.reduce((n, s) => n + s.checklist.length, 0), "checklist ids are unique within each stage");
check(nextStage("concept") === "first_draft" && nextStage("first_draft") === null && prevStage("concept") === null && prevStage("first_draft") === "concept", "next / previous stage");
check(stageOf({ draft_stage: null }) === "concept" && stageOf({ draft_stage: "first_draft" }) === "first_draft", "no stage yet = concept");
check(normalizeStage("semi_final") === "first_draft" && normalizeStage("final") === "first_draft" && normalizeStage("") === "concept" && normalizeStage(undefined) === "concept" && normalizeStage("concept") === "concept", "old four-stage values read as first draft");
check(BOARD_COLUMNS.map((c) => c.key).join() === "concept,first_draft,submitted", "board columns: concept, first draft, submitted");

// ── the board: columns and moves (like Tracking / Drafting / Submitted) ──
const mv = (status: string, stage: string | null, sub: string | null = null) => ({ status, draft_stage: stage, submission_date: sub }) as Pick<TrackerItem, "status" | "draft_stage" | "submission_date">;
check(columnOf(mv("tracking", null)) === "concept" && columnOf(mv("drafting", "first_draft")) === "first_draft" && columnOf(mv("submitted", "first_draft")) === "submitted", "column: submitted wins, else the draft stage");
let pm = planMove(mv("tracking", null), "first_draft", "2026-10-02");
check(pm.ok && pm.forward && pm.stage === "first_draft" && pm.status === "drafting", "concept → first draft: copies forward, tracking becomes drafting");
pm = planMove(mv("drafting", "first_draft"), "concept");
check(pm.ok && !pm.forward && pm.stage === "concept" && pm.status === "drafting", "first draft → concept (back) is allowed and not a forward move");
pm = planMove(mv("drafting", "concept"), "submitted");
check(!pm.ok && /First draft/.test(pm.reason ?? ""), "concept → submitted is refused with a reason");
pm = planMove(mv("drafting", "first_draft"), "submitted", "2026-10-02");
check(pm.ok && pm.status === "submitted" && pm.submissionDate === "2026-10-02", "first draft → submitted sets the status and today's date");
check(planMove(mv("drafting", "first_draft", "2026-09-30"), "submitted", "2026-10-02").submissionDate === "2026-09-30", "an existing submission date is kept");
pm = planMove(mv("submitted", "first_draft", "2026-09-30"), "first_draft");
check(pm.ok && pm.status === "drafting" && pm.stage === "first_draft" && !pm.forward, "reopening from submitted → drafting");
check(!planMove(mv("drafting", "concept"), "concept").ok, "moving to the column it is already in does nothing");

check(cleanClickUpUrl("app.clickup.com/t/abc") === "https://app.clickup.com/t/abc" && cleanClickUpUrl("javascript:alert(1)") === null && cleanClickUpUrl("  ") === null && cleanClickUpUrl("https://app.clickup.com/t/9") === "https://app.clickup.com/t/9", "ClickUp links: scheme added, web links only, blank = none");

check(daysLeftLabel("2026-10-12", "2026-10-02")!.text === "10 days left" && daysLeftLabel("2026-10-02", "2026-10-02")!.text === "Due today" && daysLeftLabel("2026-09-30", "2026-10-02")!.text.startsWith("Deadline passed") && daysLeftLabel(null) === null, "deadline countdown labels");
check(isMissingDraftTables('relation "public.draft_stage_work" does not exist') && !isMissingDraftTables("network error"), "missing-table errors recognised");

// ── counting ──
check(countWords("BURN sells  clean\ncookstoves — in 14 countries.") === 7, "words: dashes are not words, numbers are");
check(countWords("") === 0 && countWords(null) === 0, "empty text has no words");
check(countChars("  abc def  ") === 7 && countChars("a\r\nb") === 3 && countChars("ñé") === 2, "characters include spaces, line breaks once, accents once");
const q300 = { limit: 300, unit: "words" as const };
check(limitCheck("word ".repeat(250), q300).state === "ok" && limitCheck("word ".repeat(280), q300).state === "near" && limitCheck("word ".repeat(301), q300).state === "over", "limit states: ok / near (90%+) / over");
check(limitCheck("", q300).state === "empty" && limitCheck("one two", { limit: null, unit: "words" }).state === "no_limit", "empty and no-limit states");
check(limitCheck("abcdef", { limit: 5, unit: "characters" }).label === "6 / 5 characters", "characters label");
check(findMarkers("We reach [NEEDS INPUT: households] people, budget TBC, XX staff ???").length === 4, "gap markers found");
check(findMarkers("TBCA is not a marker").length === 0, "marker words must stand alone");

// ── a brief and drafts ──
const brief: DraftBrief = {
  objectives: ["Expand clean cooking access"],
  criteria: [{ name: "Impact", weight: "40%" }, { name: "Scalability", weight: null }],
  keywords: ["last-mile", "gender"],
  must_haves: ["Budget template"],
  questions: [
    { id: "q1", label: "Problem", limit: 10, unit: "words" },
    { id: "q2", label: "Solution", limit: 20, unit: "characters" },
  ],
};
const work = (answers: Record<string, string>, extra: Partial<DraftStageWork> = {}): DraftStageWork => ({
  id: "w", tracker_item_id: "t1", stage: "first_draft", draft_text: null, answers, checklist: [], stage_notes: null, review: null, reviewed_at: null, updated_by: null, created_at: "", updated_at: "", ...extra,
});

check(draftAsText(brief, work({ q2: "B", q1: "A" }, { draft_text: "C" })) === "A\n\nB\n\nC", "draft text follows question order, then other text");
let lc = localChecks(brief, work({}), "first_draft");
check(lc.length === 1 && lc[0].status === "fail", "nothing written → one failing check");
lc = localChecks(brief, work({ q1: "Households lack last-mile access [NEEDS INPUT]", q2: "x".repeat(25) }), "first_draft");
const byId = Object.fromEntries(lc.map((c) => [c.id, c]));
check(byId.answered.status === "pass", "all questions answered");
const conceptChecks = Object.fromEntries(localChecks(brief, work({ q1: "ok", q2: "x".repeat(25) }), "concept").map((c) => [c.id, c]));
check(conceptChecks.limits.status === "warn" && conceptChecks.limits.detail.includes("Solution"), "over a limit is only a warning at the concept, naming the question");
check(byId.limits.status === "fail" && byId.answered.status === "pass", "at the first draft an over-limit answer fails");
check(byId.markers.status === "warn", "gap markers are a warning (named as open)");
check(byId.keywords.status === "warn" && byId.keywords.detail.includes("gender"), "missing donor keyword named");
lc = localChecks(brief, work({ q1: "Short" }), "first_draft");
check(lc.find((c) => c.id === "answered")!.status === "fail", "a blank answer fails at the first draft");
check(localChecks(null, work({}, { draft_text: "Free text" }), "first_draft").find((c) => c.id === "questions")!.status === "fail", "no questions in the Brief at the first draft → fail");
check(localChecks(null, work({}, { draft_text: "Free text" }), "concept").find((c) => c.id === "questions")!.status === "warn", "no questions in the Brief at the concept → only a warning");
check(localChecks(brief, work({ q1: "x" }), "concept", 0).find((c) => c.id === "guidance")!.status === "warn" && localChecks(brief, work({ q1: "x" }), "concept", 2).find((c) => c.id === "guidance")!.status === "pass" && !localChecks(brief, work({ q1: "x" }), "concept").some((c) => c.id === "guidance") && !localChecks(brief, work({ q1: "x" }), "first_draft", 2).some((c) => c.id === "guidance"), "management-guidance check: concept only, warns when none, only when the count is known");

const open = openItems("concept", work({}, { checklist: ["go_no_go", "pitch"], draft_text: "idea" }), null);
check(open.length === STAGES[0].checklist.length - 2 && !open.some((o) => o.startsWith("Go / no-go")), "open items = unticked checklist items");
check(openItems("first_draft", work({ q1: "TBC [NEEDS INPUT]" }, { checklist: STAGES[1].checklist.map((c) => c.id) }), brief).length > 0, "failed automatic checks are open items too");

const carried = carryForward(work({ q1: "A" }, { draft_text: "T" }));
check(carried.answers.q1 === "A" && carried.draft_text === "T", "lifting carries the answers forward");
carried.answers.q1 = "changed";
check(carryForward(work({ q1: "A" })).answers.q1 === "A", "the carried copy is independent of the original");
check(changedAnswers(brief, work({ q1: "one two" }), work({ q1: "one two three" })).join() === "Problem: 2 → 3 words", "what changed between stages");

// ── learnings and notes ──
const L = (id: string, o: Partial<DraftLearning>): DraftLearning => ({ id, tracker_item_id: null, stage: null, funder: null, lesson: id, tags: [], author: null, created_at: "2026-01-01", ...o });
const picked = pickLearnings(
  [L("general", {}), L("other-stage", { stage: "concept" }), L("same-funder", { funder: "Shell Foundation " }), L("this-app", { tracker_item_id: "t1" }), L("this-stage", { stage: "first_draft" })],
  { trackerItemId: "t1", funder: "shell foundation", stage: "first_draft" }
);
check(picked.map((l) => l.id).join() === "this-app,same-funder,this-stage,general", "learnings: this application, same funder, this stage, general — other stages left out");

const N = (id: string, date: string, stage: OpportunityNote["stage"] = null): OpportunityNote => ({ id, tracker_item_id: "t1", meeting_date: date, notes: id, author: null, stage, created_at: date, updated_at: date });
const ns = notesForStage([N("old", "2026-09-01"), N("tagged", "2026-08-01", "first_draft"), N("new", "2026-10-01"), N("other", "2026-10-02", "concept")], "first_draft", "2026-09-20T10:00:00Z");
check(ns.map((n) => n.id).join() === "new,tagged", "notes: tagged with the stage, or untagged since the stage began");

// ── prompts ──
const item = {
  id: "t1", grant_id: "g1", status: "drafting", owner: "Bornventure Kinoti", notes: null, tor_text: null, created_at: "", updated_at: "",
  pipeline_link: "https://funder.org/right-call", draft_stage: "first_draft", draft_stage_changed_at: "2026-09-20", draft_brief: brief,
  grant: { id: "g1", title: "Clean Cooking Fund", funder: "Example Foundation", amount: 500000, currency: "USD", deadline: "2026-10-12", application_url: "https://scraper.org/404", focus_areas: [], geography: "Kenya", eligibility: null, description: null, fit_analysis: null, source_id: null, relevance_score: null, first_seen_at: "", last_seen_at: "" },
} as unknown as TrackerItem;
const ctxBase = { item, notes: [N("Funder asked for a gender angle", "2026-09-25")], actions: [], learnings: [L("Lead with the household numbers", { funder: "Example Foundation" })], today: "2026-10-02" };

const concept = buildClaudePrompt({ ...ctxBase, item: { ...item, draft_stage: "concept" }, stage: "concept", work: null, previous: null });
check(concept.includes("one-pager concept note") && concept.includes("7.4M+ clean cookstoves") && concept.includes("go / no-go"), "concept with no draft → the concept-note prompt (with BURN metrics and a go / no-go note)");
check(concept.includes("funder.org") && !concept.includes("scraper.org/404"), "prompts use the team's checked link, not the scraper's");

const write = buildClaudePrompt({ ...ctxBase, stage: "first_draft", work: null, previous: work({ q1: "Concept problem" }, { stage: "concept" }) });
check(write.startsWith("Write the first draft") && write.includes("building on the concept note"), "a stage with no draft yet → WRITE mode building on the previous stage");

const rev = buildClaudePrompt({ ...ctxBase, stage: "first_draft", work: work({ q1: "Our problem statement", q2: "x".repeat(25) }), previous: work({ q1: "Concept problem" }) });
check(rev.startsWith("Review and revise the first draft") && rev.includes("Verdict: is it ready to move to submission"), "first draft with a draft → REVIEW mode, verdict is about submission");
check(rev.includes("limit 20 characters · now 25 — OVER") && rev.includes("Problem: 2 → 3 words"), "the draft shows limits, counts and what changed");
check(rev.includes("Funder asked for a gender angle") && rev.includes("Lead with the household numbers") && rev.includes("Impact (40%)"), "meeting notes, learnings and scoring criteria are in the prompt");
check(rev.includes("(10 days left)"), "deadline countdown");
check(rev.includes("A compliance checklist") && rev.includes("Grammar and framing suggestions") && rev.includes("mock evaluator"), "first-draft review asks for a mock evaluator score, compliance and grammar / framing");
const conceptRev = buildClaudePrompt({ ...ctxBase, item: { ...item, draft_stage: "concept" }, stage: "concept", work: work({ q1: "Concept text" }, { stage: "concept" }), previous: null });
check(conceptRev.includes("ready to move to First draft") && !conceptRev.includes("mock evaluator"), "concept review: verdict is about the first draft, no evaluator score yet");

const gem = buildReviewPrompt({ ...ctxBase, stage: "first_draft", work: work({ q1: "Draft" }), previous: null });
check(gem.includes('"readiness"') && gem.includes("FIRST DRAFT") && gem.includes("Every question has an answer (no blanks)") && gem.includes("is to move to submission"), "Gemini review asks for JSON and lists the stage checklist");

// ── management guidance: recorded before the concept, fed into the prompts ──
const G = (id: string, date: string, text: string, o: Partial<DraftGuidance> = {}): DraftGuidance => ({ id, tracker_item_id: "t1", guidance_date: date, source: "Management meeting", given_by: "CEO", text, author: "Kinoti", created_at: `${date}T09:00:00Z`, ...o });
const gs = [G("g2", "2026-09-28", "Budget ceiling USD 250k"), G("g1", "2026-09-20", "Lead with the Kenya clean-cooking pilot", { source: "Email", given_by: null })];
const gb = guidanceBlock(gs);
check(gb.indexOf("Kenya clean-cooking pilot") < gb.indexOf("Budget ceiling") && gb.includes("(CEO, Management meeting)") && gb.includes("(Email)"), "guidance block: oldest first, with who and where");
check(guidanceBlock([]) === "None recorded yet." && guidanceBlock(undefined) === "None recorded yet.", "no guidance reads as none recorded");
const conceptItem = { ...item, draft_stage: "concept" } as TrackerItem;
const cg = buildClaudePrompt({ ...ctxBase, item: conceptItem, stage: "concept", work: null, previous: null, guidance: gs });
check(cg.includes("DIRECTION FROM MANAGEMENT") && cg.includes("Budget ceiling USD 250k") && cg.includes("Treat it as the starting brief") && cg.includes("how the concept follows their guidance"), "concept prompt with guidance: the direction is the starting brief, with a go / no-go note on it");
const cn = buildClaudePrompt({ ...ctxBase, item: conceptItem, stage: "concept", work: null, previous: null, guidance: [] });
check(cn.includes("No management guidance has been recorded yet") && cn.includes("None recorded yet."), "concept prompt without guidance asks for the decisions management still owes");
check(buildReviewPrompt({ ...ctxBase, item: conceptItem, stage: "concept", work: work({ q1: "Idea" }, { stage: "concept" }), previous: null, guidance: gs }).includes("Budget ceiling USD 250k"), "the Gemini review also gets management's guidance");
check(buildClaudePrompt({ ...ctxBase, stage: "first_draft", work: work({ q1: "Draft" }), previous: null, guidance: gs }).includes("Lead with the Kenya clean-cooking pilot"), "guidance stays in the first-draft prompts too");
check(buildDecodePrompt(item, false).includes("https://funder.org/right-call") && buildDecodePrompt(item, true).includes("documents provided"), "decode prompt points at the call");

// ── reading Gemini's replies ──
check((extractJson('```json\n{"a":1}\n```') as { a: number }).a === 1 && (extractJson('Here you go: {"a":2} thanks') as { a: number }).a === 2 && extractJson("no json") === null, "JSON pulled out of fenced or wrapped replies");
const r = normalizeReview({ readiness: 140, summary: "Good", checks: [{ item: "Limits", status: "nope", comment: "x" }, { comment: "no item" }], suggestions: [{ where: "Q1", issue: "Vague", suggestion: "Say 2M households" }], missing: ["budget", 5], next_steps: [] });
check(!!r && r.readiness === 100 && r.checks.length === 1 && r.checks[0].status === "warn" && r.missing.join() === "budget,5", "review normalised: readiness capped, bad status → warn, empty items dropped");
check(normalizeReview({}) === null && normalizeReview("x") === null, "an empty review is rejected");

const decoded = normalizeBrief({ objectives: ["Reach women"], criteria: ["Impact", { name: "Cost", weight: "20%" }], keywords: ["gender"], questions: [{ label: "Problem", limit: "250", unit: "words" }, { label: "Budget", limit: 2000, unit: "characters" }, { label: "" }] }, brief);
check(!!decoded && decoded.questions.length === 2 && decoded.questions[0].id === "q1" && decoded.questions[0].limit === 250 && decoded.questions[1].unit === "characters", "decoded questions keep the id of a matching question; numeric strings read");
check(decoded!.criteria[0].name === "Impact" && decoded!.criteria[0].weight === null, "criteria may come as plain strings");
check(normalizeBrief({ questions: [] }) === null, "an empty decode is rejected");
const merged = mergeBrief({ ...brief, questions: [{ id: "q1", label: "Problem", limit: null, unit: "words" }] }, decoded!);
check(merged.questions.length === 2 && merged.questions[0].limit === 250 && merged.objectives.join() === "Expand clean cooking access,Reach women", "merge: fills a missing limit, adds new questions and objectives");
const typed = { ...brief, questions: [{ id: "q1", label: "problem", limit: 100, unit: "words" as const }] };
const merged2 = mergeBrief(typed, decoded!);
check(merged2.questions[0].limit === 100 && typed.questions[0].limit === 100 && merged2.keywords.join() === "last-mile,gender", "merge: never overwrites a typed limit, doesn't change the original, no duplicate keywords");

// ── management vs donor guidance, the team's notes and the writing standards ──
const mixed = [G("m1", "2026-09-10", "Keep to Kenya only"), G("m2", "2026-09-11", "Budget under 250k", { source: "Management email" }), G("d1", "2026-09-12", "Donor scores gender heavily", { source: "Donor meeting", given_by: "Programme officer" })];
check(managementGuidance(mixed).length === 2 && donorGuidance(mixed).length === 1, "guidance is split by where it came from: Management… vs the rest");
const mp = buildClaudePrompt({ ...ctxBase, item: conceptItem, stage: "concept", work: null, previous: null, guidance: mixed });
const mgIdx = mp.indexOf("DIRECTION FROM MANAGEMENT"), dgIdx = mp.indexOf("GUIDANCE FROM THE DONOR");
check(mgIdx > -1 && dgIdx > mgIdx && mp.indexOf("Keep to Kenya only") > mgIdx && mp.indexOf("Keep to Kenya only") < dgIdx && mp.indexOf("Donor scores gender heavily") > dgIdx, "management guidance sits under management's heading, donor guidance under the donor's");
check(mp.includes("(Programme officer, Donor meeting)"), "donor guidance carries who and where");
const onlyDonor = buildClaudePrompt({ ...ctxBase, item: conceptItem, stage: "concept", work: null, previous: null, guidance: [G("d2", "2026-09-12", "Only donor words", { source: "Donor email" })] });
check(onlyDonor.includes("No management guidance has been recorded yet"), "a donor-only list still asks for management's decisions");
const withNotes = buildClaudePrompt({ ...ctxBase, stage: "first_draft", work: work({ q1: "Draft" }, { stage_notes: "Open with the founding story" }), previous: null });
check(withNotes.includes("Open with the founding story") && withNotes.includes("THE TEAM'S NOTES ON THIS STAGE"), "the Notes tab text goes into the prompt");
for (const [name, text] of [["concept", concept], ["write", write], ["review/revise", rev]] as const) {
  check(text.includes(WRITING_STANDARDS), `${name} prompt carries the writing standards`);
}
check(/Take your time/.test(WRITING_STANDARDS) && /consistency/.test(WRITING_STANDARDS) && /logical flow/.test(WRITING_STANDARDS), "standards: take your time, consistency, coherence and logical flow");
check(/Do not use dashes/.test(WRITING_STANDARDS) && /Do not use semicolons/.test(WRITING_STANDARDS) && /SDG 7 \(clean cooking\)/.test(WRITING_STANDARDS), "standards: no dashes, no semicolons, no bracketed reinterpretation (SDG 7 example)");
const orderPart = WRITING_STANDARDS.slice(WRITING_STANDARDS.indexOf("follow this order"));
const order = ["introduction and founding", "product range", "impact numbers", "assembly facilities and capacity per month"].map((t) => orderPart.indexOf(t));
check(order.every((n) => n > -1) && order.every((n, i) => i === 0 || n > order[i - 1]), "standards: BURN's order (founding, product range story, impact, assembly capacity)");
check(/story/.test(WRITING_STANDARDS) && /why each product exists/.test(WRITING_STANDARDS), "standards: tell the story behind the product range");
const rv = buildReviewPrompt({ ...ctxBase, item: conceptItem, stage: "concept", work: work({ q1: "Idea" }, { stage: "concept" }), previous: null });
check(/no dashes/.test(rv) && /no semicolons/.test(rv) && /logical flow/.test(rv), "the in-app review also checks the writing standards");

console.log(failed ? `\n${failed} FAILED` : "\nAll scenarios passed");
process.exit(failed ? 1 : 0);
