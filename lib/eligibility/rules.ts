import { BURN_PROFILE, DOCUMENT_INVENTORY } from "./burnProfile";
import type {
  CallFacts,
  DocReadiness,
  EligibilityReport,
  RuleResult,
  RuleStatus,
  Severity,
  Technology,
  Verdict,
} from "./types";

type Profile = typeof BURN_PROFILE;

// ───────────────────────── geography helpers ─────────────────────────

const SSA = [
  "Angola", "Benin", "Botswana", "Burkina Faso", "Burundi", "Cameroon", "Cape Verde", "Central African Republic",
  "Chad", "Comoros", "Congo", "DRC", "Cote d'Ivoire", "Djibouti", "Equatorial Guinea", "Eritrea", "Eswatini",
  "Ethiopia", "Gabon", "Gambia", "Ghana", "Guinea", "Guinea-Bissau", "Kenya", "Lesotho", "Liberia", "Madagascar",
  "Malawi", "Mali", "Mauritania", "Mauritius", "Mozambique", "Namibia", "Niger", "Nigeria", "Rwanda",
  "Sao Tome and Principe", "Senegal", "Seychelles", "Sierra Leone", "Somalia", "South Africa", "South Sudan",
  "Sudan", "Tanzania", "Togo", "Uganda", "Zambia", "Zimbabwe",
];
// A call naming only these is "unclear" (BURN might expand there), never a hard fail.
const NORTH_AFRICA = ["Algeria", "Egypt", "Libya", "Morocco", "Tunisia"];
const AFRICA = [...SSA, ...NORTH_AFRICA];

const REGION_RULES: [RegExp, string[]][] = [
  [/sub-?saharan|^africa$|all of africa|african countries|across africa/, SSA],
  [/east(ern)? africa|\beac\b/, ["Burundi", "Djibouti", "Eritrea", "Ethiopia", "Kenya", "Rwanda", "Somalia", "South Sudan", "Tanzania", "Uganda"]],
  [/southern africa|\bsadc\b/, ["Angola", "Botswana", "Eswatini", "Lesotho", "Madagascar", "Malawi", "Mozambique", "Namibia", "South Africa", "Zambia", "Zimbabwe"]],
  [/west(ern)? africa|\becowas\b/, ["Benin", "Burkina Faso", "Cape Verde", "Cote d'Ivoire", "Gambia", "Ghana", "Guinea", "Guinea-Bissau", "Liberia", "Mali", "Mauritania", "Niger", "Nigeria", "Senegal", "Sierra Leone", "Togo"]],
  [/central africa/, ["Cameroon", "Central African Republic", "Chad", "Congo", "DRC", "Equatorial Guinea", "Gabon", "Sao Tome and Principe"]],
  [/horn of africa/, ["Djibouti", "Eritrea", "Ethiopia", "Somalia", "Kenya"]],
  [/great lakes/, ["Burundi", "DRC", "Kenya", "Rwanda", "Tanzania", "Uganda"]],
  [/north africa|maghreb|\bmena\b/, NORTH_AFRICA],
];
const OUTSIDE_AFRICA = /asia|latin america|caribbean|pacific|middle east|europe|central america|south america/i;
const GLOBAL = /global|worldwide|lmics?|low[- ]and[- ]middle|developing countr|all countries|emerging market/i;

const ALIASES: Record<string, string> = {
  "drc": "DRC", "dr congo": "DRC", "d.r. congo": "DRC", "democratic republic of congo": "DRC",
  "democratic republic of the congo": "DRC", "congo (dr)": "DRC", "congo, democratic republic of the": "DRC",
  "congo-kinshasa": "DRC", "republic of the congo": "Congo", "congo-brazzaville": "Congo", "congo": "Congo",
  "united republic of tanzania": "Tanzania", "tanzania": "Tanzania", "ivory coast": "Cote d'Ivoire",
  "cote d'ivoire": "Cote d'Ivoire", "swaziland": "Eswatini", "the gambia": "Gambia", "cabo verde": "Cape Verde",
};

