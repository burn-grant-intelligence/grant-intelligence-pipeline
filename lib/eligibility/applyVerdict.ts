// Decides what an eligibility check may write onto a tracker item, so that a
// person's own Fit / Not fit call is never overwritten by a re-check.
// Pure function (no I/O) so it is covered by test/applyVerdict.test.ts.

import type { EligibilityReport } from "./types";

export interface TrackerFitRow {
  id: string;
  fit_status: "unreviewed" | "fit" | "not_fit";
  fit_source: "auto" | "manual" | null;
  fit_notes: string | null;
}

export interface TrackerFitUpdate {
  fit_status: "unreviewed" | "fit" | "not_fit";
  fit_source: "auto" | null;
  fit_notes: string | null;
}

// Returns the fields to write, or null when the row must be left alone.
//
// Protected (never touched): fit_source "manual", AND rows with no fit_source
// but a Fit/Not fit status — those were set by a person before fit_source
// existed, so they count as manual.
//
// Otherwise: verdict fit -> Fit, not_fit -> Not fit, needs_review -> back to
// Unreviewed (a verdict of "needs review" is not a decision). Notes are only
// replaced when empty or still the previous auto-generated text, so anything a
// person typed into "Why (optional notes)" survives.
export function planTrackerUpdate(
  item: TrackerFitRow,
  report: EligibilityReport,
  previousAutoNotes: string | null
): TrackerFitUpdate | null {
  const humanDecided =
    item.fit_source === "manual" || (item.fit_source === null && item.fit_status !== "unreviewed");
  if (humanDecided) return null;

  const fit_status = report.verdict === "fit" ? "fit" : report.verdict === "not_fit" ? "not_fit" : "unreviewed";
  const canReplaceNotes = !item.fit_notes || (previousAutoNotes !== null && item.fit_notes === previousAutoNotes);
  return {
    fit_status,
    fit_source: report.verdict === "needs_review" ? null : "auto",
    fit_notes: canReplaceNotes ? report.notes_text : item.fit_notes,
  };
}
