import type { EligibilityReport, Verdict } from "./eligibility/types";

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

// The eligibility engine's verdict has one extra value, "needs_review", that
// is NOT a FitStatus: it leaves fit_status as "unreviewed" (see
// app/api/check-eligibility/route.ts).
export type EligibilityVerdict = Verdict;
export type FitSource = "auto" | "manual";

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
  // Eligibility engine (supabase/eligibility_engine_migration_2026-09-29.sql):
  // the rules engine's verdict against BURN's profile (lib/eligibility/).
  // The score is stored but not shown in the UI.
  eligibility_verdict?: EligibilityVerdict | null;
  eligibility_score?: number | null;
  eligibility_report?: EligibilityReport | null;
  // Management Dashboard fields (supabase/management_dashboard_migration_2026-09-28.sql)
  // — filled in from the Eligibility Check / Drafting card's detail slide,
  // mirroring the fields on the team's own external tracking sheet
  // (Organization/Amount/etc. above already cover the rest of that sheet).
  // Optional/nullable: most grants won't have them until someone fills them in.
  project_start_date?: string | null; // ISO date
  project_end_date?: string | null; // ISO date
  type_of_funding?: string | null;
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
  // Written by scripts/reclassify_events.py against config/taxonomy.yaml;
  // null until an event has been scored.
  relevance_level: RelevanceLevel | null;
  relevance_rationale: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export type RelevanceLevel = "high" | "medium" | "low" | "not_relevant";

export interface TrackerItem {
  id: string;
  grant_id: string;
  status: TrackerStatus;
  owner: string | null;
  // "Remove & discard" (supabase/team_collaboration_migration_2026-10-06.sql):
  // a removed opportunity is hidden in every tab and can be restored.
  removed_at?: string | null;
  removed_by?: string | null;
  removed_reason?: string | null;
  notes: string | null;
  tor_text: string | null;
  // The team's own Fit/Not Fit call for this tracked pursuit — deliberately
  // separate from the `Grant.eligible_countries`/`applicant_type` etc. above:
  // those are facts about the opportunity itself (same for anyone looking at
  // it), this is BURN's judgment call about pursuing it. Defaults to
  // "unreviewed" until someone sets it in the Eligibility Tracker tab.
  fit_status?: FitStatus;
  fit_notes?: string | null;
  // Manual "draft anyway" escape hatch (supabase/draft_override_migration_2026-09-25.sql).
  // Draft Application only shows items with fit_status === "fit" by default
  // — this lets someone force an unreviewed or not-fit item in there anyway
  // for a specific case, without changing the actual fit_status/fit_notes
  // record in the Eligibility Tracker. Defaults to false; optional because
  // it's a newer column that may not exist on every row yet.
  draft_override?: boolean;
  // Who made the fit_status call (supabase/eligibility_engine_migration_2026-09-29.sql):
  // "auto" = the eligibility check (a re-check may update it), "manual" = a
  // person (a re-check never overwrites it), null = undecided.
  fit_source?: FitSource | null;
  // Opportunity Pipeline "Breakdown" (supabase/opportunity_pipeline_migration_2026-10-01.sql).
  // The Lead is `owner` above and the Type of funding is Grant.type_of_funding.
  // Where a field is empty, the screens fall back to what the grant record
  // already has (see effectiveFields in lib/pipeline.ts).
  pipeline_category?: PipelineCategory | null;
  pipeline_status?: PipelineStatusCode | null;
  program_name?: string | null;
  pipeline_funder?: string | null;
  pipeline_description?: string | null;
  target_countries?: string[] | null;
  product_types?: string[] | null;
  ticket_size?: string | null;
  requested_amount_usd?: number | null;
  pipeline_deadline?: string | null; // ISO date
  pipeline_link?: string | null;
  link_check_note?: string | null;
  link_checked_at?: string | null;
  submission_date?: string | null; // ISO date
  // Draft Application stages (supabase/draft_stages_migration_2026-10-02.sql).
  // null = not started, treated as "concept".
  draft_stage?: DraftStage | null;
  draft_stage_changed_at?: string | null;
  draft_brief?: DraftBrief | null;
  // Link to this opportunity's task or list in ClickUp (pasted by the team).
  clickup_url?: string | null;
  created_at: string;
  updated_at: string;
  grant: Grant | null;
}

// ── Draft Application stages (lib/drafting.ts) ──
export const DRAFT_STAGES = ["concept", "first_draft"] as const;
export type DraftStage = (typeof DRAFT_STAGES)[number];

