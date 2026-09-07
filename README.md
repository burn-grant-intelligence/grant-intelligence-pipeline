# Grant Intelligence

BURN Manufacturing's grant discovery and application tracking tool. Built on a
fully free-tier stack: Vercel (hosting), Supabase (database), Groq (free LLM
extraction), and GitHub Actions (scheduled scraping).

## Structure

- `scripts/scan.mjs` — the scraper: reads active sources from Supabase, extracts
  structured grant data via Groq, upserts into Supabase with dedup.
- `scripts/social_discover.py` — checks funder LinkedIn company pages (the
  `social_sources` table) for posts that look like open tenders, via Bright Data,
  extracts structured data via Groq, and queues the linked pages for the main scan.
- `supabase/schema.sql` — the database schema (already applied via the SQL Editor).
- `supabase/policies.sql` — Row Level Security policies (run once, after schema.sql).
- `.github/workflows/daily-scan.yml` — runs the scraper on a schedule via GitHub Actions.
- `.github/workflows/social-discover.yml` — runs social discovery twice a week via
  GitHub Actions.

## Environment variables

See `.env.example`. Two separate sets:
- `NEXT_PUBLIC_*` ones go into Vercel's project Environment Variables (used by the browser).
- The rest (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`, and
  `BRIGHTDATA_API_KEY` for social discovery) go into this repo's GitHub Actions
  secrets (Settings → Secrets and variables → Actions) — used only by the scrapers,
  never shipped to the browser.

## Adding a source to scan

Sources live in the `sources` table, not in code. Add a row via Supabase's Table
Editor: `name`, `url`, `type` (`rss` or `html`), `focus_tags`, `active: true`.
The next scheduled run (or a manual "Run workflow" from the Actions tab) will pick it up.

## Scan frequency

Currently every 2 hours, Monday-Friday (`.github/workflows/daily-scan.yml`) — comfortably
within GitHub's 2,000 free Actions minutes/month for a private repo at this job's
runtime (~3-6 min/run × ~240 runs/month ≈ 1,200-1,400 minutes). Adjust the cron
expression there if you want a different frequency; going hourly or more would be
worth switching this repo to public first, since public repos get unlimited free minutes.
