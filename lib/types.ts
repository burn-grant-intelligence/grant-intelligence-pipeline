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
  application_url: string | null;
  relevance_score: number | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface TrackerItem {
  id: string;
  grant_id: string;
  status: TrackerStatus;
  owner: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  grant: Grant | null;
}