export function normCountry(raw: string): string {
  const k = raw
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
  if (ALIASES[k]) return ALIASES[k];
  const hit = AFRICA.find((c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() === k);
  return hit ?? raw.trim();
}

function expandGeography(f: CallFacts["geography"]) {
  const set = new Set<string>();
  let outsideAfrica = false;
  let global = f.scope === "global";
  // Region labels we couldn't interpret (e.g. "LDCs", "Global South partners").
  // These must lead to "unclear", never to a hard "no BURN market" fail.
  const unknownRegions: string[] = [];
  for (const c of f.countries) set.add(normCountry(c));
  for (const r of f.regions) {
    const k = r.toLowerCase().trim();
    let matched = false;
    for (const [re, list] of REGION_RULES) {
      if (re.test(k)) { list.forEach((c) => set.add(c)); matched = true; }
    }
    if (!matched) {
      if (OUTSIDE_AFRICA.test(k)) outsideAfrica = true;
      else if (GLOBAL.test(k)) global = true;
      else unknownRegions.push(r);
    }
  }
  for (const c of f.excluded_countries) set.delete(normCountry(c));
  return { set, outsideAfrica, global, unknownRegions };
}

// ───────────────────────── small helpers ─────────────────────────

const mk = (
  id: string, label: string, severity: Severity, status: RuleStatus, detail: string, evidence: string | null = null
): RuleResult => ({ id, label, severity, status, detail, evidence });

const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}k`);
const list = (a: string[]) => a.join(", ");

// Plain names for the machine values, so messages read naturally.
const TECH_NAMES: Record<string, string> = {
  improved_biomass: "improved biomass stoves", institutional: "institutional cookstoves", electric: "electric cooking",
  lpg: "LPG", biogas: "biogas", ethanol: "ethanol", solar_cooking: "solar cooking", all_clean_cooking: "all clean cooking", other: "other technologies",
};
const ORG_NAMES: Record<string, string> = {
  for_profit_company: "for-profit companies", ngo_nonprofit: "NGOs / non-profits", academic_research: "academic and research institutions",
  government: "government bodies", utility: "utilities", financial_institution: "financial institutions",
  cooperative_or_association: "cooperatives and associations", individual: "individuals", any: "any organisation",
};
const techs = (a: string[]) => list(a.map((t) => TECH_NAMES[t] ?? t));
const orgs = (a: string[]) => list(a.map((t) => ORG_NAMES[t] ?? t));
const withNote = (s: string) => (s ? ` (${s})` : "");

// ───────────────────────── the rules ─────────────────────────

// An award whose entry deadline passed within this many days is sent for review
// instead of failed, unless the call says in so many words that it is closed:
// award deadlines are often extended. Keep in step with AWARD_GRACE_DAYS in
// scripts/gemini_discover.py and components/GrantScanner.tsx.
const AWARD_GRACE_DAYS = 7;
const SAYS_CLOSED = /\b(closed|no longer (accept|open)|has ended|have ended|applications? (is|are) closed|geschlossen|beendet|clôtur)/i;

// "2026-09-25" -> "25 Sep 2026" (falls back to the raw text if it isn't a date).
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function evaluateRules(f: CallFacts, P: Profile = BURN_PROFILE, now = new Date()): RuleResult[] {
  const rules: RuleResult[] = [];
  const burnCountries = P.countries.map((c) => c.name);
  const geo = expandGeography(f.geography);

  // H1 — deadline ---------------------------------------------------------
  {
    const d = f.deadline;
    const parsed = d.date ? new Date(`${d.date}T23:59:59Z`) : null;
    const days = parsed && !isNaN(+parsed) ? Math.ceil((+parsed - +now) / 86_400_000) : null;
    // An award whose deadline has only just passed, with nothing in the call saying it is closed.
    const pastBy = parsed && !isNaN(+parsed) && +parsed < +now ? Math.max(1, Math.ceil((+now - +parsed) / 86_400_000)) : 0;
    const isAward = f.is_award === true || (f.funding.instruments.length > 0 && f.funding.instruments.every((i) => i === "prize"));
    const lapsedAward = isAward && !d.is_rolling && pastBy > 0 && pastBy <= AWARD_GRACE_DAYS && !(d.evidence && SAYS_CLOSED.test(d.evidence));
    if (d.is_rolling) rules.push(mk("H1", "Deadline", "hard", "pass", "Rolling / open-ended call.", d.evidence));
    else if (lapsedAward)
      rules.push(mk("H1", "Deadline", "hard", "unclear", `The entry deadline (${fmtDate(d.date as string)}) passed ${pastBy} day${pastBy === 1 ? "" : "s"} ago, but the page doesn't say entries are closed. Award deadlines are often extended — confirm with the organiser before investing time.`, d.evidence));
    else if (d.status === "closed" || (days !== null && days < 0))
      rules.push(mk("H1", "Deadline", "hard", "fail", d.date ? `The call closed on ${fmtDate(d.date)}, so the deadline has already passed.` : "The call is marked as closed.", d.evidence));
    else if (days !== null) rules.push(mk("H1", "Deadline", "hard", "pass", `Open — ${days} day(s) left (${d.date}).`, d.evidence));
    else if (d.status === "open") rules.push(mk("H1", "Deadline", "hard", "pass", "Marked open; no deadline date found.", d.evidence));
    else rules.push(mk("H1", "Deadline", "hard", "unclear", "No deadline or open/closed status found in the sources.", d.evidence));

    // S12 — timeline
    if (days !== null && days >= 0 && !d.is_rolling) {
      if (days < P.minDaysToApply)
        rules.push(mk("S12", "Timeline", "soft", "warn", `Only ${days} day(s) left — tight for a full application (BURN threshold: ${P.minDaysToApply}).`, d.evidence));
      else rules.push(mk("S12", "Timeline", "soft", "pass", `${days} days to prepare.`, d.evidence));
    }
  }

  // H2 — geography --------------------------------------------------------
  {
    const g = f.geography;
    const overlap = [...geo.set].filter((c) => burnCountries.includes(c));
    const expansion = [...geo.set].filter((c) => P.expansionCountries.includes(c));
    const africaOther = [...geo.set].filter((c) => AFRICA.includes(c) && !burnCountries.includes(c));
    if (g.scope === "unclear" && geo.set.size === 0 && !geo.global && !geo.outsideAfrica && geo.unknownRegions.length === 0)
      rules.push(mk("H2", "Geography", "hard", "unclear", "Eligible countries are not stated in the sources.", g.evidence));
    else if (geo.global && geo.set.size === 0)
      rules.push(mk("H2", "Geography", "hard", "pass", "Global / all-LMIC scope — BURN's African markets are eligible.", g.evidence));
    else if (overlap.length > 0)
      rules.push(mk("H2", "Geography", "hard", "pass", `Overlaps ${overlap.length} BURN market(s): ${list(overlap)}.`, g.evidence));
    else if (expansion.length > 0)
      rules.push(mk("H2", "Geography", "hard", "pass", `Only expansion countries covered (${list(expansion)}) — BURN not yet operating there.`, g.evidence));
    else if (africaOther.length > 0)
      rules.push(mk("H2", "Geography", "hard", "unclear", `Covers African countries not in BURN's configured markets (${list(africaOther.slice(0, 8))}). Confirm whether BURN operates there (update burnProfile.countries).`, g.evidence));
    else if (geo.set.size === 0 && !geo.outsideAfrica && geo.unknownRegions.length > 0)
      rules.push(mk("H2", "Geography", "hard", "unclear", `Region label(s) not recognised: ${list(geo.unknownRegions)}. Check whether BURN's countries are covered.`, g.evidence));
    else
      rules.push(mk("H2", "Geography", "hard", "fail", `Call covers ${geo.outsideAfrica ? "regions outside Africa" : list([...geo.set].slice(0, 8)) || "no BURN market"} — BURN operates in ${list(burnCountries)}.`, g.evidence));
  }

  // H3 — sector -----------------------------------------------------------
  const sectorOk = f.sector.covers_clean_cooking !== "no";
  {
    const s = f.sector;
    if (s.covers_clean_cooking === "yes") rules.push(mk("H3", "Sector", "hard", "pass", "Clean cooking is explicitly in scope.", s.evidence));
    else if (s.covers_clean_cooking === "no")
      rules.push(mk("H3", "Sector", "hard", "fail", `Call focuses on ${list(s.focus_areas) || "an unrelated sector"}; clean cooking is not in scope.`, s.evidence));
    else rules.push(mk("H3", "Sector", "hard", "unclear", `Cooking isn't explicitly mentioned (focus: ${list(s.focus_areas) || "not stated"}). Check whether a cooking project would qualify.`, s.evidence));
  }

  // H4 — technology -------------------------------------------------------
  if (sectorOk) {
    const el = new Set<Technology>(f.sector.eligible_technologies);
    const ex = new Set<Technology>(f.sector.excluded_technologies);
    const open = el.size === 0 || el.has("all_clean_cooking");
    const okMain = P.technologies.main.filter((t) => (open || el.has(t)) && !ex.has(t));
    const okLimited = P.technologies.limited.filter((t) => (open || el.has(t)) && !ex.has(t));
    if (okMain.length) rules.push(mk("H4", "Technology", "hard", "pass", `BURN products eligible: ${techs(okMain)}.`, f.sector.evidence));
    else if (okLimited.length && !open)
      rules.push(mk("H4", "Technology", "soft", "warn", `Only ${techs(okLimited)} eligible — BURN's gas appliances are a limited line.`, f.sector.evidence));
    else if ([...el].every((t) => t === "other") && el.size > 0)
      rules.push(mk("H4", "Technology", "hard", "unclear", "Eligible technologies are described vaguely — check product list.", f.sector.evidence));
    else
      rules.push(mk("H4", "Technology", "hard", "fail", `Call funds ${techs([...el]) || "none of BURN's technologies"}${ex.size ? ` and excludes ${techs([...ex])}` : ""}; BURN offers ${techs(P.technologies.main)}.`, f.sector.evidence));
  }

  // H5 — applicant organisation type ---------------------------------------
  {
    const a = f.applicant;
    const types = new Set(a.eligible_org_types);
    if (types.size === 0) rules.push(mk("H5", "Applicant type", "hard", "unclear", "Eligible organisation types not stated.", a.evidence));
    else if (types.has("any") || types.has(P.orgType)) rules.push(mk("H5", "Applicant type", "hard", "pass", "For-profit companies are eligible.", a.evidence));
    else rules.push(mk("H5", "Applicant type", "hard", "fail", `Open only to ${orgs([...types])}; BURN is a for-profit company.`, a.evidence));
  }

  // H6 — ownership / locality ----------------------------------------------
  {
    const a = f.applicant;
    if (a.local_ownership_required === "yes" && P.foreignControlledSubsidiaries)
      rules.push(mk("H6", "Local ownership", "hard", "fail", `Requires locally-owned/national enterprises; BURN's subsidiaries are majority-owned by the foreign-based group${withNote(P.notes.ownership)}.`, a.evidence));
    else if (a.local_ownership_required === "yes")
      rules.push(mk("H6", "Local ownership", "hard", "pass", "Local ownership required; BURN's entities are locally owned (per profile).", a.evidence));
    else rules.push(mk("H6", "Local ownership", "hard", "pass", "No local-ownership requirement found.", a.evidence));

    if (a.lead_must_be_local === "yes")
      rules.push(mk("S6a", "Local lead", "soft", "warn", "Lead applicant must be a local entity — the in-country BURN subsidiary would need to lead.", a.evidence));
    if (a.local_registration_required === "yes") {
      const withEntity = P.countries.filter((c) => (c.presence === "local_entity" || c.localEntity) && (geo.global || geo.set.has(c.name)));
      if (withEntity.length) rules.push(mk("S6", "Local registration", "soft", "pass", `Registered entity exists: ${withEntity.map((c) => c.entity ?? `${c.name} subsidiary`).join(", ")}.`, a.evidence));
      else rules.push(mk("S6", "Local registration", "soft", "warn", "Requires local registration; BURN has no configured local entity in the covered countries — check subsidiary status.", a.evidence));
    }
  }

  // H7 — size caps ---------------------------------------------------------
  {
    const a = f.applicant;
    if (a.max_employees !== null) {
      if (P.headcount > a.max_employees)
        rules.push(mk("H7a", "Employee cap", "hard", "fail", `Cap of ${a.max_employees} employees vs BURN group ${P.headcount.toLocaleString()}+ (confirm whether the funder counts the subsidiary alone).`, a.evidence));
      else rules.push(mk("H7a", "Employee cap", "hard", "pass", `Within ${a.max_employees}-employee cap.`, a.evidence));
    }
    if (a.max_annual_turnover_usd !== null) {
      if (P.annualRevenueUsd === null) rules.push(mk("H7b", "Turnover cap", "hard", "unclear", `Turnover capped at ${money(a.max_annual_turnover_usd)}; BURN revenue not configured — confirm.`, a.evidence));
      else if (P.annualRevenueUsd > a.max_annual_turnover_usd) rules.push(mk("H7b", "Turnover cap", "hard", "fail", `Turnover cap ${money(a.max_annual_turnover_usd)} < BURN ${money(P.annualRevenueUsd)}.`, a.evidence));
      else rules.push(mk("H7b", "Turnover cap", "hard", "pass", "Within turnover cap.", a.evidence));
    }
    if (a.min_annual_turnover_usd !== null) {
      // Same treatment as H7b: unknown revenue is a hard "unclear", not a soft warning.
      if (P.annualRevenueUsd === null) rules.push(mk("H7c", "Minimum turnover", "hard", "unclear", `Requires ≥ ${money(a.min_annual_turnover_usd)} turnover; BURN revenue not configured — confirm.`, a.evidence));
      else if (P.annualRevenueUsd < a.min_annual_turnover_usd) rules.push(mk("H7c", "Minimum turnover", "hard", "fail", `Requires ≥ ${money(a.min_annual_turnover_usd)}.`, a.evidence));
      else rules.push(mk("H7c", "Minimum turnover", "hard", "pass", "Meets minimum turnover.", a.evidence));
    }
  }

  // H8 — led-by / stage / age ------------------------------------------------
  {
    const a = f.applicant;
    if (a.women_or_youth_led_required === "yes")
      rules.push(mk("H8a", "Women/youth-led only", "hard", "fail", "Restricted to women- or youth-led enterprises; BURN doesn't qualify as applicant (could only participate via such partners).", a.evidence));
    if (a.startup_or_early_stage_only === "yes")
      rules.push(mk("H8b", "Start-up / early-stage only", "hard", "fail", `Restricted to early-stage companies; BURN was founded ${P.groupFoundedYear}.`, a.evidence));
    const groupAge = now.getFullYear() - P.groupFoundedYear;
    if (a.max_company_age_years !== null) {
      const localYears = P.countries.filter((c) => c.presence === "local_entity" && c.sinceYear).map((c) => now.getFullYear() - c.sinceYear!);
      const youngest = localYears.length ? Math.min(...localYears) : null;
      if (groupAge <= a.max_company_age_years) rules.push(mk("H8c", "Company age", "hard", "pass", "Within company-age limit.", a.evidence));
      else if (youngest !== null && youngest <= a.max_company_age_years)
        rules.push(mk("H8c", "Company age", "soft", "warn", `Group is ${groupAge} yrs old (cap ${a.max_company_age_years}); only a younger local subsidiary (${youngest} yrs) could qualify — check if funder assesses the entity alone.`, a.evidence));
      else rules.push(mk("H8c", "Company age", "hard", "fail", `Age cap ${a.max_company_age_years} yrs vs group ${groupAge} yrs.`, a.evidence));
    }
    if (a.min_company_age_years !== null && groupAge < a.min_company_age_years)
      rules.push(mk("H8d", "Minimum company age", "hard", "fail", `Requires ≥ ${a.min_company_age_years} yrs.`, a.evidence));
  }

  // H9 — track record ------------------------------------------------------
  if (f.applicant.min_units_sold !== null) {
    const need = f.applicant.min_units_sold;
    rules.push(P.unitsSoldToDate >= need
      ? mk("H9", "Track record", "hard", "pass", `Requires ≥ ${need.toLocaleString()} units; BURN has sold ~${(P.unitsSoldToDate / 1e6).toFixed(1)}M.`, f.applicant.evidence)
      : mk("H9", "Track record", "hard", "fail", `Requires ≥ ${need.toLocaleString()} units sold.`, f.applicant.evidence));
  }

  // S1 — funding instrument -------------------------------------------------
  {
    const ins = f.funding.instruments;
    const grantLike = ins.filter((i) => ["grant", "results_based_financing", "technical_assistance", "carbon_prefinance", "prize", "guarantee"].includes(i));
    if (ins.length === 0) rules.push(mk("S1", "Funding instrument", "soft", "na", "Instrument not stated.", f.funding.evidence));
    else if (grantLike.length) rules.push(mk("S1", "Funding instrument", "soft", "pass", `Offers ${list(grantLike)}.`, f.funding.evidence));
    else rules.push(mk("S1", "Funding instrument", "soft", "warn", `Only ${list(ins)} — BURN's track record is grants/RBF/carbon pre-finance; debt/equity needs treasury sign-off.`, f.funding.evidence));
  }

  // S2 — award size --------------------------------------------------------
  {
    const { min_award_usd: lo, max_award_usd: hi } = f.funding;
    // A prize-only competition is entered for visibility and credibility as
    // much as for the money, so BURN's grant effort threshold doesn't apply.
    const prizeOnly = f.funding.instruments.length > 0 && f.funding.instruments.every((i) => i === "prize");
    if (prizeOnly) {
      if (hi !== null) rules.push(mk("S2", "Prize value", "soft", "pass", `Cash prize of up to ${money(hi)}, plus the visibility of winning.`, f.funding.evidence));
    } else if (hi !== null && hi < P.minWorthwhileAwardUsd)
      rules.push(mk("S2", "Award size", "soft", "warn", `Max award ${money(hi)} is below BURN's ${money(P.minWorthwhileAwardUsd)} effort threshold.`, f.funding.evidence));
    else if (lo !== null && lo > P.maxRealisticAskUsd)
      rules.push(mk("S2", "Award size", "soft", "warn", `Minimum award ${money(lo)} exceeds BURN's demonstrated range (max ask ${money(P.maxRealisticAskUsd)}).`, f.funding.evidence));
    else if (lo !== null || hi !== null)
      rules.push(mk("S2", "Award size", "soft", "pass", `Award range ${lo !== null ? money(lo) : "?"}–${hi !== null ? money(hi) : "?"}.`, f.funding.evidence));
  }

  // S3 — co-financing ------------------------------------------------------
  if (f.funding.cofinancing_required_pct !== null) {
    const pct = f.funding.cofinancing_required_pct;
    // No cap configured = BURN co-finances as a matter of course, so nothing to flag.
    if (P.maxCofinancingPct === null) rules.push(mk("S3", "Co-financing", "soft", "pass", `${pct}% match required — BURN co-finances; no limit configured.`, f.funding.evidence));
    else if (pct > P.maxCofinancingPct) rules.push(mk("S3", "Co-financing", "soft", "warn", `${pct}% match exceeds BURN's ${P.maxCofinancingPct}% comfort level.`, f.funding.evidence));
    else rules.push(mk("S3", "Co-financing", "soft", "pass", `${pct}% match is within capacity.`, f.funding.evidence));
  }

  // S4 — pre-financing -----------------------------------------------------
  if (f.funding.prefinancing_by_applicant_required === "yes") {
    // No capacity configured = BURN is open to pre-financing, so nothing to flag.
    rules.push(P.prefinancingCapacityUsd === null
      ? mk("S4", "Pre-financing", "soft", "pass", `Applicant must pre-finance deliveries (results-based); BURN is open to this${P.notes.prefinancing ? ` — ${P.notes.prefinancing}` : ""}.`, f.funding.evidence)
      : mk("S4", "Pre-financing", "soft", "pass", `Pre-financing required; BURN capacity ${money(P.prefinancingCapacityUsd)}.`, f.funding.evidence));
  }

  // S5 — consortium ---------------------------------------------------------
  {
    const a = f.applicant;
    if (a.structure === "consortium")
      rules.push(mk("S5", "Consortium", "soft", "warn", `Consortium required${a.consortium_requirements ? `: ${a.consortium_requirements}` : ""}. Needs partners aligned + a signed consortium agreement/budget before contract${withNote(P.notes.consortium)}.`, a.evidence));
    else if (a.structure === "single" || a.structure === "either")
      rules.push(mk("S5", "Consortium", "soft", "pass", a.structure === "single" ? "Single applicant allowed." : "Single or consortium allowed.", a.evidence));
  }

  // S7 — double subsidy / stacking ------------------------------------------
  if (f.stacking.prohibits_double_subsidy === "yes") {
    const overlaps = P.activeCommitments.filter((c) => c.status !== "past" && (geo.global || c.countries.some((x) => geo.set.has(x))));
    if (overlaps.length)
      rules.push(mk("S7", "Double-subsidy", "soft", "warn", `Funder bars stacking; BURN has overlapping programmes: ${overlaps.map((c) => `${c.programme} (${list(c.countries.filter((x) => geo.global || geo.set.has(x)))})`).join("; ")}. An additionality statement is needed.`, f.stacking.evidence));
    else rules.push(mk("S7", "Double-subsidy", "soft", "pass", "Stacking restricted, but no overlapping BURN programme in the covered countries.", f.stacking.evidence));
  }

  // S8 — carbon rights ------------------------------------------------------
  if (f.carbon.restricts_carbon_credits === "yes")
    rules.push(mk("S8", "Carbon credits", "soft", "warn", `Call restricts carbon-credit claims on funded units — BURN is active in carbon markets${P.carbonFinanceRaisedUsd !== null || P.notes.carbon ? ` (${[P.carbonFinanceRaisedUsd !== null ? `${money(P.carbonFinanceRaisedUsd)} raised` : "", P.notes.carbon].filter(Boolean).join(", ")})` : ""}; confirm no double-claiming issue.`, f.carbon.evidence));

  // S9 — product standard ---------------------------------------------------
  if (f.product_requirements.min_iso_tier !== null) {
    const need = f.product_requirements.min_iso_tier;
    const el = f.sector.eligible_technologies;
    const techs = (el.length === 0 || el.includes("all_clean_cooking") ? P.technologies.main : P.technologies.main.filter((t) => el.includes(t))) as string[];
    const tiers = techs.map((t) => P.bestKnownIsoTier[t]).filter((x): x is number => typeof x === "number");
    if (tiers.length === 0) rules.push(mk("S9", "Product tier", "soft", "warn", `Requires ISO 19867 Tier ≥ ${need}; BURN tiers for these products aren't configured.`, f.product_requirements.evidence));
    else if (Math.max(...tiers) >= need) rules.push(mk("S9", "Product tier", "soft", "pass", `Tier ≥ ${need} met (best documented Tier ${Math.max(...tiers)}).`, f.product_requirements.evidence));
    else rules.push(mk("S9", "Product tier", "soft", "warn", `Requires Tier ≥ ${need}; best documented is Tier ${Math.max(...tiers)}.`, f.product_requirements.evidence));
  }

  // S11 — language -----------------------------------------------------------
  {
    const langs = f.submission_languages.map((l) => l.toLowerCase());
    if (langs.length && !langs.some((l) => l.includes("english")))
      rules.push(mk("S11", "Language", "soft", "warn", `Submission in ${list(f.submission_languages)} only — budget for translation/review.`, null));
  }

  return rules;
}

