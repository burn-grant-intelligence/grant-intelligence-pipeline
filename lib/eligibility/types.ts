// Shared types for the eligibility checker.
//
// Two-stage design:
//   1. Gemini EXTRACTS facts about the call (CallFacts) — it never decides fit.
//   2. rules.ts compares those facts to BURN_PROFILE and produces the verdict.

export type Tri = "yes" | "no" | "unclear"; // "unclear" = the documents don't say
export type Verdict = "fit" | "not_fit" | "needs_review";
export type RuleStatus = "pass" | "fail" | "warn" | "unclear" | "na";
export type Severity = "hard" | "soft";
// Deliberately identical to ApplicantType in lib/types.ts, so
// facts.applicant.structure can be stored straight into grants.applicant_type.
export type ApplicantStructure = "single" | "consortium" | "either" | "unclear";

export const TECHNOLOGIES = [
  "improved_biomass",
  "institutional",
  "electric",
  "lpg",
  "biogas",
  "ethanol",
  "solar_cooking",
  "all_clean_cooking",
  "other",
] as const;
export type Technology = (typeof TECHNOLOGIES)[number];

export const ORG_TYPES = [
  "for_profit_company",
  "ngo_nonprofit",
  "academic_research",
  "government",
  "utility",
  "financial_institution",
  "cooperative_or_association",
  "individual",
  "any",
] as const;

export interface CallFacts {
  call_title: string | null;
  funder: string | null;
  rfp_url: string | null;
  source_coverage: "full_rfp" | "partial" | "landing_page_only";
  extraction_confidence: number; // 0..1

  deadline: {
    date: string | null; // ISO yyyy-mm-dd, next application deadline
    is_rolling: boolean;
    status: "open" | "closed" | "unclear";
    evidence: string | null;
  };

  geography: {
    scope: "specific_countries" | "regional" | "global" | "unclear";
    countries: string[];
    regions: string[];
    excluded_countries: string[];
    evidence: string | null;
  };

  sector: {
    focus_areas: string[];
    covers_clean_cooking: Tri;
    eligible_technologies: Technology[];
    excluded_technologies: Technology[];
    evidence: string | null;
  };

  applicant: {
    eligible_org_types: string[]; // values from ORG_TYPES
    structure: ApplicantStructure;
    consortium_requirements: string | null;
    lead_must_be_local: Tri;
    local_registration_required: Tri;
    local_ownership_required: Tri;
    women_or_youth_led_required: Tri;
    startup_or_early_stage_only: Tri;
    max_employees: number | null;
    max_annual_turnover_usd: number | null;
    min_annual_turnover_usd: number | null;
    max_company_age_years: number | null;
    min_company_age_years: number | null;
    min_units_sold: number | null;
    evidence: string | null;
  };

  funding: {
    instruments: string[]; // grant | results_based_financing | technical_assistance | concessional_loan | equity | guarantee | carbon_prefinance | prize | other
    min_award_usd: number | null;
    max_award_usd: number | null;
    total_pool_usd: number | null;
    cofinancing_required_pct: number | null; // 0..100
    prefinancing_by_applicant_required: Tri;
    evidence: string | null;
  };

  product_requirements: {
    min_iso_tier: number | null;
    certifications_required: string[];
    evidence: string | null;
  };

  stacking: { prohibits_double_subsidy: Tri; evidence: string | null };
  carbon: { restricts_carbon_credits: Tri; evidence: string | null };

  documents_required: { name: string; url: string | null; mandatory: boolean }[];
  submission_languages: string[];
  key_exclusions: string[];
}

export interface RuleResult {
  id: string;
  label: string;
  severity: Severity;
  status: RuleStatus;
  detail: string;
  evidence: string | null;
}

export interface DocReadiness {
  name: string;
  mandatory: boolean;
  status: "have" | "can_produce" | "needs_partner" | "unknown";
  note: string;
}

export interface EligibilityReport {
  verdict: Verdict;
  score: number; // 0..100 alignment score (informational — not shown in the UI)
  summary: string;
  blocking: RuleResult[];
  warnings: RuleResult[];
  open_questions: RuleResult[];
  passed: RuleResult[];
  manual_review: string[]; // free-text exclusions the rules can't evaluate
  docs: DocReadiness[];
  notes_text: string; // compact text saved to tracker_items.fit_notes
  link_note?: string | null; // set when the call link was gated, wrong, thin or replaced (see linkCheck.ts)
  facts: CallFacts;
  sources: string[];
  model: string;
  checked_at: string;
}