// One question in the application form, with its limit.
export interface DraftQuestion {
  id: string;
  label: string;
  limit: number | null;
  unit: "words" | "characters";
  criterion?: string | null; // which scoring criterion it mainly serves
}

// What the donor wants, typed in or decoded from the call by Gemini.
export interface DraftBrief {
  objectives: string[];
  criteria: { name: string; weight: string | null }[];
  keywords: string[];
  must_haves: string[]; // mandatory sections, attachments, formats, eligibility proofs
  questions: DraftQuestion[];
  decoded_at?: string | null;
  source?: string | null; // where Gemini read it from
}

export type ReviewStatus = "pass" | "warn" | "fail";

// The Gemini review of one stage's draft (draft_stage_work.review).
export interface StageReview {
  readiness: number; // 0-100: how ready this stage is to lift to the next
  summary: string;
  checks: { item: string; status: ReviewStatus; comment: string }[];
  suggestions: { where: string; issue: string; suggestion: string }[];
  criteria_coverage: { criterion: string; status: ReviewStatus; comment: string }[];
  missing: string[];
  next_steps: string[];
  model?: string;
}

export interface DraftStageWork {
  id: string;
  tracker_item_id: string;
  stage: DraftStage;
  draft_text: string | null;
  answers: Record<string, string>;
  checklist: string[];
  stage_notes: string | null;
  review: StageReview | null;
  reviewed_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftStageMove {
  id: string;
  tracker_item_id: string;
  from_stage: DraftStage | null;
  to_stage: DraftStage;
  moved_by: string | null;
  open_items: string[];
  moved_at: string;
}

// Direction from the management team before the concept is written
// (draft_guidance table): what they want, who said it and when.
export interface DraftGuidance {
  id: string;
  tracker_item_id: string;
  guidance_date: string; // ISO date
  source: string | null; // e.g. "Management meeting", "Email from the CEO", "WhatsApp"
  given_by: string | null;
  text: string;
  author: string | null; // who recorded it
  created_at: string;
}

export interface DraftLearning {
  id: string;
  tracker_item_id: string | null;
  stage: DraftStage | null;
  funder: string | null;
  lesson: string;
  tags: string[];
  author: string | null;
  created_at: string;
}

export type PipelineCategory = "solicited" | "unsolicited" | "partnerships" | "award";
export type PipelineStatusCode = "1a" | "1b" | "2a" | "2b" | "2c" | "3a" | "3b" | "3c" | "4a" | "4b" | "4c";

// One meeting's notes on an opportunity (opportunity_notes table).
export interface OpportunityNote {
  id: string;
  tracker_item_id: string;
  meeting_date: string; // ISO date
  notes: string;
  author: string | null;
  stage?: DraftStage | null; // set when written in the Draft Application workspace
  created_at: string;
  updated_at: string;
}

// An action point (action_items table): a task, or a meeting with someone,
// owned by one person, optionally linked to the meeting notes it came from.
export type ActionKind = "task" | "meeting" | "review" | "input";

// A reply on an action point (action_replies table).
export interface ActionReply {
  id: string;
  action_id: string;
  tracker_item_id: string;
  author: string | null;
  body: string;
  created_at: string;
}

// One notification for one person (team_notifications table).
export type NotificationKind = "mention" | "everyone" | "reply" | "removed";
export interface TeamNotification {
  id: string;
  recipient: string;
  kind: NotificationKind;
  tracker_item_id: string | null;
  note_id: string | null;
  action_id: string | null;
  reply_id: string | null;
  from_person: string | null;
  excerpt: string | null;
  seen_at: string | null;
  created_at: string;
}

export interface ActionItem {
  id: string;
  tracker_item_id: string;
  note_id: string | null;
  // review / input: "please review my proposal", "your input needed"
  // (supabase/team_collaboration_migration_2026-10-06.sql)
  kind: ActionKind;
  description: string;
  meeting_with: string | null;
  assignee: string | null;
  due_date: string | null; // ISO date
  done: boolean;
  done_at: string | null;
  created_by: string | null;
  stage?: DraftStage | null; // set when written in the Draft Application workspace
  created_at: string;
}

// A row in the Management Dashboard's "Key priorities" sub-tab
// (supabase/management_dashboard_migration_2026-09-28.sql) — a lightweight,
// team-editable priorities list, deliberately separate from tracker_items
// since it's a manually curated shortlist/calendar rather than a mirror of
// every tracked grant.
export interface KeyPriority {
  id: string;
  opportunity: string;
  deadline: string | null;
  lead: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
