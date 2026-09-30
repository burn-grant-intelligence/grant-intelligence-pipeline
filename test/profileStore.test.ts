/* eslint-disable @typescript-eslint/no-explicit-any */
// Run: npx tsx test/profileStore.test.ts
// All values below are made up — this file is in a public repo.
import { BURN_PROFILE } from "../lib/eligibility/burnProfile";
import { loadProfile, mergeProfile } from "../lib/eligibility/profileStore";
import { normalizeFacts } from "../lib/eligibility/extract";
import { buildReport } from "../lib/eligibility/rules";

const NOW = new Date("2026-09-29T12:00:00Z");
let failed = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra}`);
};

async function main() {
  // ── defaults are safe to publish ──
  console.log("──────── public defaults ────────");
  check(BURN_PROFILE.activeCommitments.length === 0, "no live applications in the repo defaults");
  check(BURN_PROFILE.annualRevenueUsd === null && BURN_PROFILE.prefinancingCapacityUsd === null && BURN_PROFILE.carbonFinanceRaisedUsd === null, "no revenue / financing figures in the repo defaults");
  check(Object.values(BURN_PROFILE.notes).every((n) => n === ""), "no company-specific wording in the repo defaults");
  check(BURN_PROFILE.countries.every((c) => c.entity === undefined), "no entity names in the repo defaults");

  // ── mergeProfile ──
  console.log("\n──────── mergeProfile ────────");
  let m = mergeProfile(BURN_PROFILE, { annualRevenueUsd: 1_234_567, maxCofinancingPct: 25 });
  check(m.profile.annualRevenueUsd === 1_234_567 && m.profile.maxCofinancingPct === 25 && m.applied.length === 2, "numbers override the defaults");
  check(m.profile.headcount === BURN_PROFILE.headcount, "untouched keys keep their defaults");

  m = mergeProfile(BURN_PROFILE, { annualRevenueUsd: "lots", headcount: "3500", bogusKey: 1, minDaysToApply: 14 });
  check(m.ignored.includes("annualRevenueUsd") && m.ignored.includes("headcount") && m.ignored.includes("bogusKey"), "wrong types and unknown keys are ignored and listed", ` (${m.ignored})`);
  check(m.profile.annualRevenueUsd === null && m.profile.headcount === 3500 && m.profile.minDaysToApply === 14, "…while valid keys in the same object still apply");

  m = mergeProfile(BURN_PROFILE, { annualRevenueUsd: null });
  check(m.profile.annualRevenueUsd === null && m.applied.includes("annualRevenueUsd"), "null is accepted for nullable numbers");

  m = mergeProfile(BURN_PROFILE, {
    countries: [
      { name: "Kenya", presence: "manufacturing" },
      { name: "Examplia", presence: "local_entity", entity: "Example Ltd", sinceYear: 2020 },
      { name: "Broken", presence: "warehouse" },
      "nonsense",
    ],
  });
  check(m.profile.countries.length === 2 && m.profile.countries[1].entity === "Example Ltd", "valid country entries kept, invalid ones dropped");
  check(m.ignored.includes("countries[2]") && m.ignored.includes("countries[3]"), "dropped entries are reported by index");

  m = mergeProfile(BURN_PROFILE, {
    activeCommitments: [
      { programme: "Example Programme", countries: ["Kenya"], technologies: ["electric", "made_up"], status: "active", note: "n" },
      { programme: "No countries", status: "active" },
      { programme: "Bad status", countries: [], technologies: [], status: "maybe" },
    ],
  });
  check(m.profile.activeCommitments.length === 1 && JSON.stringify(m.profile.activeCommitments[0].technologies) === '["electric"]', "commitments validated; unknown technologies filtered");
  check(m.ignored.includes("activeCommitments[1]") && m.ignored.includes("activeCommitments[2]"), "invalid commitments reported");

  m = mergeProfile(BURN_PROFILE, { notes: { ownership: "example", prefinancing: 5 }, technologies: { main: ["electric", "nope"] }, bestKnownIsoTier: { electric: 4, x: "no" } });
  check(m.profile.notes.ownership === "example" && m.profile.notes.prefinancing === "", "notes: strings applied, non-strings ignored");
  check(JSON.stringify(m.profile.technologies.main) === '["electric"]' && JSON.stringify(m.profile.technologies.limited) === '["lpg"]', "technologies: filtered, missing list keeps default");
  check(m.profile.bestKnownIsoTier.electric === 4 && !("x" in m.profile.bestKnownIsoTier), "ISO tiers: numbers/null only");

  check(mergeProfile(BURN_PROFILE, "not an object").applied.length === 0 && mergeProfile(BURN_PROFILE, null).profile === undefined === false, "non-object override changes nothing");
  check(BURN_PROFILE.annualRevenueUsd === null, "merging never mutates the defaults");

  // ── loadProfile with a fake database ──
  console.log("\n──────── loadProfile ────────");
  const db = (result: any) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }) }) as any;
  let l = await loadProfile(db({ data: { profile: { annualRevenueUsd: 5_000_000 } }, error: null }));
  check(l.source === "database" && l.profile.annualRevenueUsd === 5_000_000, "row present → source database, values merged");
  l = await loadProfile(db({ data: null, error: null }));
  check(l.source === "default" && !!l.reason?.includes("no row"), "no row → defaults with a reason");
  l = await loadProfile(db({ data: null, error: { message: 'relation "burn_profile" does not exist' } }));
  check(l.source === "default" && !!l.reason?.includes("does not exist"), "table missing → defaults, reason is the database's message");
  l = await loadProfile(db({ data: { profile: {} }, error: null }));
  check(l.source === "default", "empty profile object → treated as not loaded");
  l = await loadProfile(db({ data: { profile: { bogus: 1 } }, error: null }));
  check(l.source === "default" && l.ignored.includes("bogus"), "only-invalid keys → treated as not loaded, keys reported");
  l = await loadProfile({ from: () => { throw new Error("network down"); } } as any);
  check(l.source === "default" && l.reason === "network down", "a thrown error never breaks the check");

  // ── the private profile is optional ──
  console.log("\n──────── no private profile ────────");
  const facts = normalizeFacts({
    source_coverage: "full_rfp", extraction_confidence: 0.9,
    deadline: { date: "2026-12-15", status: "open" },
    geography: { scope: "specific_countries", countries: ["Kenya"] },
    sector: { covers_clean_cooking: "yes", eligible_technologies: ["electric"] },
    applicant: { eligible_org_types: ["for_profit_company"], structure: "single" },
  });
  const onDefaults = buildReport(facts, { sources: [], model: "t" }, BURN_PROFILE, NOW);
  check(onDefaults.verdict === "fit", "a clean call is 'fit' on the public defaults alone — nothing is downgraded for a missing profile");
  check(!onDefaults.notes_text.toLowerCase().includes("private profile"), "no 'profile not loaded' wording anywhere");
  const localReg = buildReport(normalizeFacts({ ...facts, applicant: { ...facts.applicant, local_registration_required: "yes" } }), { sources: [], model: "t" }, BURN_PROFILE, NOW);
  check(localReg.verdict === "fit" && !localReg.warnings.some((w) => w.id === "S6"), "a local-registration requirement in Kenya passes on the defaults (local company exists)");

  console.log(failed ? `\n${failed} FAILED` : "\nAll scenarios passed");
  process.exit(failed ? 1 : 0);
}
main();
