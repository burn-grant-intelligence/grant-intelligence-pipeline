-- Grant Intelligence — core schema
-- (Already run manually in the Supabase SQL editor during setup — kept here
-- for version history / reference, and so a future teammate can recreate it.)

create extension if not exists "pgcrypto";

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null,
  type text not null check (type in ('rss', 'html', 'api')),
  focus_tags text[] default '{}',
  active boolean not null default true,
  last_scanned_at timestamptz,
  last_success_at timestamptz,
  consecutive_errors int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists grants (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources(id) on delete set null,
  title text not null,
  funder text,
  amount numeric,
  currency text,
  deadline date,
  geography text,
  focus_areas text[] default '{}',
  eligibility text,
  description text,
  application_url text,
  relevance_score numeric,
  -- Free-text "where this came from" note, only ever set on manually added
  -- grants via the Application Tracker's "+ Add grant" form (2026-09-18).
  source_note text,
  -- Eligibility Tracker fields (2026-09-23) — who's actually eligible to
  -- apply, populated by the "Check eligibility" button's Gemini call
  -- (app/api/check-eligibility/route.ts). Distinct from the thematic
  -- geography/focus_areas above: those describe the opportunity's subject,
  -- these describe who may apply to it.
  eligible_countries text[],
  applicant_type text check (applicant_type in ('single', 'consortium', 'either', 'unclear')),
  supporting_docs jsonb default '[]'::jsonb,
  rfp_url text,
  eligibility_checked_at timestamptz,
  content_hash text not null unique,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists grants_deadline_idx on grants(deadline);
create index if not exists grants_relevance_idx on grants(relevance_score desc);

create table if not exists tracker_items (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid references grants(id) on delete cascade,
  status text not null default 'tracking'
    -- "implementation" added 2026-09-18: a stage for grants that have
    -- already been won and are now being delivered/implemented in-house.
    check (status in ('tracking', 'researching', 'drafting', 'submitted', 'won', 'implementation', 'lost')),
  owner text,
  notes text,
  -- BURN's own Fit/Not Fit call for this tracked pursuit (2026-09-23) — see
  -- the Eligibility Tracker tab. Kept separate from the eligibility_*
  -- columns on `grants` above: those are facts about the opportunity,
  -- this is a judgment call about whether BURN should pursue it.
  fit_status text not null default 'unreviewed'
    check (fit_status in ('unreviewed', 'fit', 'not_fit')),
  fit_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tracker_items_status_idx on tracker_items(status);
create index if not exists tracker_items_fit_status_idx on tracker_items(fit_status);
