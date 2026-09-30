// BURN applicant profile — the facts the eligibility rules compare a call against.
//
// THIS REPO IS PUBLIC, so this file holds only PUBLIC-SAFE DEFAULTS: company
// facts BURN already publishes (founding year, headcount, units sold, countries
// and product lines) and neutral thresholds. Everything commercially sensitive —
// ownership split, contract values, revenue, financing capacity, the list of
// live applications, entity names, and the wording the rules quote about them —
// lives in the private Supabase table `burn_profile` (one row, readable only by
// the server: supabase/burn_profile_migration_2026-09-29.sql). At check time
// lib/eligibility/profileStore.ts merges that row over these defaults, so
// editing the private profile needs no code change and no GitHub commit.
//
// If the private row is missing the check still runs on these defaults, but the
// route marks the result "needs review" — with no commitments/revenue loaded
// some rules cannot judge, and must not silently pass.
//
// Anything left null: revenue -> turnover rules ask for review; match % and
// pre-financing capacity -> no flag (BURN co-finances and is open to
// pre-financing); once filled in (private profile) the rules compare against it.

import type { Technology } from "./types";

export interface CountryPresence {
  name: string; // canonical name, must match normCountry() output in rules.ts
  presence: "manufacturing" | "assembly" | "local_entity" | "market";
  entity?: string; // private profile only
  localEntity?: boolean; // a locally registered BURN company exists here (even if the main presence is manufacturing/assembly)
  sinceYear?: number;
}

export interface ActiveCommitment {
  programme: string;
  countries: string[];
  technologies: Technology[];
  status: "active" | "applied_confirm_status" | "past";
  note?: string;
}

export const BURN_PROFILE = {
  name: "BURN Manufacturing",
  orgType: "for_profit_company" as const,
  groupFoundedYear: 2011,
  headcount: 3500, // group-wide, as BURN publishes it
  foreignControlledSubsidiaries: true, // local subsidiaries are majority-owned by the group
  unitsSoldToDate: 7_200_000,

  // Private profile only — null until set there. null revenue -> a call with a
  // turnover cap goes to "needs review". null match/pre-financing -> not flagged.
  annualRevenueUsd: null as number | null,
  maxCofinancingPct: null as number | null,
  prefinancingCapacityUsd: null as number | null,
  carbonFinanceRaisedUsd: null as number | null,

  // Tunable thresholds
  minWorthwhileAwardUsd: 100_000, // below this, effort/return is poor -> warn
  maxRealisticAskUsd: 25_000_000, // above this the call is out of BURN's demonstrated range
  minDaysToApply: 10, // fewer days than this -> warn

  // Wording the rules quote in their messages. Empty here on purpose; the
  // private profile can fill them in (they are stored on grants/tracker rows).
  notes: {
    ownership: "",
    prefinancing: "",
    consortium: "",
    carbon: "",
  },

  // Operating countries and how BURN is present there. The private profile
  // adds local entity names and marks where a local company exists.
  countries: [
    { name: "Kenya", presence: "manufacturing", sinceYear: 2011 },
    { name: "Nigeria", presence: "manufacturing" },
    { name: "Ghana", presence: "assembly" },
    { name: "Tanzania", presence: "assembly" },
    { name: "Malawi", presence: "assembly" },
    { name: "Mozambique", presence: "local_entity", sinceYear: 2021 },
    { name: "Uganda", presence: "local_entity", sinceYear: 2017 },
    { name: "DRC", presence: "market" },
    { name: "Madagascar", presence: "market" },
    { name: "Ethiopia", presence: "market" },
    { name: "Senegal", presence: "market" },
    { name: "Cote d'Ivoire", presence: "market" },
    { name: "Somalia", presence: "market" },
    { name: "Zambia", presence: "market" },
  ] as CountryPresence[],

  // Countries BURN is actively considering. A call covering ONLY these -> warn, not fail.
  expansionCountries: [] as string[],

  technologies: {
    main: ["improved_biomass", "institutional", "electric"] as Technology[],
    limited: ["lpg"] as Technology[], // gas appliances exist but aren't a core line
  },

  // Best documented ISO 19867 tier per technology. null = not stated.
  bestKnownIsoTier: {
    improved_biomass: 3,
    institutional: null,
    electric: null,
  } as Record<string, number | null>,

  // Programmes BURN has applied for / holds — used for the double-subsidy
  // check. EMPTY here on purpose (it is BURN's live pipeline); set it in the
  // private profile. With none loaded the check cannot judge stacking, which is
  // why the route refuses to call a result "fit" on the defaults alone.
  activeCommitments: [] as ActiveCommitment[],
};

