-- Events table — industry events (conferences, summits, webinars, forums)
-- discovered by scripts/gemini_discover.py, kept SEPARATE from `grants` on
-- purpose: these are calendar/networking items, not funding opportunities to
-- apply to, and the Events tab is a lightweight side feature, not something
-- that should dilute the main Grant Scanner's opportunity list.
--
-- Run this in Supabase's SQL Editor (after schema.sql / policies.sql already
-- exist), then run the policies below it in the same editor.

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  organizer text,
  event_type text,        -- e.g. "conference", "summit", "webinar", "workshop", "forum" — free text, not enforced
  format text,            -- "virtual" | "in-person" | "hybrid" | null if unstated
  start_date date,
  end_date date,
  location text,          -- city/venue as stated, if any
  geography text,         -- broad region, same convention as grants.geography
  focus_areas text[] default '{}',
  description text,
  url text,
  source_type text not null default 'gemini',
  content_hash text not null unique,
  discarded boolean not null default false,
  discarded_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists events_start_date_idx on events(start_date);

-- Row Level Security — same permissive pattern as the rest of this app (see
-- the note at the top of policies.sql: no login yet, so anyone with the
-- site's URL can read/write; acceptable for now since the link isn't shared
-- publicly). Only the Gemini script (service-role key) writes new events;
-- the browser (anon key) reads them and can discard one via the same X
-- button pattern used on the Grant Scanner.

alter table events enable row level security;

create policy "Public read access to events" on events
  for select using (true);

-- Needed for the Events tab's discard (X) button to set discarded = true
-- from the browser, same as grants.
create policy "Public update access to events" on events
  for update using (true);
