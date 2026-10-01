/* eslint-disable @typescript-eslint/no-explicit-any */
// Run: npx tsx test/rules.test.ts
// (npx downloads tsx on demand — it is deliberately NOT added to package.json,
// so package-lock.json stays in sync with what Vercel installs.)
import { normalizeFacts, schemaToTemplate, FACTS_SCHEMA, buildUserPrompt } from "../lib/eligibility/extract";
import { assessDocuments, buildReport } from "../lib/eligibility/rules";
import { BURN_PROFILE } from "../lib/eligibility/burnProfile";
import type { Verdict } from "../lib/eligibility/types";

const NOW = new Date("2026-09-29T12:00:00Z");
const meta = { sources: ["test"], model: "test" };

// Baseline: a call BURN should clearly fit. Each scenario overrides pieces.
const base = (): any => ({
  call_title: "Test call", funder: "Test funder", source_coverage: "full_rfp", extraction_confidence: 0.9,
  deadline: { date: "2026-12-15", is_rolling: false, status: "open", evidence: "Deadline 15 Dec 2026" },
  geography: { scope: "specific_countries", countries: ["Kenya", "Tanzania", "Uganda"], regions: [], excluded_countries: [], evidence: "Kenya, Tanzania, Uganda" },
  sector: { focus_areas: ["clean cooking"], covers_clean_cooking: "yes", eligible_technologies: ["improved_biomass", "electric"], excluded_technologies: [], evidence: "clean cooking" },
  applicant: { eligible_org_types: ["for_profit_company"], structure: "single", local_registration_required: "no", local_ownership_required: "no", women_or_youth_led_required: "no", startup_or_early_stage_only: "no", lead_must_be_local: "no", evidence: "private companies" },
  funding: { instruments: ["results_based_financing"], min_award_usd: 500000, max_award_usd: 3000000, evidence: "RBF" },
  documents_required: [
    { name: "Certificate of incorporation", url: null, mandatory: true },
    { name: "Audited financial statements (last year)", url: null, mandatory: true },
    { name: "Signed declaration of non-debarment", url: null, mandatory: true },
  ],
  submission_languages: ["English"], key_exclusions: [],
});

type Case = {
  name: string;
  expect: Verdict;
  mutate: (f: any) => void;
  mustMention?: string;
  mustNotMention?: string; // must NOT appear in the notes (used for "do not flag" decisions)
  profile?: Partial<typeof BURN_PROFILE>; // override BURN_PROFILE for this scenario
};

