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
    check (status in ('tracking', 'researching', 'drafting', 'submitted', 'won', 'lost')),
  owner text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tracker_items_status_idx on tracker_items(status);
