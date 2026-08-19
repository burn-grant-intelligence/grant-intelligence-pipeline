# Grant Intelligence

BURN Manufacturing's grant discovery and application tracking tool. Built on a
fully free-tier stack: Vercel (hosting), Supabase (database), Groq (free LLM
extraction), and GitHub Actions (scheduled scraping).

## Structure

- `app/`, `components/` — the Next.js frontend (Grant Scanner + Application Tracker).
- `scripts/scan.mjs` — the scraper: reads active sources from Supabase, extracts
  structured grant data via Groq, upserts into Supabase with dedup.
- `supabase/schema.sql` — the database schema (already applied via the SQL Editor).
- `supabase/policies.sql` — Row Level Security policies (run once, after schema.sql).
- `.github/workflows/daily-scan.yml` — runs the scraper on a schedule via GitHub Actions.

## Environment variables

See `.env.example`. Two separate sets:
- `NEXT_PUBLIC_*` ones go into Vercel's project Environment Variables (used by the browser).
- The rest (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`) go into this
  repo's GitHub Actions secrets (Settings → Secrets and variables → Actions) — used
  only by the scraper, never shipped to the browser.

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
