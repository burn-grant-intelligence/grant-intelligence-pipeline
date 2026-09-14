"""
Clean cooking / clean energy opportunity + event discovery via Gemini.

Uses Gemini's built-in Google Search grounding to find candidate items
matching BURN's profile — both funding opportunities (RFPs, EOIs, calls for
proposals, "Call for Solutions", tenders, results-based financing calls) and
industry events (conferences, summits, forums, webinars) — then a second,
per-candidate call using Gemini's url_context tool to actually read that
candidate's page and extract full structured fields.

Opportunities are upserted into the same `grants` table the other two
scrapers write to, tagged source_type='gemini' so the Grant Scanner shows a
green "Gemini" pill on them (they appear in the main All / focus-area list,
same as LinkedIn ones, just without LinkedIn's top-of-list priority).

Events are upserted into a SEPARATE `events` table (see
supabase/events_schema.sql) and only ever show up in the app's dedicated
Events tab — deliberately kept out of the main opportunities list, since
this is a lighter side feature, not core grant discovery.

NOTE ON DUPLICATION: BURN_PROFILE mirrors the one in scripts/scan.mjs and
scripts/social_discover.py — deliberately duplicated so each script stays
self-contained. Update all three if BURN's profile changes.

NOTE ON VERIFICATION: the google-genai SDK shapes used below (Client,
types.Tool(google_search=...), types.Tool(url_context=...),
GenerateContentConfig) were checked directly against google-genai==2.23.0 at
the time this was written. Gemini's available MODEL names change faster
than the SDK does — if GEMINI_MODEL ever 404s, check
ai.google.dev/gemini-api/docs/models for the current flash-tier name.

Run locally:  GEMINI_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/gemini_discover.py
Runs in CI:   see .github/workflows/gemini-discover.yml
"""

import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests
from google import genai
from google.genai import types
from google.genai import errors as genai_errors

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]

client = genai.Client(api_key=GEMINI_API_KEY)

# If this ever 404s, check ai.google.dev/gemini-api/docs/models for the
# current flash-tier model name and swap it here — everything else stays
# the same.
GEMINI_MODEL = "gemini-2.5-flash"

# --- Cost / noise controls -------------------------------------------------
# One discovery call, plus up to this many per-candidate extraction calls —
# bounds run time and API usage the same way POSTS_PER_COMPANY does for
# social_discover.py.
MAX_CANDIDATES_PER_RUN = 15

GEMINI_MAX_RETRIES = 3
GEMINI_RETRY_BACKOFF_SECONDS = 20  # fallback wait if no retry hint is available
GEMINI_PACING_SECONDS = 2.0        # deliberate pause between extraction calls

TODAY = datetime.now(timezone.utc).date()

BURN_PROFILE = """BURN Manufacturing — company profile for grant-fit assessment:
- Products: manufactures and distributes clean cookstoves across every major fuel type — LPG gas, biomass/wood, electric induction (IoT-enabled), ethanol, charcoal, and institutional-scale stoves — plus cookware.
- Manufacturing & scale: owns factories in Kenya and Nigeria (plus Asia), 450K+ units/month capacity, ships orders from 3,000 to 1M+ units. This is an established, at-scale manufacturer — NOT an early-stage or pre-revenue startup.
- Track record: 7.4M+ stoves sold, 37.5M+ lives impacted, 56.7K+ jobs created since 2013, 81M+ tons of CO2 reduced.
- Geography: operates across 20+ African countries (home delivery in 9, B2B sales in 8, call centers in 10, carbon projects in 10).
- Carbon finance: a vertically integrated carbon project developer, 5M+ carbon credits issued, certified by Gold Standard and MMECD — strong fit for carbon finance, results-based financing, and climate-linked funding.
- Distribution: an established last-mile distribution network across its countries of operation.
- Gender: products and programs center women as primary household cooking-fuel decision-makers and beneficiaries.
- Funding BURN typically seeks: grants, catalytic/concessional funding, results-based financing, R&D funding, and scale-up/working capital. BURN is generally NOT a fit for micro-loans or funding explicitly reserved for small/early-stage/first-time operators.
- Strong-fit program patterns: results-based financing (RBF) programs for clean cooking, calls for proposals / "Call4Solutions" / tenders specifically for cookstove distribution or manufacturing, institutional and school-cooking programs, and higher-tier/modern eCooking scale-up programs.
- Agriculture is generally NOT a fit: BURN is a clean cookstove company, not an agriculture company. Funding primarily for on-farm equipment, agricultural inputs, crop or livestock production, agri-processing, or farm-level energy systems is a poor fit — even if it touches climate or energy — UNLESS it specifically funds clean cookstove manufacturing or distribution."""