const cases: Case[] = [
  // ── original scenarios (from the grants project) ──
  { name: "Clean RBF call in BURN markets", expect: "fit", mutate: () => {} },
  { name: "Closed call", expect: "not_fit", mustMention: "closed", mutate: (f) => { f.deadline = { date: "2026-03-01", is_rolling: false, status: "closed", evidence: "closed" }; } },
  { name: "Asia-only call", expect: "not_fit", mustMention: "outside Africa", mutate: (f) => { f.geography = { scope: "regional", countries: [], regions: ["South Asia"], excluded_countries: [], evidence: "South Asia" }; } },
  { name: "NGO-only call", expect: "not_fit", mustMention: "for-profit", mutate: (f) => { f.applicant.eligible_org_types = ["ngo_nonprofit", "academic_research"]; } },
  { name: "Solar mini-grid call (no cooking)", expect: "not_fit", mustMention: "not in scope", mutate: (f) => { f.sector = { focus_areas: ["mini-grids"], covers_clean_cooking: "no", eligible_technologies: [], excluded_technologies: [], evidence: "mini-grids only" }; } },
  { name: "Biogas-only call", expect: "not_fit", mustMention: "biogas", mutate: (f) => { f.sector.eligible_technologies = ["biogas"]; } },
  { name: "SME cap of 250 employees", expect: "not_fit", mustMention: "employees", mutate: (f) => { f.applicant.max_employees = 250; } },
  { name: "Locally-owned enterprises only", expect: "not_fit", mustMention: "majority-owned", mutate: (f) => { f.applicant.local_ownership_required = "yes"; } },
  { name: "Women-led enterprises only", expect: "not_fit", mustMention: "women", mutate: (f) => { f.applicant.women_or_youth_led_required = "yes"; } },
  { name: "Early-stage start-ups only", expect: "not_fit", mustMention: "early-stage", mutate: (f) => { f.applicant.startup_or_early_stage_only = "yes"; } },
  { name: "Countries not in BURN config (Rwanda)", expect: "needs_review", mustMention: "Rwanda", mutate: (f) => { f.geography.countries = ["Rwanda"]; } },
  { name: "Landing page only", expect: "needs_review", mutate: (f) => { f.source_coverage = "landing_page_only"; f.extraction_confidence = 0.4; } },
  { name: "Rolling call, no deadline needed", expect: "fit", mutate: (f) => { f.deadline = { date: null, is_rolling: true, status: "open", evidence: "rolling" }; } },
  { name: "Consortium + stacking ban + 5 days left → fit with watch-outs", expect: "fit", mutate: (f) => {
      f.applicant.structure = "consortium"; f.stacking = { prohibits_double_subsidy: "yes", evidence: "no double funding" };
      f.deadline.date = "2026-10-04"; } },
  { name: "Global LMIC call", expect: "fit", mutate: (f) => { f.geography = { scope: "global", countries: [], regions: ["LMICs"], excluded_countries: [], evidence: "all LMICs" }; } },
  { name: "Excluded country list removes overlap (Kenya only, Kenya excluded)", expect: "not_fit", mutate: (f) => { f.geography = { scope: "specific_countries", countries: ["Kenya"], regions: [], excluded_countries: ["Kenya"], evidence: "" }; } },
  { name: "DRC alias resolves", expect: "fit", mutate: (f) => { f.geography.countries = ["Democratic Republic of the Congo"]; } },

  // ── added when merging into the grant-intelligence repo ──
  { name: "Turnover cap while BURN revenue is unset → needs review", expect: "needs_review", mustMention: "revenue not configured", mutate: (f) => { f.applicant.max_annual_turnover_usd = 5_000_000; } },
  { name: "Minimum turnover while BURN revenue is unset → needs review (was a soft warn)", expect: "needs_review", mustMention: "revenue not configured", mutate: (f) => { f.applicant.min_annual_turnover_usd = 1_000_000; } },
  { name: "Turnover cap fails once revenue is configured", expect: "not_fit", mustMention: "turnover cap", profile: { annualRevenueUsd: 40_000_000 }, mutate: (f) => { f.applicant.max_annual_turnover_usd = 5_000_000; } },
  { name: "Company-age cap of 5 yrs: only a younger subsidiary qualifies → watch-out", expect: "fit", mustMention: "younger local subsidiary", mutate: (f) => { f.applicant.max_company_age_years = 5; } },
  { name: "Company-age cap of 3 yrs → not fit", expect: "not_fit", mustMention: "age cap", mutate: (f) => { f.applicant.max_company_age_years = 3; } },
  { name: "Minimum 50M units sold → not fit", expect: "not_fit", mustMention: "units sold", mutate: (f) => { f.applicant.min_units_sold = 50_000_000; } },
  { name: "Minimum 1M units sold → fit", expect: "fit", mutate: (f) => { f.applicant.min_units_sold = 1_000_000; } },
  { name: "ISO tier 4 for electric, BURN tier unknown → watch-out", expect: "fit", mustMention: "aren't configured", mutate: (f) => { f.sector.eligible_technologies = ["electric"]; f.product_requirements = { min_iso_tier: 4, certifications_required: [], evidence: "Tier 4" }; } },
  { name: "Local registration required where no local company is configured → watch-out", expect: "fit", mustMention: "no configured local entity", profile: { countries: [{ name: "Kenya", presence: "manufacturing" }] }, mutate: (f) => { f.geography.countries = ["Kenya"]; f.applicant.local_registration_required = "yes"; } },
  { name: "Local registration required in Uganda (entity exists) → pass", expect: "fit", mutate: (f) => { f.geography.countries = ["Uganda"]; f.applicant.local_registration_required = "yes"; } },
  { name: "Deadline not stated → needs review", expect: "needs_review", mutate: (f) => { f.deadline = { date: null, is_rolling: false, status: "unclear", evidence: null }; } },
  { name: "LPG-only call → watch-out (limited line)", expect: "fit", mustMention: "limited line", mutate: (f) => { f.sector.eligible_technologies = ["lpg"]; } },
  { name: "Least-developed-countries label is not treated as global → needs review", expect: "needs_review", mustMention: "not recognised", mutate: (f) => { f.geography = { scope: "regional", countries: [], regions: ["Least Developed Countries"], excluded_countries: [], evidence: "LDCs" }; } },
  { name: "North Africa only → needs review, not a hard fail", expect: "needs_review", mustMention: "Egypt", mutate: (f) => { f.geography.countries = ["Egypt", "Morocco"]; } },
  { name: "Region label 'East Africa'", expect: "fit", mutate: (f) => { f.geography = { scope: "regional", countries: [], regions: ["East Africa"], excluded_countries: [], evidence: "" }; } },
  { name: "Region label 'Sub-Saharan Africa'", expect: "fit", mutate: (f) => { f.geography = { scope: "regional", countries: [], regions: ["Sub-Saharan Africa"], excluded_countries: [], evidence: "" }; } },
  { name: "Hard fail beats landing-page-only (NGO-only)", expect: "not_fit", mustMention: "for-profit", mutate: (f) => { f.source_coverage = "landing_page_only"; f.extraction_confidence = 0.4; f.applicant.eligible_org_types = ["ngo_nonprofit"]; } },
  { name: "Cooking not mentioned → needs review", expect: "needs_review", mustMention: "isn't explicitly mentioned", mutate: (f) => { f.sector.covers_clean_cooking = "unclear"; } },
  { name: "Carbon-credit restriction → watch-out", expect: "fit", mustMention: "carbon", mutate: (f) => { f.carbon = { restricts_carbon_credits: "yes", evidence: "no credits" }; } },
  { name: "French-only submission → watch-out", expect: "fit", mustMention: "translation", mutate: (f) => { f.submission_languages = ["French"]; } },
  { name: "Debt-only funding → watch-out", expect: "fit", mustMention: "treasury", mutate: (f) => { f.funding.instruments = ["concessional_loan"]; } },
  { name: "Pre-financing required, capacity not configured → not flagged (BURN is open to it)", expect: "fit", mustNotMention: "pre-financ", mutate: (f) => { f.funding.prefinancing_by_applicant_required = "yes"; } },
  { name: "Employee cap of 5000 is fine", expect: "fit", mutate: (f) => { f.applicant.max_employees = 5000; } },
  { name: "Locally-owned only, but profile says entities are locally owned → fit", expect: "fit", profile: { foreignControlledSubsidiaries: false }, mutate: (f) => { f.applicant.local_ownership_required = "yes"; } },
  { name: "Co-financing above configured comfort level → watch-out", expect: "fit", mustMention: "exceeds", profile: { maxCofinancingPct: 20 }, mutate: (f) => { f.funding.cofinancing_required_pct = 40; } },
  // The repo is public, so the real profile lives in a private table; these use
  // made-up example values to check that whatever the private profile holds
  // reaches the messages, and that empty values don't break them.
  { name: "Private notes reach the rule messages (made-up ownership note)", expect: "not_fit", mustMention: "Example Sub Ltd", profile: { notes: { ...BURN_PROFILE.notes, ownership: "e.g. Example Sub Ltd 99% Example Parent" } }, mutate: (f) => { f.applicant.local_ownership_required = "yes"; } },
  { name: "Empty notes: ownership message has no dangling brackets", expect: "not_fit", mustMention: "foreign-based group.", mutate: (f) => { f.applicant.local_ownership_required = "yes"; } },
  { name: "Stacking ban with NO commitments loaded → passes (the route flags a missing profile separately)", expect: "fit", mutate: (f) => { f.stacking = { prohibits_double_subsidy: "yes", evidence: "no double funding" }; } },
  { name: "Stacking ban + made-up overlapping programme → watch-out naming it", expect: "fit", mustMention: "Example Programme", profile: { activeCommitments: [{ programme: "Example Programme", countries: ["Kenya"], technologies: ["electric"], status: "active" }] }, mutate: (f) => { f.stacking = { prohibits_double_subsidy: "yes", evidence: "no double funding" }; } },
  { name: "Stacking ban, overlapping programme already past → passes", expect: "fit", profile: { activeCommitments: [{ programme: "Example Programme", countries: ["Kenya"], technologies: ["electric"], status: "past" }] }, mutate: (f) => { f.stacking = { prohibits_double_subsidy: "yes", evidence: "no double funding" }; } },
  { name: "Local registration where the entity name is not in the profile → falls back to the country", expect: "fit", mustNotMention: "local registration", mutate: (f) => { f.geography.countries = ["Uganda"]; f.applicant.local_registration_required = "yes"; } },
  { name: "Co-financing 60% with no limit configured → not flagged", expect: "fit", mustNotMention: "match", mutate: (f) => { f.funding.cofinancing_required_pct = 60; } },
  { name: "Local registration in a manufacturing country that also has a local company (localEntity) → passes", expect: "fit", mustNotMention: "local registration", profile: { countries: [{ name: "Kenya", presence: "manufacturing", localEntity: true }] }, mutate: (f) => { f.geography.countries = ["Kenya"]; f.applicant.local_registration_required = "yes"; } },
  // ── awards & prizes (added 2026-10-01) ──
  { name: "Prize-only award with a USD 20k cash prize → the grant effort threshold is not applied", expect: "fit", mustNotMention: "effort threshold",
    mutate: (f) => { f.funding = { instruments: ["prize"], min_award_usd: null, max_award_usd: 20000, evidence: "USD 20,000 prize" }; } },
  { name: "Recognition-only award (no cash) → fit, nothing about award size", expect: "fit", mustNotMention: "effort threshold",
    mutate: (f) => { f.funding = { instruments: ["prize"], min_award_usd: null, max_award_usd: null, evidence: null }; } },
  { name: "A small GRANT still trips the effort threshold (rule unchanged for grants)", expect: "fit", mustMention: "effort threshold",
    mutate: (f) => { f.funding = { instruments: ["grant"], min_award_usd: null, max_award_usd: 20000, evidence: "USD 20,000" }; } },
  { name: "Prize that also gives a grant is judged as a grant", expect: "fit", mustMention: "effort threshold",
    mutate: (f) => { f.funding = { instruments: ["prize", "grant"], min_award_usd: null, max_award_usd: 20000, evidence: "USD 20,000" }; } },
  { name: "Broad sustainability award (cooking not mentioned) → needs review, not a hard fail", expect: "needs_review", mustMention: "Check whether a cooking project would qualify",
    mutate: (f) => { f.funding = { instruments: ["prize"], min_award_usd: null, max_award_usd: null, evidence: null }; f.sector = { focus_areas: ["sustainability", "SDGs"], covers_clean_cooking: "unclear", eligible_technologies: [], excluded_technologies: [], evidence: "all SDGs" }; } },
  // award deadlines that have only just passed (NOW is 29 Sep 2026)
  { name: "Award, deadline passed 3 days ago, page not saying closed → needs review, not a fail", expect: "needs_review", mustMention: "often extended",
    mutate: (f) => { f.is_award = true; f.funding = { instruments: ["prize"], min_award_usd: null, max_award_usd: null, evidence: null };
      f.deadline = { date: "2026-09-26", is_rolling: false, status: "closed", evidence: "Apply by 26 September 2026" }; } },
  { name: "Award, deadline passed 3 days ago, but the page says applications are closed → not a fit", expect: "not_fit", mustMention: "already passed",
    mutate: (f) => { f.is_award = true; f.deadline = { date: "2026-09-26", is_rolling: false, status: "closed", evidence: "Applications are closed." }; } },
  { name: "Award, deadline passed 10 days ago → not a fit (outside the 7-day window)", expect: "not_fit", mustMention: "already passed",
    mutate: (f) => { f.is_award = true; f.deadline = { date: "2026-09-19", is_rolling: false, status: "open", evidence: "Apply by 19 Sep" }; } },
  { name: "Prize-only facts without the award flag are treated the same way", expect: "needs_review", mustMention: "often extended",
    mutate: (f) => { f.funding = { instruments: ["prize"], min_award_usd: null, max_award_usd: null, evidence: null }; f.deadline = { date: "2026-09-28", is_rolling: false, status: "closed", evidence: null }; } },
  { name: "A GRANT whose deadline passed 3 days ago is still a hard fail", expect: "not_fit", mustMention: "already passed",
    mutate: (f) => { f.deadline = { date: "2026-09-26", is_rolling: false, status: "closed", evidence: "Apply by 26 September 2026" }; } },
  { name: "Start-up-only award → not a fit", expect: "not_fit", mustMention: "early-stage",
    mutate: (f) => { f.funding = { instruments: ["prize"], min_award_usd: null, max_award_usd: 50000, evidence: null }; f.applicant.startup_or_early_stage_only = "yes"; } },
  { name: "Carbon restriction with no amount configured → no '$' or 'undefined' in the message", expect: "fit", mustMention: "active in carbon markets;", mutate: (f) => { f.carbon = { restricts_carbon_credits: "yes", evidence: "no credits" }; } },
];

