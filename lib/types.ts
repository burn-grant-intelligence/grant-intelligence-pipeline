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
  "lost",
] as const;

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

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
  created_at: string;
  updated_at: string;
  grant: Grant | null;
}
