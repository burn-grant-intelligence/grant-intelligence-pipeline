-- Eligibility engine (2026-09-29)
-- Run once in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS everywhere).
--
-- grants: the rules engine's verdict for the OPPORTUNITY (facts vs BURN's
-- profile). Written only by app/api/check-eligibility/route.ts (service role).
--   eligibility_verdict  fit | not_fit | needs_review
--   eligibility_score    0-100 alignment score — stored for sorting/analysis,
--                        deliberately not shown in the UI
--   eligibility_report   full report JSON (rules that passed/failed, evidence
--                        quotes, document readiness, extracted facts)
--
-- tracker_items: who decided the Fit / Not fit call.
--   fit_source = 'auto'   -> set by the eligibility check; a re-check may update it
--   fit_source = 'manual' -> a person chose Fit / Not fit; a re-check never overwrites it
--   fit_source = NULL     -> nobody has decided (fit_status is 'unreviewed')

alter table grants
  add column if not exists eligibility_verdict text
    check (eligibility_verdict in ('fit', 'not_fit', 'needs_review')),
  add column if not exists eligibility_score integer,
  add column if not exists eligibility_report jsonb;

alter table tracker_items
  add column if not exists fit_source text
    check (fit_source in ('auto', 'manual'));

-- No new tables, so no new GRANT/RLS statements are needed: the existing table
-- grants and policies on `grants` and `tracker_items` already cover new columns.