const byName = (needle: string) => cases.find((c) => c.name.startsWith(needle))!;

let failed = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra}`);
};

for (const c of cases) {
  const f = base(); c.mutate(f);
  const profile = c.profile ? { ...BURN_PROFILE, ...c.profile } : undefined;
  const rep = buildReport(normalizeFacts(f), meta, profile, NOW);
  const okVerdict = rep.verdict === c.expect;
  const notes = rep.notes_text.toLowerCase();
  const okText = (!c.mustMention || notes.includes(c.mustMention.toLowerCase())) && (!c.mustNotMention || !notes.includes(c.mustNotMention.toLowerCase()));
  check(okVerdict && okText, c.name, ` → ${rep.verdict} (${rep.score})${okVerdict ? "" : `  expected ${c.expect}`}${okText ? "" : `  notes text check failed ("${c.mustMention ?? "not " + c.mustNotMention}")`}`);
}

// ── document inventory: word-boundary regression tests ──
console.log("\n──────── document matching ────────");
const docStatus = (name: string) => assessDocuments({ ...normalizeFacts(base()), documents_required: [{ name, url: null, mandatory: true }] })[0].status;
const docCases: [string, string][] = [
  ["Total amount requested", "unknown"],
  ["Terms of reference acknowledgement", "unknown"],
  ["Determination of eligibility", "unknown"],
  ["Onboarding plan", "unknown"],
  ["Certificate of good standing", "unknown"],
  ["Certificate of origin", "unknown"],
  ["Certificate of incorporation", "have"],
  ["Tax clearance certificate", "have"],
  ["Audited financial statements", "have"],
  ["Signed declaration of non-debarment", "can_produce"],
  ["Bank confirmation letter", "can_produce"],
  ["Letter of support from a partner", "needs_partner"],
  ["Signed MoU with the ministry", "needs_partner"],
  ["ERM / risk management policy", "have"],
  ["ISO 19867 test report", "have"],
];
for (const [name, expected] of docCases) check(docStatus(name) === expected, `doc "${name}"`, ` → ${docStatus(name)}${docStatus(name) === expected ? "" : ` expected ${expected}`}`);

// ── normalizeFacts ──
console.log("\n──────── normalizeFacts ────────");
{
  const n = normalizeFacts({
    source_coverage: "full_rfp", extraction_confidence: 0.8,
    deadline: { date: "2026-13-45", status: "open" },
    sector: { eligible_technologies: ["LPG", "clean cooking", "Improved Biomass", "lpg"], excluded_technologies: [] },
    applicant: { eligible_org_types: ["For-profit company", "Charity"], max_employees: "250", max_annual_turnover_usd: "$5,000,000", min_units_sold: "lots" },
  });
  check(n.deadline.date === null, "impossible date → null");
  check(JSON.stringify(n.sector.eligible_technologies) === JSON.stringify(["lpg", "improved_biomass"]), "technologies normalised, deduped, invalid dropped", ` → ${JSON.stringify(n.sector.eligible_technologies)}`);
  check(JSON.stringify(n.applicant.eligible_org_types) === JSON.stringify(["for_profit_company"]), "org types normalised, invalid dropped", ` → ${JSON.stringify(n.applicant.eligible_org_types)}`);
  check(n.applicant.max_employees === 250 && n.applicant.max_annual_turnover_usd === 5_000_000, "numeric strings parsed");
  check(n.applicant.min_units_sold === null, "non-numeric string → null");
  const empty = normalizeFacts(null);
  check(empty.source_coverage === "landing_page_only" && empty.extraction_confidence === 0.3, "empty input fails safe (landing page, low confidence)");
  check(buildReport(empty, meta, undefined, NOW).verdict === "needs_review", "empty input → needs_review, never fit");
  const tpl = schemaToTemplate(FACTS_SCHEMA);
  check(typeof tpl.geography.scope === "string" && tpl.geography.scope.includes("specific_countries") && Array.isArray(tpl.documents_required), "schemaToTemplate mirrors FACTS_SCHEMA");
}

// ── plain-language summaries ──
console.log("\n──────── summary wording ────────");
{
  const run = (mutate: (f: any) => void, link?: string | null) => { const f = base(); mutate(f); return buildReport(normalizeFacts(f), { ...meta, link }, undefined, NOW); };
  const closed = run((f) => { f.deadline = { date: "2026-09-25", is_rolling: false, status: "closed", evidence: "closed" }; });
  check(closed.summary.startsWith("the blocking issue is the deadline:") && closed.summary.includes("25 Sep 2026") && closed.summary.includes("already passed"), "closed call → 'the blocking issue is the deadline … 25 Sep 2026 … already passed'", `  (${closed.summary})`);
  check(closed.notes_text.startsWith("NOT A FIT — "), "notes head reads 'NOT A FIT'");
  const two = run((f) => { f.deadline = { date: "2026-09-25", is_rolling: false, status: "closed", evidence: "" }; f.applicant.eligible_org_types = ["ngo_nonprofit"]; });
  check(two.summary.startsWith("there are 2 blocking issues.") && two.summary.includes("(1) the deadline") && two.summary.includes("(2) the applicant type"), "two blockers are numbered in plain words", `  (${two.summary})`);
  const ngo = run((f) => { f.applicant.eligible_org_types = ["ngo_nonprofit"]; });
  check(ngo.summary.startsWith("the blocking issue is the applicant type:") && ngo.summary.includes("for-profit"), "NGO-only → names the applicant type", `  (${ngo.summary})`);
  const clean = run(() => {});
  check(clean.verdict === "fit" && clean.summary === "meets all the requirements we could check, with nothing to watch.", "clean fit wording", `  (${clean.summary})`);
  const watch = run((f) => { f.submission_languages = ["French"]; });
  check(watch.verdict === "fit" && watch.summary.includes("1 point to watch: language"), "fit with a watch-out names it", `  (${watch.summary})`);
  const landing = run((f) => { f.source_coverage = "landing_page_only"; });
  check(landing.verdict === "needs_review" && landing.summary.includes("couldn't read enough of the call") && landing.summary.includes("account or login"), "landing page only → asks for a manual look and mentions logins", `  (${landing.summary})`);
  const withLink = run((f) => { f.source_coverage = "landing_page_only"; }, "The page looks like it needs an account or login to show the full call details");
  check(withLink.summary.includes("needs an account or login to show the full call details.") && withLink.notes_text.includes("LINK: "), "a link note replaces the generic hint and is saved in the notes");
  const unclear = run((f) => { f.sector.covers_clean_cooking = "unclear"; });
  check(unclear.verdict === "needs_review" && unclear.summary.includes("couldn't be confirmed from the call: sector"), "unclear criterion is named", `  (${unclear.summary})`);
  check(!/private profile|profile was not loaded/i.test([clean, closed, landing, unclear].map((r) => r.notes_text).join(" ")), "no wording about a profile not being loaded, anywhere");
}

// ── prize value rule ──
{
  const f = base(); f.funding = { instruments: ["prize"], min_award_usd: null, max_award_usd: 20000, evidence: "USD 20,000 prize" };
  const rep = buildReport(normalizeFacts(f), meta, undefined, NOW);
  check(rep.passed.some((r) => r.id === "S2" && r.detail.includes("$20k") && r.detail.includes("visibility of winning")), "prize-only: S2 passes with the prize value and the visibility note");
}

// ── award-aware prompt ──
console.log("\n──────── award prompt ────────");
{
  const ctx = { today: "2026-10-01", trackerContext: "", coverageHint: "h", sourceNotes: [] as string[] };
  const grantPrompt = buildUserPrompt(ctx);
  const awardPrompt = buildUserPrompt({ ...ctx, kind: "award" });
  check(!grantPrompt.includes("AWARD / PRIZE") && grantPrompt === buildUserPrompt({ ...ctx, kind: "grant" }), "grant prompt is unchanged");
  check(awardPrompt.includes("AWARD / PRIZE / COMPETITION") && awardPrompt.includes('["prize"]') && awardPrompt.includes("ENTRY / NOMINATION deadline") && awardPrompt.includes("BROAD"), "award prompt explains prize, entry deadline and broad-sector handling");
  check(awardPrompt.indexOf("AWARD / PRIZE") < awardPrompt.indexOf("Extract the call facts"), "award note comes before the extraction instruction");
}

console.log("\n──────── sample notes: consortium + stacking + tight deadline ────────");
{
  const f = base(); byName("Consortium + stacking").mutate(f);
  console.log(buildReport(normalizeFacts(f), meta, undefined, NOW).notes_text);
}
console.log("\n──────── sample notes: NGO-only ────────");
{
  const f = base(); byName("NGO-only").mutate(f);
  console.log(buildReport(normalizeFacts(f), meta, undefined, NOW).notes_text);
}
console.log(failed ? `\n${failed} FAILED` : "\nAll scenarios passed");
process.exit(failed ? 1 : 0);
