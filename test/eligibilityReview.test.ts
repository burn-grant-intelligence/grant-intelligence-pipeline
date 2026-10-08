// Run: npx tsx test/eligibilityReview.test.ts
// Eligibility reviews routed to the lead (lib/eligibilityReview.ts).
import {
  ELIGIBILITY_CHECK,
  REVIEW_ORIGIN,
  decisionOf,
  finalResult,
  fromLabel,
  notesOfOutcome,
  leadChangePatch,
  needsReview,
  outcomeBody,
  planReviewSync,
  reassignPatch,
  reviewActionText,
  type ReviewAction,
  type ReviewItem,
} from "../lib/eligibilityReview";
import { mentionsIn, recipientsFor } from "../lib/mentions";

let failed = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const S = "Sammy Mwathi", H = "Hussein Kiarie";
const CHECKED = "2026-10-06T08:00:00.000Z";
const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: "i1",
  owner: "Sammy",
  fit_status: "unreviewed",
  fit_source: null,
  removed_at: null,
  grant: { eligibility_verdict: "needs_review", eligibility_checked_at: CHECKED, eligibility_report: { summary: "Country list unclear." } },
  ...over,
});
const act = (over: Partial<ReviewAction> = {}): ReviewAction => ({
  id: "a1",
  tracker_item_id: "i1",
  assignee: S,
  done: false,
  created_at: "2026-10-06T08:00:01.000Z",
  created_by: ELIGIBILITY_CHECK,
  description: reviewActionText(S, "Country list unclear."),
  origin: REVIEW_ORIGIN,
  ...over,
});

// ── who needs a review ──
check(needsReview(item()), "needs_review + unreviewed → needs review");
check(!needsReview(item({ fit_status: "fit", fit_source: "manual" })), "a person decided → no review");
check(!needsReview(item({ fit_status: "not_fit", fit_source: null })), "old manual decision (no fit_source) counts as decided");
check(!needsReview(item({ removed_at: CHECKED })), "removed → no review");
check(!needsReview(item({ grant: { eligibility_verdict: "fit" } })), "verdict fit → no review");

// ── creating ──
let plan = planReviewSync([item()], []);
check(plan.create.length === 1 && plan.create[0].assignee === S && plan.create[0].kind === "review", "creates a review for the lead (full name)");
check(plan.create[0].origin === REVIEW_ORIGIN && plan.create[0].created_by === ELIGIBILITY_CHECK, "marked as made by the eligibility check");
check(JSON.stringify(mentionsIn(plan.create[0].description)) === JSON.stringify([S]), "the text tags the lead by name");
check(plan.create[0].description.includes("Country list unclear."), "the text carries the check's summary");
check(planReviewSync([item({ owner: null })], []).create.length === 0, "no lead → nothing yet");
check(planReviewSync([item({ owner: "Jane Outsider" })], []).create.length === 0, "lead not in the team → nothing");
check(planReviewSync([item()], [act()]).create.length === 0, "already has an open review → nothing");
check(planReviewSync([item()], [act({ done: true })]).create.length === 0, "a review finished after this check → not asked again");
check(planReviewSync([item()], [act({ done: true, created_at: "2026-10-01T00:00:00.000Z" })]).create.length === 1, "re-check still needs review after an older finished review → asked again");
check(planReviewSync([item()], [act({ origin: null, kind: "review" } as Partial<ReviewAction>)]).create.length === 1, "ordinary action points don't count as the review");

// ── closing ──
plan = planReviewSync([item({ fit_status: "fit", fit_source: "manual" })], [act()]);
check(plan.close.length === 1 && plan.close[0].body.startsWith("Marked Fit"), "a person picked Fit → open review closed");
plan = planReviewSync([item({ fit_status: "not_fit", fit_source: "auto", grant: { eligibility_verdict: "not_fit" } })], [act()]);
check(plan.close.length === 1 && plan.close[0].body.includes("Re-check says Not a fit"), "re-check decided → closed automatically");
check(planReviewSync([item({ fit_status: "fit", fit_source: "manual" })], [act({ created_by: "Bornventure Kinoti" })]).close.length === 0, "a review a person asked for is not auto-closed");
check(planReviewSync([item()], [act()]).close.length === 0, "still needs review → left open");
check(planReviewSync([item({ removed_at: CHECKED, fit_status: "fit", fit_source: "manual" })], [act()]).close.length === 0, "removed → left alone");