DISCOVERY_PROMPT = f"""Today's date is {TODAY.isoformat()}. Use Google Search to find CURRENTLY OPEN / UPCOMING items relevant to the company described below.

{BURN_PROFILE}

Find up to {MAX_CANDIDATES_PER_RUN} items total, across two categories:

1. "opportunity" — a genuine, currently open funding or procurement call: an RFP, EOI, "Call for Solutions", call for proposals, tender, results-based financing call, or similar, that this company could realistically apply to. Topics: clean cooking, cookstoves, clean/renewable energy, energy access, energy transition, carbon credits/carbon markets, climate finance.
2. "event" — a genuine, upcoming (not already past) industry event: a conference, summit, forum, or webinar in the same topic space that this company might want to attend for visibility or networking — NOT a funding call, NOT a news article about a past event.

Respond with ONLY a JSON object (no markdown fences, no prose before or after) of the shape:
{{ "candidates": [ {{ "kind": "opportunity" | "event", "title": string, "url": string, "why_relevant": string }} ] }}

Rules:
- "url" must be the actual source page you found via search — never invent or guess a URL.
- Skip anything whose deadline or event date is clearly before {TODAY.isoformat()}.
- Skip news recaps of funding already awarded, and recaps of events that already happened.
- Do not list the same underlying opportunity or event twice under different URLs.
- It's fine to return fewer than {MAX_CANDIDATES_PER_RUN}, or zero, if that's genuinely all that qualifies.

If nothing qualifies at all, respond with exactly: {{ "candidates": [] }}"""

OPPORTUNITY_EXTRACTION_PROMPT_TEMPLATE = f"""Read the page at this URL using your url_context tool, then extract a structured, OPEN funding or procurement opportunity from it, and assess how well it fits the company described below.

Today's date is {TODAY.isoformat()}. Use this — not any date you might otherwise assume — whenever you need to judge whether a stated deadline has already passed.

{BURN_PROFILE}

URL to read: {{url}}
This page was already flagged as a likely "{{title}}" opportunity — confirm or correct that from the actual page content.

Respond with ONLY a JSON object — no markdown code fences, no explanation before or after — of the shape:
{{{{ "grants": [ {{{{ ... }}}} ] }}}}

Each item must have exactly these fields (use null for anything not stated — never guess or invent values):
{{{{
  "title": string,
  "funder": string | null,
  "amount": number | null,
  "currency": string | null,
  "deadline": string | null,        // ISO date "YYYY-MM-DD" only if a specific date is stated
  "geography": string | null,
  "focus_areas": string[],          // choose from: clean energy, clean cooking, climate change, GHG reduction, energy transition, deforestation, manufacturing, women/gender, tech & innovation, engineering, AI/data
  "eligibility": string | null,
  "description": string | null,     // 1-2 sentence neutral summary of the opportunity itself
  "application_url": string | null, // the outbound link where you apply, if the page states one — otherwise use the URL you were given
  "fit_analysis": string | null     // 2-4 sentences assessing how well THIS opportunity fits the company specifically
}}}}

Rules for "fit_analysis":
- Write it as an analyst briefing the company's grants team, not marketing copy.
- Reference concrete matching points from the profile above where they apply: geography overlap, product/fuel-type match, carbon finance or gender-program fit, or distribution-network relevance.
- If something looks like a MISMATCH, say so plainly — e.g. it targets operators far smaller than the company's scale, the geography excludes its countries, it is an equity investment rather than a grant, or it is a consultancy/advisory assignment rather than funding for the company's own operations.
- If the page gives too little detail to judge fit, set this field to null rather than guessing.

Return {{{{ "grants": [] }}}} — i.e. extract nothing — if the page is:
- Announcing that someone has ALREADY won, received or been awarded funding.
- A recap of an event, conference, webinar or partnership, even if funding is mentioned.
- A job vacancy for a permanent or fixed-term STAFF employee, rather than a competitively tendered consultancy.
- Advertising a paid course, training programme, certification, workshop, webinar or masterclass — not a grant, tender or funding opportunity that provides money or a contract TO the company.
- An opportunity whose stated deadline is before {TODAY.isoformat()} (today).
- Primarily an agriculture, forestry or land-use opportunity, even where climate or energy is mentioned.
- Not actually a funding/procurement opportunity at all (e.g. the page turned out to be unrelated, broken, or paywalled with no visible content).

Otherwise extract exactly one item describing the opportunity."""

