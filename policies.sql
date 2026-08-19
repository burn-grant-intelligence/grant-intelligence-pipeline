-- Row Level Security policies — run this AFTER schema.sql, in the same SQL Editor.
--
-- Context: the frontend (Next.js on Vercel) talks to Supabase using the
-- "anon" / "publishable" key, which is safe to expose in the browser ONLY
-- because these policies restrict exactly what that key can do. The scraper
-- (GitHub Actions) uses the separate service-role/secret key, which bypasses
-- RLS entirely and is never used in browser code.
--
-- KNOWN LIMITATION: there is no login/authentication yet, so anyone who has
-- the website's URL can read grants and add/update tracker items. That's an
-- acceptable starting point for an internal tool whose link isn't shared
-- publicly, but it's worth adding a simple access gate later if the link
-- could end up somewhere public.

alter table sources enable row level security;
alter table grants enable row level security;
alter table tracker_items enable row level security;

-- Anyone with the anon key can read sources and grants (needed for the Grant
-- Scanner page), but cannot write to them directly — only the scraper
-- (service-role key) writes new grants and sources.
create policy "Public read access to sources" on sources
  for select using (true);

create policy "Public read access to grants" on grants
  for select using (true);

-- The "Add grant" manual-entry feature on the tracker page needs to insert a
-- row into grants directly from the browser, so we allow anon insert here too.
create policy "Public insert access to grants" on grants
  for insert with check (true);

-- Tracker items: read, create ("Track this grant" / "Add grant"), and update
-- (changing status) all happen from the browser.
create policy "Public read access to tracker_items" on tracker_items
  for select using (true);

create policy "Public insert access to tracker_items" on tracker_items
  for insert with check (true);

create policy "Public update access to tracker_items" on tracker_items
  for update using (true);
