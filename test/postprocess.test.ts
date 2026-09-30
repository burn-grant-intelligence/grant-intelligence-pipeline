/* eslint-disable @typescript-eslint/no-explicit-any */
// Run: npx tsx test/postprocess.test.ts
import { normalizeFacts } from "../lib/eligibility/extract";
import { applyDeadlineFallback, eligibleCountriesFrom } from "../lib/eligibility/postprocess";
import { buildReport } from "../lib/eligibility/rules";

const NOW = new Date("2026-09-29T12:00:00Z");
let failed = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra}`);
};
const facts = (o: any = {}) => normalizeFacts({ source_coverage: "full_rfp", extraction_confidence: 0.9, ...o });

// countries
let f = facts({ geography: { scope: "specific_countries", countries: ["Kenya", "Democratic Republic of the Congo", "DRC", "kenya "], regions: [] } });
check(JSON.stringify(eligibleCountriesFrom(f)) === JSON.stringify(["Kenya", "DRC"]), "countries are canonical and de-duplicated", ` → ${JSON.stringify(eligibleCountriesFrom(f))}`);
f = facts({ geography: { scope: "regional", countries: [], regions: ["East Africa", "East Africa"] } });
check(JSON.stringify(eligibleCountriesFrom(f)) === JSON.stringify(["East Africa"]), "regions kept, de-duplicated");
f = facts({ geography: { scope: "specific_countries", countries: ["Uganda"], regions: ["East Africa"] } });
check(JSON.stringify(eligibleCountriesFrom(f)) === JSON.stringify(["Uganda", "East Africa"]), "countries then regions");
f = facts({ geography: { scope: "global", countries: [], regions: [] } });
check(JSON.stringify(eligibleCountriesFrom(f)) === JSON.stringify(["Global"]), "global scope → [\"Global\"]");
f = facts({ geography: { scope: "unclear", countries: [], regions: [] } });
check(eligibleCountriesFrom(f).length === 0, "nothing stated → empty list");

// deadline fallback
f = facts({ deadline: { date: null, is_rolling: false, status: "unclear" } });
applyDeadlineFallback(f, "2026-12-01", NOW);
check(f.deadline.date === "2026-12-01" && !!f.deadline.evidence?.includes("tracker record"), "future stored deadline fills a missing one");

f = facts({ deadline: { date: null, is_rolling: false, status: "unclear" } });
applyDeadlineFallback(f, "2026-03-01", NOW);
check(f.deadline.date === null && !!f.deadline.evidence?.includes("has passed"), "PAST stored deadline is not used as a date");
check(buildReport(f, { sources: [], model: "t" }, undefined, NOW).blocking.every((r) => r.id !== "H1"), "…so it never becomes an automatic 'closed' fail");

f = facts({ deadline: { date: "2027-01-15", is_rolling: false, status: "open" } });
applyDeadlineFallback(f, "2026-12-01", NOW);
check(f.deadline.date === "2027-01-15", "a deadline found in the documents wins over the stored one");

f = facts({ deadline: { date: null, is_rolling: true, status: "open" } });
applyDeadlineFallback(f, "2026-12-01", NOW);
check(f.deadline.date === null, "rolling call: stored deadline ignored");

f = facts({ deadline: { date: null, is_rolling: false, status: "unclear" } });
applyDeadlineFallback(f, null, NOW);
applyDeadlineFallback(f, "not a date", NOW);
check(f.deadline.date === null, "missing / garbage stored deadline is ignored");

// notes no longer carry the score
f = facts({});
const notes = buildReport(f, { sources: [], model: "t" }, undefined, NOW).notes_text;
check(!/\d+\/100/.test(notes), "notes text has no 0–100 score");

console.log(failed ? `\n${failed} FAILED` : "\nAll scenarios passed");
process.exit(failed ? 1 : 0);
