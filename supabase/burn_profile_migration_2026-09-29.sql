-- BURN private profile (2026-09-29)
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- The GitHub repo is PUBLIC, so BURN's commercially sensitive facts (ownership,
-- contract values, revenue, live applications, entity names) must not live in
-- code. They live in this one-row table instead, which ONLY the server can read:
-- the eligibility check (app/api/check-eligibility/route.ts) loads it with the
-- service-role key and merges it over the public-safe defaults in
-- lib/eligibility/burnProfile.ts.
--
-- This file creates the empty table only — no data. Load the profile itself with
-- the separate private SQL file (never commit that file to GitHub), or edit the
-- `profile` JSON in the Supabase Table Editor. To change a single value:
--   update burn_profile set profile = jsonb_set(profile, '{annualRevenueUsd}', '1234567') where id = 1;

create table if not exists burn_profile (
  id int primary key check (id = 1),           -- exactly one row
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS on with NO policies, and no table privileges for the browser roles: the
-- public anon key (which ships in the site's JavaScript) can neither read nor
-- write this table. This is the opposite of the other tables in this project,
-- which deliberately grant anon access — do NOT copy their grant line here.
alter table burn_profile enable row level security;
revoke all on table burn_profile from anon, authenticated;
grant all on table burn_profile to service_role;
