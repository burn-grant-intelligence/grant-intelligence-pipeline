// Small pure helpers the check-eligibility route applies to the extracted
// facts before/after the rules run. Kept out of route.ts so they can be tested
// without Supabase or Gemini (test/postprocess.test.ts).

import { normCountry } from "./rules";
import type { CallFacts } from "./types";

// Old-style "countries of focus" list for the Excel export / Eligibility card:
// named countries (canonical names, de-duplicated — "Democratic Republic of the
// Congo" and "DRC" become one "DRC") plus any regional labels, or ["Global"]
// for calls open to everyone.
export function eligibleCountriesFrom(facts: CallFacts): string[] {
  const countries = [...new Set(facts.geography.countries.map(normCountry))];
  const regions = [...new Set(facts.geography.regions)];
  const list = [...countries, ...regions];
  if (list.length === 0 && facts.geography.scope === "global") return ["Global"];
  return list;
}

// If the call documents give no deadline, fall back to the one the scraper
// stored on the grant — but only while it is still in the future. A stored
// deadline that has already passed is NOT turned into "closed": the scraper's
// date may be stale (call extended, or re-opened), and an automatic "not fit"
// on that alone would be wrong. It is left as "unclear" with a note instead,
// so the check lands on "needs review".
export function applyDeadlineFallback(facts: CallFacts, storedDeadline: string | null | undefined, now = new Date()): void {
  const d = facts.deadline;
  if (d.date || d.is_rolling || !storedDeadline) return;
  const parsed = new Date(`${String(storedDeadline).slice(0, 10)}T23:59:59Z`);
  if (isNaN(+parsed)) return;
  const iso = parsed.toISOString().slice(0, 10);
  if (+parsed >= +now) {
    d.date = iso;
    d.evidence = "Deadline taken from the tracker record (not stated in the call documents read).";
  } else {
    d.evidence = `The tracker record shows a deadline of ${iso}, which has passed — confirm on the funder's site whether the call was extended or re-opened.`;
  }
}
