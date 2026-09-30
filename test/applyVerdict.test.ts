/* eslint-disable @typescript-eslint/no-explicit-any */
// Run: npx tsx test/applyVerdict.test.ts
import { planTrackerUpdate, type TrackerFitRow } from "../lib/eligibility/applyVerdict";

const report = (verdict: "fit" | "not_fit" | "needs_review", notes = "NEW NOTES"): any => ({ verdict, notes_text: notes });
const row = (o: Partial<TrackerFitRow>): TrackerFitRow => ({ id: "t1", fit_status: "unreviewed", fit_source: null, fit_notes: null, ...o });

let failed = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

// Never overwrite a person's decision
check(planTrackerUpdate(row({ fit_status: "fit", fit_source: "manual" }), report("not_fit"), null) === null, "manual Fit is left alone");
check(planTrackerUpdate(row({ fit_status: "not_fit", fit_source: "manual" }), report("fit"), null) === null, "manual Not fit is left alone");
check(planTrackerUpdate(row({ fit_status: "fit", fit_source: null }), report("not_fit"), null) === null, "legacy Fit (set before fit_source existed) counts as manual");
check(planTrackerUpdate(row({ fit_status: "not_fit", fit_source: null }), report("fit"), null) === null, "legacy Not fit counts as manual");

// Undecided rows get the verdict
let u = planTrackerUpdate(row({}), report("fit"), null);
check(u?.fit_status === "fit" && u.fit_source === "auto" && u.fit_notes === "NEW NOTES", "unreviewed + fit verdict → Fit (auto) with notes");
u = planTrackerUpdate(row({}), report("not_fit"), null);
check(u?.fit_status === "not_fit" && u.fit_source === "auto", "unreviewed + not_fit verdict → Not fit (auto)");
u = planTrackerUpdate(row({}), report("needs_review"), null);
check(u?.fit_status === "unreviewed" && u.fit_source === null && u.fit_notes === "NEW NOTES", "needs_review leaves status Unreviewed, writes notes");

// Re-checks follow the latest verdict for auto rows
u = planTrackerUpdate(row({ fit_status: "fit", fit_source: "auto", fit_notes: "OLD" }), report("not_fit"), "OLD");
check(u?.fit_status === "not_fit" && u.fit_source === "auto" && u.fit_notes === "NEW NOTES", "auto Fit re-checked as not_fit → Not fit, notes refreshed");
u = planTrackerUpdate(row({ fit_status: "fit", fit_source: "auto", fit_notes: "OLD" }), report("needs_review"), "OLD");
check(u?.fit_status === "unreviewed" && u.fit_source === null, "auto Fit re-checked as needs_review → back to Unreviewed");

// Human-typed notes survive
u = planTrackerUpdate(row({ fit_status: "fit", fit_source: "auto", fit_notes: "Sammy: call the funder first" }), report("fit"), "OLD");
check(u?.fit_notes === "Sammy: call the funder first", "hand-typed notes are kept");
u = planTrackerUpdate(row({ fit_notes: "Sammy: call the funder first" }), report("fit"), null);
check(u?.fit_notes === "Sammy: call the funder first" && u.fit_status === "fit", "notes kept on an unreviewed row too, status still set");

console.log(failed ? `\n${failed} FAILED` : "\nAll scenarios passed");
process.exit(failed ? 1 : 0);
