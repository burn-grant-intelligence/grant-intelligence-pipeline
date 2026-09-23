export const FOCUS_AREAS = [
  "Clean energy",
  "Clean cooking",
  "Climate change",
  "GHG reduction",
  "Energy transition",
  "Deforestation",
  "Manufacturing",
  "Women / gender",
  "Tech & innovation",
  "Engineering",
  "AI / data",
] as const;

export const TRACKER_STATUSES = [
  "tracking",
  "researching",
  "drafting",
  "submitted",
  "won",
  "implementation",
  "lost",
] as const;

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

export const APPLICANT_TYPES = ["single", "consortium", "either", "unclear"] as const;
export type ApplicantType = (typeof APPLICANT_TYPES)[number];

export const FIT_STATUSES = ["unreviewed", "fit", "not_fit"] as const;
export type FitStatus = (typeof FIT_STATUSES)[number];

// One named application material found on a donor's page (e.g. "Application
// Form", "Budget Template", "Terms of Reference") — url is null when the
// page names the document but doesn't link it directly.
export interface SupportingDoc {
  name: string;
  url: string | null;
}

export interface Grant {
  id: string;
  source_id: string | null;
  title: string;
  funder: string | null;
  amount: number | null;
  currency: string | null;
  deadline: string | null; // ISO date
  geography: string | null;
  focus_areas: string[];
  eligibility: string | null;
  description: string | null;
  fit_analysis: string | null;
  application_url: string | null;
  relevance_score: number | null;
  // Free-text "where this came from" note (e.g. "referred by Jane at XYZ
  // Foundation", "found via donor's LinkedIn"). Only ever set on manually
  // added grants, via the Application Tracker's "+ Add grant" form — distinct
  // from source_id/source_type, which track the scraper pipeline's own
  // source records. Optional because it's a newer column
  // (supabase/tracker_migration_2026-09-18.sql) that may not exist on every
  // row, and older Grant rows never had it set.
  source_note?: string | null;
  // Eligibility Tracker fields (supabase/eligibility_migration_2026-09-23.sql)
  // — populated by the "Check eligibility" button in components/
  // EligibilityTracker.tsx (app/api/check-eligibility/route.ts), which asks
  // Gemini to read the donor's own page (same url_context + google_search
  // pattern scripts/gemini_discover.py uses) and extract who's actually
  // eligible to apply, distinct from the grant's own thematic `geography`/
  // `focus_areas` tags above. All optional/nullable because they're only
  // populated once someone runs the check — most grants won't have them.
  eligible_countries?: string[] | null;
  applicant_type?: ApplicantType | null;
  supporting_docs?: SupportingDoc[] | null;
  rfp_url?: string | null;
  eligibility_checked_at?: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

// Industry events (conferences, summits, webinars, forums) discovered by
// scripts/gemini_discover.py — deliberately a separate type/table from
// Grant, and shown only in the app's Events tab, not the Grant Scanner.
// Named EventItem rather than Event to avoid shadowing the DOM's built-in
// Event type.
export interface EventItem {
  id: string;
  title: string;
  organizer: string | null;
  event_type: string | null;
  format: string | null;
  start_date: string | null; // ISO date
  end_date: string | null; // ISO date
  location: string | null;
  geography: string | null;
  focus_areas: string[];
  description: string | null;
  fit_analysis: string | null;
  url: string | null;
  source_type: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface TrackerItem {
  id: string;
  grant_id: string;
  status: TrackerStatus;
  owner: string | null;
  notes: string | null;
  tor_text: string | null;
  // The team's own Fit/Not Fit call for this tracked pursuit — deliberately
  // separate from the `Grant.eligible_countries`/`applicant_type` etc. above:
  // those are facts about the opportunity itself (same for anyone looking at
  // it), this is BURN's judgment call about pursuing it. Defaults to
  // "unreviewed" until someone sets it in the Eligibility Tracker tab.
  fit_status?: FitStatus;
  fit_notes?: string | null;
  created_at: string;
  updated_at: string;
  grant: Grant | null;
}