// ───────────────────────── documents ─────────────────────────

export function assessDocuments(f: CallFacts): DocReadiness[] {
  return f.documents_required.map((d) => {
    const hit = DOCUMENT_INVENTORY.find((i) => i.match.test(d.name));
    return hit
      ? { name: d.name, mandatory: d.mandatory, status: hit.status, note: hit.note }
      : { name: d.name, mandatory: d.mandatory, status: "unknown", note: "No matching item in BURN's document inventory — check manually." };
  });
}

// ───────────────────────── verdict + report ─────────────────────────

// What each hard rule is called in a sentence ("the blocking issue is the deadline").
const TOPIC: Record<string, string> = {
  H1: "deadline", H2: "geography", H3: "sector", H4: "technology", H5: "applicant type",
  H6: "local-ownership requirement", H7a: "employee cap", H7b: "turnover cap", H7c: "minimum-turnover requirement",
  H8a: "women/youth-led requirement", H8b: "start-up requirement", H8c: "company-age limit", H8d: "minimum company age", H9: "track-record requirement",
};
const topicOf = (r: RuleResult) => TOPIC[r.id] ?? r.label.toLowerCase();
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const noStop = (s: string) => s.replace(/[.\s]+$/, "");

export function buildReport(
  f: CallFacts,
  meta: { sources: string[]; model: string; link?: string | null },
  P: Profile = BURN_PROFILE,
  now = new Date()
): EligibilityReport {
  const rules = evaluateRules(f, P, now);
  const docs = assessDocuments(f);

  // S10 — documents (needs the doc assessment)
  const blockedDocs = docs.filter((d) => d.mandatory && d.status === "needs_partner");
  const unknownDocs = docs.filter((d) => d.status === "unknown");
  if (docs.length) {
    if (blockedDocs.length) rules.push(mk("S10", "Required documents", "soft", "warn", `Needs third-party sign-off: ${list(blockedDocs.map((d) => d.name))}.`));
    else rules.push(mk("S10", "Required documents", "soft", "pass", `${docs.length - unknownDocs.length}/${docs.length} required documents map to items BURN already has or can produce${unknownDocs.length ? `; ${unknownDocs.length} need a manual check` : ""}.`));
  }

  const blocking = rules.filter((r) => r.severity === "hard" && r.status === "fail");
  const hardUnclear = rules.filter((r) => r.severity === "hard" && r.status === "unclear");
  const warnings = rules.filter((r) => r.status === "warn");
  const softUnclear = rules.filter((r) => r.severity === "soft" && r.status === "unclear");
  const open_questions = [...hardUnclear, ...softUnclear];
  const passed = rules.filter((r) => r.status === "pass");

  const lowCoverage = f.source_coverage === "landing_page_only" || f.extraction_confidence < 0.5;
  let verdict: Verdict;
  if (blocking.length) verdict = "not_fit";
  else if (hardUnclear.length || lowCoverage) verdict = "needs_review";
  else verdict = "fit";

  const score =
    verdict === "not_fit"
      ? Math.max(0, 30 - 10 * (blocking.length - 1))
      : Math.max(10, Math.min(100, 100 - 8 * warnings.length - 15 * hardUnclear.length - (lowCoverage ? 25 : 0)));

  const manual_review = f.key_exclusions.filter(Boolean);

  // The one-line result is written as a plain sentence after the verdict label
  // ("Not a fit — the blocking issue is the deadline: …").
  const GATED_HINT = "Some opportunities need an account or login before the full call can be viewed, or the link may lead to a summary page.";
  let summary: string;
  if (verdict === "not_fit") {
    summary =
      blocking.length === 1
        ? `the blocking issue is the ${topicOf(blocking[0])}: ${noStop(lowerFirst(blocking[0].detail))}.`
        : `there are ${blocking.length} blocking issues. ` +
          blocking.map((r, i) => `(${i + 1}) the ${topicOf(r)}: ${noStop(lowerFirst(r.detail))}`).join("; ") + ".";
  } else if (verdict === "needs_review") {
    if (lowCoverage) {
      summary = `we couldn't read enough of the call to be sure. ${meta.link ? noStop(meta.link) + "." : GATED_HINT} Please open the call link, check the requirements (or the RFP) yourself, and re-check if you find a better link.`;
    } else {
      const items = hardUnclear.map((r) => topicOf(r));
      summary = `no blockers found, but ${items.length > 1 ? "these points" : "this point"} couldn't be confirmed from the call: ${list(items)}. Please check ${items.length > 1 ? "them" : "it"} in the RFP or on the call page.`;
    }
  } else if (warnings.length) {
    summary = `meets the requirements we could check, with ${warnings.length} point${warnings.length > 1 ? "s" : ""} to watch: ${list(warnings.map((r) => r.label.toLowerCase()))}.`;
  } else {
    summary = "meets all the requirements we could check, with nothing to watch.";
  }

  const report: EligibilityReport = {
    verdict, score, summary, blocking, warnings, open_questions, passed, manual_review, docs,
    notes_text: "", link_note: meta.link ?? null, facts: f, sources: meta.sources, model: meta.model, checked_at: now.toISOString(),
  };
  report.notes_text = buildNotes(report);
  return report;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function buildNotes(r: EligibilityReport): string {
  const head = r.verdict === "fit" ? "FIT" : r.verdict === "not_fit" ? "NOT A FIT" : "NEEDS FURTHER REVIEW";
  // The 0–100 score is stored on the grant but deliberately kept out of this text.
  const lines = [`${head} — ${r.summary}`];
  if (r.blocking.length)
    lines.push("WHY NOT: " + r.blocking.map((x) => `${x.label}: ${x.detail}${x.evidence ? ` [“${clip(x.evidence, 140)}”]` : ""}`).join(" | "));
  if (r.open_questions.length) lines.push("VERIFY: " + r.open_questions.map((x) => `${x.label}: ${x.detail}`).join(" | "));
  if (r.warnings.length) lines.push("WATCH-OUTS: " + r.warnings.map((x) => `${x.label}: ${x.detail}`).join(" | "));
  if (r.manual_review.length) lines.push("READ MANUALLY: " + r.manual_review.slice(0, 5).join("; "));
  if (r.link_note) lines.push("LINK: " + r.link_note);
  return lines.join("\n");
}
