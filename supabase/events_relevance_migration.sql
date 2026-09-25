-- Brings the `events` table up to what scripts/gemini_discover.py,
-- scripts/reclassify_events.py and components/EventsScanner.tsx now expect.
-- Run in Supabase's SQL Editor after events_schema.sql.
--
-- Safe to re-run: every statement is "if not exists", so on a database that
-- already has these columns (the live project did as of 2026-09-25) it
-- changes nothing. It exists so a fresh setup from this repo matches
-- production.

-- Written by the extraction step; shown as "Fit for BURN" in the Events tab.
alter table events add column if not exists fit_analysis text;

-- Normalised title used for de-duplication: gemini_discover.py upserts with
-- on_conflict=title_key, so it needs a unique index. Same normalisation as
-- grants.title_key (see titleKeyOf in components/ApplicationTracker.tsx).
alter table events add column if not exists title_key text
  generated always as (regexp_replace(lower(title), '[^a-z0-9]+', '', 'g')) stored;
create unique index if not exists events_title_key_key on events(title_key);

-- Relevance scoring against config/taxonomy.yaml — written by classify_event()
-- when an event is saved, and by reclassify_events.py. Drives the relevance
-- badge and filter in the Events tab.
alter table events add column if not exists core_topics text[] default '{}';
alter table events add column if not exists primary_topics text[] default '{}';
alter table events add column if not exists secondary_topics text[] default '{}';
alter table events add column if not exists relevance_level text
  check (relevance_level in ('high', 'medium', 'low', 'not_relevant'));
alter table events add column if not exists relevance_rationale text;