// What BURN has already assembled for past applications. Matched against the
// "documents required" list extracted from each RFP — the FIRST matching entry
// wins, so keep specific patterns above broad ones. Patterns use word
// boundaries (\b) on short acronyms: without them /i matching made "amount"
// hit MoU, "terms"/"determination" hit ERM and "onboarding" hit board. Notes are
// deliberately generic (no bank, programme or country names).
export const DOCUMENT_INVENTORY: {
  match: RegExp;
  status: "have" | "can_produce" | "needs_partner";
  note: string;
}[] = [
  { match: /(certificate of )?(incorporation|registration)|business licen[cs]e|\bNUIT\b|\bNUEL\b|articles of association|memorandum (and|&) articles/i, status: "have", note: "Registration/constitutional documents were attached to earlier applications — confirm the entity for this call." },
  { match: /tax (compliance|clearance|identification|certificate)|\bTIN\b|non-accountability|social security|\bINSS\b/i, status: "have", note: "Tax and social-security certificates were attached before; renew if expired." },
  { match: /audited|financial statements?|balance sheet|income statement|cash ?flow/i, status: "have", note: "Prior-year and projected financials were prepared before; confirm the audited set for the applying entity." },
  { match: /business plan|projections?|monthly distribution|sales forecast/i, status: "have", note: "A 3-year business plan and monthly distribution model exist from earlier applications." },
  { match: /\bCVs?\b|\bresum[eé]s?\b|curricul/i, status: "have", note: "Executive and key-personnel CVs were attached previously." },
  { match: /shareholder|\bUBO\b|beneficial owner|ownership (structure|chart|declaration)/i, status: "have", note: "Ownership structure has been documented for earlier applications." },
  { match: /\bboard\b|governance|org(ani[sz]ation(al)?)? chart/i, status: "have", note: "A board / governance table was used in an earlier application." },
  { match: /polic(y|ies)|\bESG\b|safeguard|anti-?corruption|code of conduct|data protection|\bwaste\b|\bgender\b|\bERM\b|risk management/i, status: "have", note: "An internal policy pack (risk, waste, gender, data protection) was attached before." },
  { match: /test(ing)? (report|result)|ISO ?19867|\bLEAP\b|kitchen performance|\bKPT\b|laborator/i, status: "have", note: "Independent test and field-performance results exist; check the tier requested." },
  { match: /\bsuppliers?\b/i, status: "have", note: "A supplier list was attached to an earlier application." },
  { match: /\bmanuals?\b|marketing|sales contract|terms and conditions|distribution (partnership )?agreement|warranty/i, status: "have", note: "Standard sales contract, terms, manuals and marketing material exist." },
  { match: /bank (statement|confirmation|letter|details|account)/i, status: "can_produce", note: "Request from the bank for the applying entity." },
  { match: /declaration|self-?certif|debar|sanction|conflict of interest|financial capacity|undertaking/i, status: "can_produce", note: "Needs a signature from an authorised signatory." },
  { match: /budget|cost (breakdown|sheet)|pricing/i, status: "can_produce", note: "Build from the results-based-financing unit-economics model." },
  { match: /theory of change|log ?frame|results framework|\bM&E\b|\bMRV\b|monitoring/i, status: "can_produce", note: "Reuse monitoring/MRV language from earlier applications." },
  { match: /letters? of (support|commitment|intent)|\bMoU\b|consortium agreement|partnership agreement|co-?financ/i, status: "needs_partner", note: "Requires third-party sign-off — start early (a signed agreement and budget are typically needed before contract)." },
];