EVENT_EXTRACTION_PROMPT_TEMPLATE = f"""Read the page at this URL using your url_context tool, then extract structured details about the industry event it describes.

Today's date is {TODAY.isoformat()}. Use this — not any date you might otherwise assume — whenever you need to judge whether the event has already happened.

URL to read: {{url}}
This page was already flagged as a likely "{{title}}" event — confirm or correct that from the actual page content.

Respond with ONLY a JSON object — no markdown code fences, no explanation before or after — of the shape:
{{{{ "events": [ {{{{ ... }}}} ] }}}}

Each item must have exactly these fields (use null for anything not stated — never guess or invent values):
{{{{
  "title": string,
  "organizer": string | null,
  "event_type": string | null,      // e.g. "conference", "summit", "webinar", "workshop", "forum"
  "format": string | null,          // "virtual", "in-person", or "hybrid" — only if the page actually states this
  "start_date": string | null,      // ISO date "YYYY-MM-DD"
  "end_date": string | null,        // ISO date "YYYY-MM-DD", or null for a single-day event
  "location": string | null,        // city/venue as stated, if any
  "geography": string | null,       // broad region
  "focus_areas": string[],          // choose from: clean energy, clean cooking, climate change, GHG reduction, energy transition, deforestation, manufacturing, women/gender, tech & innovation, engineering, AI/data
  "description": string | null      // 1-2 sentence neutral summary of what the event is
}}}}

Return {{{{ "events": [] }}}} — i.e. extract nothing — if the page is:
- Describing an event whose dates have clearly already passed.
- Actually a funding/procurement opportunity rather than an event (a call for proposals, RFP, tender, etc.) — that belongs in the opportunities pipeline, not here.
- Not actually describing a real, specific event (broken page, unrelated content, generic company homepage).

Otherwise extract exactly one item describing the event."""


def extract_json_object(text: str) -> str:
    """Pull the first {...} block out of the model's reply, in case it wraps
    the JSON in prose or code fences despite instructions. Same trick used in
    scan.mjs and social_discover.py, duplicated here for the same reason."""
    if "```" in text:
        parts = text.split("```")
        for part in parts:
            cleaned = part.lstrip()
            if cleaned.lower().startswith("json"):
                cleaned = cleaned[4:]
            if "{" in cleaned:
                text = cleaned
                break
    start = text.find("{")
    end = text.rfind("}")
    return text[start:end + 1] if start != -1 and end > start else text


def call_gemini(contents: str, tool: types.Tool) -> str | None:
    """Shared call wrapper with retry-on-429, used for both the discovery
    call (google_search tool) and each per-candidate extraction call
    (url_context tool). Returns the response text, or None if the call
    ultimately failed."""
    for attempt in range(GEMINI_MAX_RETRIES):
        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=contents,
                config=types.GenerateContentConfig(tools=[tool]),
            )
            return response.text
        except genai_errors.APIError as err:
            is_rate_limited = getattr(err, "code", None) == 429
            if is_rate_limited and attempt < GEMINI_MAX_RETRIES - 1:
                wait = GEMINI_RETRY_BACKOFF_SECONDS
                print(f"    ! Gemini rate-limited (429); waiting {wait}s and retrying "
                      f"({attempt + 1}/{GEMINI_MAX_RETRIES})")
                time.sleep(wait)
                continue
            print(f"    ! Gemini request failed: {err}")
            return None
        except Exception as err:
            print(f"    ! Gemini request failed: {err}")
            return None
    return None