// ── lead changes ──
let p = leadChangePatch(act(), "Sammy Mwathi", H, "Country list unclear.");
check(!!p && p.assignee === H && p.description.startsWith("Hussein,"), "review follows the new lead, text renamed");
check(leadChangePatch(act({ assignee: "Christine Theuri" }), S, H) === null, "review handed to someone else stays with them");
check(leadChangePatch(act(), S, null) === null, "lead cleared → review stays");
check(leadChangePatch(null, S, H) === null, "no open review → nothing to move");
p = reassignPatch(act({ description: "Custom text from Kinoti" }), H);
check(p.assignee === H && p.description === "Custom text from Kinoti", "custom text is kept when reassigning");
check(reassignPatch(act({ description: reviewActionText(S, null, true) }), H).description.startsWith("Hussein, please review"), "an 'asked' review keeps its wording");

// ── outcomes & labels ──
check(outcomeBody("fit", " Partner covers the country gap ") === "✓ Fits — Partner covers the country gap", "Fit outcome body");
check(outcomeBody("not_fit", "") === "✕ Not a fit", "Not fit with no notes");
check(outcomeBody(null, "Waiting on the funder") === "Waiting on the funder", "note only");
check(decisionOf("✓ Fits — x") === "fit" && decisionOf("✕ Not a fit") === "not_fit" && decisionOf("hello") === null, "decision read back from a reply");
check(fromLabel(ELIGIBILITY_CHECK) === "the eligibility check" && fromLabel(S) === "Sammy", "'Review request from …' label");
check(recipientsFor([ELIGIBILITY_CHECK, S], H).join() === S, "the eligibility check is never notified");

// ── a team member's review overrides the automatic result ──
const rep = (body: string, author: string | null, at: string) => ({ author, body, created_at: at });
check(finalResult(item(), []) === null, "nobody decided → no final result (automatic check stands)");
check(finalResult(item({ fit_status: "fit", fit_source: "auto" }), []) === null, "automatic fit is not a team decision");
let fr = finalResult(item({ fit_status: "fit", fit_source: "manual" }), [rep("✓ Fits — Partner covers the country gap", "Hussein Kiarie", "2026-10-06T10:00:00Z")]);
check(!!fr && fr.decision === "fit" && fr.by === H && fr.statement === "Fit — after further review by Hussein, this opportunity was found to be a fit.", "reviewer's Fit becomes the headline: " + fr?.statement);
check(fr?.notes === "Partner covers the country gap", "reviewer's notes carried without the heading");
fr = finalResult(item({ fit_status: "not_fit", fit_source: "manual" }), [rep("✕ Not a fit", S, "2026-10-06T10:00:00Z")]);
check(fr?.statement === "Not a fit — after further review by Sammy, this opportunity was found not to be a fit." && fr?.notes === "", "Not a fit with no notes");
fr = finalResult(item({ fit_status: "fit", fit_source: "manual" }), [rep("✕ Not a fit — old view", S, "2026-10-05T10:00:00Z")]);
check(!!fr && fr.by === null && /marked this opportunity as a fit|marked this opportunity as a fit/.test(fr.statement), "a later pill click that contradicts the old review is a team call, not that review");
fr = finalResult(item({ fit_status: "fit", fit_source: "manual" }), [rep("✕ Not a fit — first view", S, "2026-10-05T10:00:00Z"), rep("✓ Fits — changed my mind", H, "2026-10-06T10:00:00Z")]);
check(fr?.by === H && fr?.notes === "changed my mind", "the latest decision reply wins");
check(finalResult(item({ fit_status: "fit", fit_source: "manual" }), [rep("Just a comment", S, "2026-10-06T10:00:00Z")])?.by === null, "plain comments are not decisions");
check(notesOfOutcome("✓ Fits") === "" && notesOfOutcome("✕ Not a fit — too small") === "too small", "notesOfOutcome");

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