def discover_candidates() -> list[dict]:
    """One call, grounded with Google Search, to find candidate opportunities
    and events. Returns a list of {kind, title, url, why_relevant} dicts."""
    text = call_gemini(DISCOVERY_PROMPT, types.Tool(google_search=types.GoogleSearch()))
    if not text:
        return []

    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print("  ! Gemini discovery call returned unparseable JSON")
        return []

    candidates = parsed.get("candidates") or []
    if not isinstance(candidates, list):
        return []

    cleaned = []
    for c in candidates:
        if not isinstance(c, dict):
            continue
        if c.get("kind") not in ("opportunity", "event"):
            continue
        if not c.get("url") or not c.get("title"):
            continue
        cleaned.append(c)
    return cleaned[:MAX_CANDIDATES_PER_RUN]


def extract_opportunity(candidate: dict) -> dict | None:
    prompt = OPPORTUNITY_EXTRACTION_PROMPT_TEMPLATE.format(
        url=candidate["url"], title=candidate["title"]
    )
    text = call_gemini(prompt, types.Tool(url_context=types.UrlContext()))
    if not text:
        return None
    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print(f"    ! unparseable JSON from opportunity extraction (raw reply started: {text[:200]!r})")
        return None
    grants = parsed.get("grants") or []
    if not grants or not isinstance(grants, list):
        # Gemini explicitly judged this page not worth extracting (per the
        # exclusion rules in the prompt) rather than a technical failure —
        # print a preview so a real run's log says WHY, not just that it
        # happened, which is what actually lets MAX_CANDIDATES_PER_RUN and
        # the prompt get tuned against real data.
        print(f"    (Gemini returned no grants; raw reply started: {text[:200]!r})")
        return None
    fields = grants[0]
    return fields if isinstance(fields, dict) and fields.get("title") else None


def extract_event(candidate: dict) -> dict | None:
    prompt = EVENT_EXTRACTION_PROMPT_TEMPLATE.format(
        url=candidate["url"], title=candidate["title"]
    )
    text = call_gemini(prompt, types.Tool(url_context=types.UrlContext()))
    if not text:
        return None
    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print(f"    ! unparseable JSON from event extraction (raw reply started: {text[:200]!r})")
        return None
    events = parsed.get("events") or []
    if not events or not isinstance(events, list):
        print(f"    (Gemini returned no events; raw reply started: {text[:200]!r})")
        return None
    fields = events[0]
    return fields if isinstance(fields, dict) and fields.get("title") else None


def content_hash(title: str, url: str) -> str:
    """Same hash scan.mjs and social_discover.py use, so the same underlying
    opportunity/event found twice collapses into one row instead of
    duplicating."""
    return hashlib.sha256(f"{title}::{url or ''}".lower().encode("utf-8")).hexdigest()


def seen_urls(candidate_urls: list[str]) -> set[str]:
    """URLs already saved as either a grant or an event on an earlier run —
    skip these before spending a Gemini call re-extracting them. Checked
    against both tables since a candidate's `kind` here is Gemini's rough
    first guess and isn't re-validated until extraction."""
    if not candidate_urls:
        return set()
    seen: set[str] = set()
    quoted = ",".join('"' + u.replace('"', "") + '"' for u in candidate_urls)
    for table, column in (("grants", "application_url"), ("events", "url")):
        try:
            response = requests.get(
                f"{SUPABASE_URL}/rest/v1/{table}",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                },
                params={"select": column, column: f"in.({quoted})"},
                timeout=30,
            )
            response.raise_for_status()
            seen.update(row[column] for row in response.json() if row.get(column))
        except Exception as err:
            print(f"  ! could not check existing {table}: {err}")
    return seen


def save_opportunity(fields: dict, candidate: dict) -> bool:
    """Upsert one extracted opportunity into `grants`, tagged source_type
    'gemini' so the Grant Scanner shows a green pill on it."""
    title = str(fields.get("title") or "").strip()
    if not title:
        return False

    application_url = fields.get("application_url") or candidate["url"]

    # Deterministic backstop, same pattern as the other two scrapers: don't
    # trust Gemini's own "has this passed?" judgment alone.
    deadline_raw = fields.get("deadline")
    if deadline_raw:
        try:
            if datetime.strptime(str(deadline_raw), "%Y-%m-%d").date() < TODAY:
                print(f"    - skipped (deadline {deadline_raw} has already passed)")
                return False
        except ValueError:
            pass

    row = {
        "title": title,
        "funder": fields.get("funder"),
        "amount": fields.get("amount"),
        "currency": fields.get("currency"),
        "deadline": fields.get("deadline"),
        "geography": fields.get("geography"),
        "focus_areas": fields.get("focus_areas") or [],
        "eligibility": fields.get("eligibility"),
        "description": fields.get("description"),
        "fit_analysis": fields.get("fit_analysis"),
        "application_url": application_url,
        "content_hash": content_hash(title, application_url),
        "source_type": "gemini",
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }

    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/grants",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
        params={"on_conflict": "content_hash"},
        json=[row],
        timeout=30,
    )
    if not response.ok:
        print(f"    ! saving opportunity failed ({response.status_code}): {response.text[:300]}")
        return False
    print(f"    + [opportunity] {title}"
          + (f"  (deadline {fields['deadline']})" if fields.get("deadline") else ""))
    return True


def save_event(fields: dict, candidate: dict) -> bool:
    """Upsert one extracted event into the separate `events` table."""
    title = str(fields.get("title") or "").strip()
    if not title:
        return False

    url = candidate["url"]

    start_date_raw = fields.get("start_date")
    if start_date_raw:
        try:
            if datetime.strptime(str(start_date_raw), "%Y-%m-%d").date() < TODAY:
                print(f"    - skipped (event date {start_date_raw} has already passed)")
                return False
        except ValueError:
            pass

    row = {
        "title": title,
        "organizer": fields.get("organizer"),
        "event_type": fields.get("event_type"),
        "format": fields.get("format"),
        "start_date": fields.get("start_date"),
        "end_date": fields.get("end_date"),
        "location": fields.get("location"),
        "geography": fields.get("geography"),
        "focus_areas": fields.get("focus_areas") or [],
        "description": fields.get("description"),
        "url": url,
        "content_hash": content_hash(title, url),
        "source_type": "gemini",
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }

    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/events",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
        params={"on_conflict": "content_hash"},
        json=[row],
        timeout=30,
    )
    if not response.ok:
        print(f"    ! saving event failed ({response.status_code}): {response.text[:300]}")
        return False
    print(f"    + [event] {title}"
          + (f"  ({fields['start_date']})" if fields.get("start_date") else ""))
    return True


def main() -> None:
    print("Gemini discovery — searching for candidate opportunities and events")
    candidates = discover_candidates()
    print(f"{len(candidates)} candidate(s) found")
    if not candidates:
        print("Done. Nothing found this run.")
        return

    already = seen_urls([c["url"] for c in candidates])
    fresh = [c for c in candidates if c["url"] not in already]
    print(f"{len(fresh)} new candidate(s) to extract ({len(candidates) - len(fresh)} seen before)")

    saved_opportunities = 0
    saved_events = 0
    for candidate in fresh:
        print(f"  → [{candidate['kind']}] {candidate['title'][:70]}")
        if candidate["kind"] == "opportunity":
            fields = extract_opportunity(candidate)
            if not fields:
                print("    - nothing extractable; skipped")
            elif save_opportunity(fields, candidate):
                saved_opportunities += 1
        else:
            fields = extract_event(candidate)
            if not fields:
                print("    - nothing extractable; skipped")
            elif save_event(fields, candidate):
                saved_events += 1
        time.sleep(GEMINI_PACING_SECONDS)

    print(f"\nDone. {saved_opportunities} opportunity/ies added to the Grant Scanner, "
          f"{saved_events} event(s) added to the Events tab.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
