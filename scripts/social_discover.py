LinkedIn opportunity discovery via Bright Data.

Watches funder LinkedIn company pages (the `social_sources` table), pulls their
recent posts through Bright Data's LinkedIn Posts scraper, keeps only the ones
that are genuine solicitations (RFP / EOI / tender / call for proposals), runs
them through Groq to extract structured fields, and writes them straight into
the `grants` table so they show up in the Grant Scanner like any other
opportunity — with a priority flag so they sort to the top.

Why extract from the POST TEXT rather than the page it links to: funder tender
posts state the deadline, the scope and how to apply directly in the post, and
the page they link to is often a login-walled procurement portal (Delta
eSourcing, UNGM, etc.) that a scraper just sees a sign-in screen for. The post
is the more reliable source. The outbound link is still captured and stored as
the opportunity's application_url so a human can click through.

NOTE ON DUPLICATION: EXTRACTION_SYSTEM_PROMPT and BURN_PROFILE below mirror the
ones in scripts/scan.mjs. They are deliberately duplicated so this script stays
self-contained (no changes to scan.mjs required). If you change BURN's profile
or the extraction rules, update BOTH files.

Cost control: Bright Data bills per record. POSTS_PER_COMPANY caps how many
posts are pulled per company per run; MAX_AGE_DAYS discards anything stale.

Run locally:  python scripts/social_discover.py
Runs in CI:   see .github/workflows/social-discover.yml
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
@@ -35,100 +41,33 @@
from datetime import datetime, timezone

import requests
from google import genai
from google.genai import types
from google.genai import errors as genai_errors

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BRIGHTDATA_API_KEY = os.environ["BRIGHTDATA_API_KEY"]
GROQ_API_KEY = os.environ["GROQ_API_KEY"]
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]

# Bright Data's "LinkedIn posts" dataset. Confirmed working against a real
# company page with type=discover_new & discover_by=company_url.
DATASET_ID = "gd_lyy3tktm25m4avu764"
SCRAPE_URL = "https://api.brightdata.com/datasets/v3/scrape"
PROGRESS_URL = "https://api.brightdata.com/datasets/v3/progress"
SNAPSHOT_URL = "https://api.brightdata.com/datasets/v3/snapshot"
client = genai.Client(api_key=GEMINI_API_KEY)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-20b"
# If this ever 404s, check ai.google.dev/gemini-api/docs/models for the
# current flash-tier model name and swap it here — everything else stays
# the same.
GEMINI_MODEL = "gemini-2.5-flash"

# --- Cost / noise controls -------------------------------------------------
POSTS_PER_COMPANY = 5
MAX_AGE_DAYS = 45
# One discovery call, plus up to this many per-candidate extraction calls —
# bounds run time and API usage the same way POSTS_PER_COMPANY does for
# social_discover.py.
MAX_CANDIDATES_PER_RUN = 15

POLL_INTERVAL_SECONDS = 15
POLL_MAX_ATTEMPTS = 20
GEMINI_MAX_RETRIES = 3
GEMINI_RETRY_BACKOFF_SECONDS = 20  # fallback wait if no retry hint is available
GEMINI_PACING_SECONDS = 2.0        # deliberate pause between extraction calls

GROQ_MAX_RETRIES = 3
GROQ_RETRY_BACKOFF_SECONDS = 20  # fallback wait if Groq doesn't send a Retry-After header

# Computed once per run and handed to Groq explicitly below — the model has no
# reliable notion of "today" on its own, so without this it can't actually
# judge whether a stated deadline has passed. Also used as a deterministic
# backstop in save_grant(): even if Groq's own judgment misses an expired
# post, the extracted date is checked again before anything is saved.
TODAY = datetime.now(timezone.utc).date()

# --- What counts as an opportunity ----------------------------------------
# Deliberately narrow: only real solicitations. Loose words like "funding" or
# "grant" on their own are NOT enough — a funder saying "we granted $2m to X"
# is not something you can apply to.
SOLICITATION_SIGNALS = [
    "request for proposal", "request for proposals", "rfp", "rfq",
    "request for quotation", "request for application", "rfa",
    "expression of interest", "expressions of interest", "eoi",
    "call for",  # catches "call for proposals/tenders/business plans/partners/..."
                 # in one go, instead of enumerating every noun that follows it
    "invitation to tender", "invitation to bid", "invitation for bids",
    "invitation to apply", "invites applications",
    "invites organisations to apply", "invites organizations to apply",
    "new tender", "open tender", "tender notice",
    "terms of reference", "prequalification", "pre-qualification",
    "procurement notice", "challenge fund", "funding call",
    "applications are open", "applications are now open", "now accepting applications",
    "consultancy opportunity", "seeking a consultant", "seeking consultants",
    "seeking proposals", "seeking applications",
    "seeking partners", "seeking implementing partners",
]

# ...and it has to be time-bound: a real, currently-open window.
TIMING_SIGNALS = [
    "deadline", "closing date", "closes on", "close on", "apply by",
    "applications close", "submission date", "submit by", "rolling basis",
    "open until", "due by", "no later than", "closing on",
]

# ...and it has to be squarely in BURN's space: clean cooking, cookstoves,
# clean energy / energy transition, or carbon markets. Deliberately does NOT
# include vague terms like "climate change", "sustainability" or "emissions"
# on their own — those match forestry, land-use and agriculture posts just as
# easily as energy ones, which is exactly the noise we don't want.
TOPIC_SIGNALS = [
    "cooking", "cookstove", "cook stove", "stove", "clean cooking",
    "household energy", "indoor air", "fuel efficient", "cooking fuel",
    "biomass", "lpg", "ethanol", "charcoal", "briquette", "pellet",
    "clean energy", "renewable energy", "energy access", "energy transition",
    "sustainable energy", "modern energy", "energy efficiency",
    "off-grid", "off grid", "mini-grid", "mini grid", "microgrid",
    "electrification", "ecooking", "e-cooking", "electric cooking",
    "solar", "sdg7", "sdg 7",
    "carbon credit", "carbon market", "carbon finance", "carbon project",
    "climate finance", "results-based financing", "results based financing",
]

# Hard exclusions — subject areas BURN explicitly does not want to see. These
# are terms that never describe a clean-cooking opportunity as their main
# subject, so a post centred on them is thrown out even if it also happens to
# mention energy. Note "deforestation" is NOT here: efficient-cookstove calls
# legitimately cite reduced deforestation as a co-benefit.
EXCLUDE_SIGNALS = [
    "irrigation", "livestock", "aquaculture", "fisheries", "fishery",
    "crop production", "crop yield", "smallholder farm", "farm inputs",
    "fertiliser", "fertilizer", "agri-processing", "agroforestry",
    "reforestation", "afforestation", "tree planting", "tree-planting",
    "redd+", "land restoration", "soil health", "seed systems",
    "horticulture", "poultry", "dairy",
]

BURN_PROFILE = """BURN Manufacturing — company profile for grant-fit assessment:
- Products: manufactures and distributes clean cookstoves across every major fuel type — LPG gas, biomass/wood, electric induction (IoT-enabled), ethanol, charcoal, and institutional-scale stoves — plus cookware.
- Manufacturing & scale: owns factories in Kenya and Nigeria (plus Asia), 450K+ units/month capacity, ships orders from 3,000 to 1M+ units. This is an established, at-scale manufacturer — NOT an early-stage or pre-revenue startup.
@@ -141,313 +80,111 @@
- Strong-fit program patterns: results-based financing (RBF) programs for clean cooking, calls for proposals / "Call4Solutions" / tenders specifically for cookstove distribution or manufacturing, institutional and school-cooking programs, and higher-tier/modern eCooking scale-up programs.
- Agriculture is generally NOT a fit: BURN is a clean cookstove company, not an agriculture company. Funding primarily for on-farm equipment, agricultural inputs, crop or livestock production, agri-processing, or farm-level energy systems is a poor fit — even if it touches climate or energy — UNLESS it specifically funds clean cookstove manufacturing or distribution."""

EXTRACTION_SYSTEM_PROMPT = f"""You extract a structured, OPEN funding or procurement opportunity from the text of a LinkedIn post, and assess how well it fits BURN Manufacturing, a specific company described below.
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

OPPORTUNITY_EXTRACTION_PROMPT_TEMPLATE = f"""Read the page at the URL below using your url_context tool, then extract a structured, OPEN funding or procurement opportunity from it, and assess how well it fits the company described below.

You also have Google Search available. The URL below often comes from a search-grounding redirect rather than the funder's own page, so it sometimes lands on the wrong thing — a general press-release index, a news list, a category/homepage, or a page that fails to load — instead of the specific "{{title}}" item. If url_context does not show you the specific opportunity itself (not a list, not an unrelated page, not empty/broken), use Google Search to find the correct, specific page for "{{title}}" — search by its name and, if known, its funder — then read THAT page with url_context instead of giving up. Only fall back to an empty result if, after actually trying to search for and read the specific page, you still cannot find real, extractable content about it.

Today's date is {TODAY.isoformat()}. Use this — not any date you might otherwise assume — whenever you need to judge whether a stated deadline has already passed.

{BURN_PROFILE}

The text you are given is a LinkedIn post published by a funder, development programme or foundation. It has already been screened as looking like a solicitation. Your job is to turn it into structured data.
URL to read first: {{url}}
This page was already flagged as a likely "{{title}}" opportunity — confirm or correct that from the actual page content (or from the specific page you find via search, per above).

Respond with ONLY a JSON object — no markdown code fences, no explanation before or after — of the shape:
{{ "grants": [ {{ ... }} ] }}
{{{{ "grants": [ {{{{ ... }}}} ] }}}}

Each item must have exactly these fields (use null for anything not stated — never guess or invent values):
{{
{{{{
  "title": string,
  "funder": string | null,
  "amount": number | null,
  "currency": string | null,
  "deadline": string | null,        // ISO date "YYYY-MM-DD" only if a specific date is stated. A post saying "open until 23.55 BST on Tuesday 15 September 2026" means "2026-09-15".
  "deadline": string | null,        // ISO date "YYYY-MM-DD" only if a specific date is stated
  "geography": string | null,
  "focus_areas": string[],          // choose from: clean energy, clean cooking, climate change, GHG reduction, energy transition, deforestation, manufacturing, women/gender, tech & innovation, engineering, AI/data
  "eligibility": string | null,
  "description": string | null,     // 1-2 sentence neutral summary of the opportunity itself
  "application_url": string | null, // the outbound link where you apply, if the post states one
  "fit_analysis": string | null     // 2-4 sentences assessing how well THIS opportunity fits BURN specifically
}}
  "application_url": string | null, // the outbound link where you apply, if the page states one — otherwise use the URL you were given
  "fit_analysis": string | null     // 2-4 sentences assessing how well THIS opportunity fits the company specifically
}}}}

Rules for "fit_analysis":
- Write it as an analyst briefing BURN's grants team, not marketing copy.
- Write it as an analyst briefing the company's grants team, not marketing copy.
- Reference concrete matching points from the profile above where they apply: geography overlap, product/fuel-type match, carbon finance or gender-program fit, or distribution-network relevance.
- If something looks like a MISMATCH, say so plainly — e.g. it targets operators far smaller than BURN's scale, the geography excludes BURN's countries, it is an equity investment rather than a grant, or it is a consultancy/advisory assignment rather than funding for BURN's own operations.
- If the post gives too little detail to judge fit, set this field to null rather than guessing.

A human reviews every opportunity you extract in the Grant Scanner before deciding whether to pursue it, and can discard anything irrelevant with one click. So when a post is a genuine, open, on-topic call for applications, extract it even if some secondary detail is thin or unclear — set the uncertain field to null and flag the uncertainty in fit_analysis — rather than returning an empty grants list. Only skip a post entirely for one of the specific reasons below.
- If something looks like a MISMATCH, say so plainly — e.g. it targets operators far smaller than the company's scale, the geography excludes its countries, it is an equity investment rather than a grant, or it is a consultancy/advisory assignment rather than funding for the company's own operations.
- If the page gives too little detail to judge fit, set this field to null rather than guessing.

Return {{ "grants": [] }} — i.e. extract nothing — if the post is:
Return {{{{ "grants": [] }}}} — i.e. extract nothing — if the page is:
- Announcing that someone has ALREADY won, received or been awarded funding.
- A recap of an event, conference, webinar or partnership, even if funding is mentioned.
- A job vacancy for a permanent or fixed-term STAFF employee (e.g. "Now hiring: Program Officer," asking for a CV/résumé) — NOT a competitively tendered individual consultancy. If the post has tender/procurement mechanics (a bidding portal, a Terms of Reference, a formal submission deadline), treat it as a solicitation and extract it, even when it names a single "consultant" as the eligible bidder.
- Advertising a paid course, training programme, certification, workshop, webinar or masterclass that BURN would pay a fee to attend as a participant — not a grant, tender or funding opportunity that provides money or a contract TO BURN.
- A job vacancy for a permanent or fixed-term STAFF employee, rather than a competitively tendered consultancy.
- Advertising a paid course, training programme, certification, workshop, webinar or masterclass — not a grant, tender or funding opportunity that provides money or a contract TO the company.
- An opportunity whose stated deadline is before {TODAY.isoformat()} (today).
- Primarily an agriculture, forestry or land-use opportunity — farming, crops, livestock, irrigation, agri-processing, agroforestry, reforestation/afforestation, tree planting, REDD+, land restoration, biodiversity or conservation — even where climate or energy is mentioned. BURN's scope is clean cooking, cookstoves, clean energy and energy transition, and carbon markets. An efficient-cookstove programme that cites reduced deforestation as a co-benefit IS in scope; a forestry or land-restoration programme is not.
- Primarily an agriculture, forestry or land-use opportunity, even where climate or energy is mentioned.
- Not actually a funding/procurement opportunity at all (e.g. the page turned out to be unrelated, broken, or paywalled with no visible content).

Otherwise extract exactly one item describing the opportunity."""

EVENT_EXTRACTION_PROMPT_TEMPLATE = f"""Read the page at the URL below using your url_context tool, then extract structured details about the industry event it describes.

def fetch_social_sources() -> list[dict]:
    """Company pages to watch, from the `social_sources` table."""
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/social_sources",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            params={"select": "name,url,discover_by", "active": "eq.true"},
            timeout=30,
        )
        response.raise_for_status()
        return [row for row in response.json() if row.get("url")]
    except Exception as err:
        print(f"! Failed to fetch social_sources from Supabase: {err}")
        return []


def seen_post_urls(post_urls: list[str]) -> set[str]:
    """Posts already processed on an earlier run — skip them so we don't pay
    Groq (or create duplicate grants) for the same post twice."""
    if not post_urls:
        return set()
    seen: set[str] = set()
    for start in range(0, len(post_urls), 40):
        chunk = post_urls[start:start + 40]
        quoted = ",".join('"' + url.replace('"', "") + '"' for url in chunk)
        try:
            response = requests.get(
                f"{SUPABASE_URL}/rest/v1/social_posts",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                },
                params={"select": "post_url", "post_url": f"in.({quoted})"},
                timeout=30,
            )
            response.raise_for_status()
            seen.update(row["post_url"] for row in response.json())
        except Exception as err:
            print(f"  ! could not check existing posts: {err}")
    return seen


def parse_records(response: requests.Response) -> list[dict]:
    """Bright Data returns a JSON array, but can also hand back newline-delimited
    JSON. Handle both rather than assuming."""
    text = response.text.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return [row for row in parsed if isinstance(row, dict)]
        if isinstance(parsed, dict):
            return [parsed]
    except json.JSONDecodeError:
        pass

    records = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                records.append(row)
        except json.JSONDecodeError:
            continue
    return records
You also have Google Search available. The URL below often comes from a search-grounding redirect rather than the event's own page, so it sometimes lands on the wrong thing — a general press-release index, a news list, a category/homepage, or a page that fails to load — instead of the specific "{{title}}" event page. If url_context does not show you the specific event itself (not a list, not an unrelated page, not empty/broken), use Google Search to find the correct, specific event page for "{{title}}" — search by its name and, if known, its organizer — then read THAT page with url_context instead of giving up. Only fall back to an empty result if, after actually trying to search for and read the specific page, you still cannot find real, extractable content about it.

Today's date is {TODAY.isoformat()}. Use this — not any date you might otherwise assume — whenever you need to judge whether the event has already happened.

def poll_snapshot(snapshot_id: str) -> list[dict]:
    """If the sync endpoint times out it returns a snapshot_id instead; wait for
    that job to finish and pull the results."""
    headers = {"Authorization": f"Bearer {BRIGHTDATA_API_KEY}"}
    print(f"  … job queued ({snapshot_id}), waiting for it to finish")

    for attempt in range(POLL_MAX_ATTEMPTS):
        time.sleep(POLL_INTERVAL_SECONDS)
        try:
            progress = requests.get(
                f"{PROGRESS_URL}/{snapshot_id}", headers=headers, timeout=30
            )
            status = ""
            if progress.ok:
                try:
                    status = str(progress.json().get("status", "")).lower()
                except json.JSONDecodeError:
                    status = ""
            print(f"    poll {attempt + 1}: status={status or 'unknown'}")

            if status in {"failed", "error", "canceled", "cancelled"}:
                print("  ! Bright Data reported the job failed")
                return []

            # The exact "ready" wording isn't documented reliably, so rather
            # than matching on a status string, just try the snapshot and see
            # whether real records come back.
            snapshot = requests.get(
                f"{SNAPSHOT_URL}/{snapshot_id}",
                headers=headers,
                params={"format": "json"},
                timeout=60,
            )
            if snapshot.ok:
                records = parse_records(snapshot)
                if records:
                    return records
        except Exception as err:
            print(f"    poll {attempt + 1} failed: {err}")

    print("  ! gave up waiting for the job to finish")
    return []


def fetch_company_posts(company_url: str, discover_by: str = "company_url") -> list[dict]:
    """Pull recent posts for one LinkedIn page.

    `discover_by` comes from the source row so a page that isn't a /company/
    page can still be watched — e.g. MECS programme is published as a personal
    (/in/) profile, which Bright Data discovers with "profile_url" rather than
    "company_url".
    """
    try:
        response = requests.post(
            SCRAPE_URL,
            headers={
                "Authorization": f"Bearer {BRIGHTDATA_API_KEY}",
                "Content-Type": "application/json",
            },
            params={
                "dataset_id": DATASET_ID,
                "notify": "false",
                "include_errors": "true",
                "type": "discover_new",
                "discover_by": discover_by,
            },
            json={
                "input": [{"url": company_url}],
                "limit_per_input": POSTS_PER_COMPANY,
            },
            timeout=180,
        )
    except Exception as err:
        print(f"  ! request failed: {err}")
        return []

    if response.status_code == 202:
        try:
            snapshot_id = response.json().get("snapshot_id")
        except json.JSONDecodeError:
            snapshot_id = None
        return poll_snapshot(snapshot_id) if snapshot_id else []

    if not response.ok:
        print(f"  ! Bright Data returned {response.status_code}: {response.text[:300]}")
        return []

    records = parse_records(response)
    if len(records) == 1 and "snapshot_id" in records[0] and "post_text" not in records[0]:
        return poll_snapshot(records[0]["snapshot_id"])
    return records


def post_age_days(record: dict) -> float | None:
    raw = record.get("date_posted")
    if not raw:
        return None
    try:
        posted = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    if posted.tzinfo is None:
        posted = posted.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - posted).total_seconds() / 86400


def is_solicitation(record: dict) -> bool:
    """Narrow gate: a real, on-topic call for applications.

    Requires SOLICITATION_SIGNALS and TOPIC_SIGNALS to both match, and rejects
    anything hitting EXCLUDE_SIGNALS. Deliberately does NOT also require a
    TIMING_SIGNALS match: a genuine, currently-open call can state its
    deadline in ways that don't happen to hit one of the fixed TIMING_SIGNALS
    phrases (e.g. "submissions due September 15" vs. the listed "due by"),
    and that was silently excluding real opportunities. TOPIC_SIGNALS stays
    required — it's what keeps run time low without needing the timing
    requirement too."""
    text = " ".join(
        str(record.get(field) or "")
        for field in ("headline", "post_text", "title")
    ).lower()
    if len(text) < 120:
        return False
    if any(signal in text for signal in EXCLUDE_SIGNALS):
        return False
    return (
        any(signal in text for signal in SOLICITATION_SIGNALS)
        and any(signal in text for signal in TOPIC_SIGNALS)
    )
URL to read first: {{url}}
This page was already flagged as a likely "{{title}}" event — confirm or correct that from the actual page content (or from the specific page you find via search, per above).

Respond with ONLY a JSON object — no markdown code fences, no explanation before or after — of the shape:
{{{{ "events": [ {{{{ ... }}}} ] }}}}

def external_links(record: dict) -> list[str]:
    """Links worth keeping: everything except LinkedIn's own hashtag, profile
    and company links. lnkd.in shortlinks are kept — those redirect out to the
    real opportunity page."""
    keep = []
    for link in record.get("embedded_links") or []:
        if not isinstance(link, str) or not link.startswith("http"):
            continue
        lowered = link.lower()
        if "linkedin.com" in lowered:
            continue
        if lowered.rstrip("/").endswith("lnkd.in"):
            continue
        if link not in keep:
            keep.append(link)
    return keep


def select_solicitations(records: list[dict], company_url: str) -> list[dict]:
    """Filter one company's raw scrape down to genuine solicitations.

    Only top-level records are considered. Bright Data attaches a
    `more_relevant_posts` array of LinkedIn's own "you might also like"
    suggestions — unrelated posts from unrelated accounts — which must never
    be treated as findings from this company.
    """
    hits = []
    for record in records:
        if not isinstance(record, dict):
            continue
        post_url = record.get("url")
        if not post_url:
            continue
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

        age = post_age_days(record)
        if age is not None and age > MAX_AGE_DAYS:
            continue
        if not is_solicitation(record):
            continue
Return {{{{ "events": [] }}}} — i.e. extract nothing — if the page is:
- Describing an event whose dates have clearly already passed.
- Actually a funding/procurement opportunity rather than an event (a call for proposals, RFP, tender, etc.) — that belongs in the opportunities pipeline, not here.
- Not actually describing a real, specific event (broken page, unrelated content, generic company homepage).

        hits.append({
            "post_url": post_url,
            "author_name": record.get("user_name"),
            "author_handle": record.get("user_id"),
            "headline": record.get("headline"),
            "post_text": record.get("post_text"),
            "post_links": external_links(record),
            "posted_at": record.get("date_posted"),
            "discovered_from": company_url,
            "status": "pending",
        })
    return hits
Otherwise extract exactly one item describing the event."""


def extract_json_object(text: str) -> str:
    """Pull the first {...} block out of the model's reply, in case it wraps
    the JSON in prose or code fences despite instructions."""
    the JSON in prose or code fences despite instructions. Same trick used in
    scan.mjs and social_discover.py, duplicated here for the same reason."""
    if "```" in text:
        parts = text.split("```")
        for part in parts:
@@ -462,104 +199,175 @@ def extract_json_object(text: str) -> str:
    return text[start:end + 1] if start != -1 and end > start else text


def extract_opportunity(post: dict) -> dict | None:
    """Run one post through Groq and get structured opportunity fields back."""
    body = "\n\n".join(filter(None, [
        f"Posted by: {post.get('author_name') or 'Unknown'}",
        f"Posted on: {post.get('posted_at') or 'Unknown'}",
        f"Headline: {post.get('headline') or ''}",
        f"Post:\n{post.get('post_text') or ''}",
        f"Links in the post: {', '.join(post['post_links'])}" if post["post_links"] else "",
    ]))

    content = None
    for attempt in range(GROQ_MAX_RETRIES):
def call_gemini(contents: str, tools: list[types.Tool]) -> str | None:
    """Shared call wrapper with retry-on-429, used for both the discovery
    call (google_search tool alone) and each per-candidate extraction call
    (url_context + google_search together — see the extraction prompts for
    why both are needed: the discovery step's URL is often a search-grounding
    redirect that doesn't land on the specific page, and google_search lets
    the model re-find the right one instead of giving up). Returns the
    response text, or None if the call ultimately failed."""
    for attempt in range(GEMINI_MAX_RETRIES):
        try:
            response = requests.post(
                GROQ_URL,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": GROQ_MODEL,
                    "reasoning_effort": "low",
                    "max_completion_tokens": 3072,
                    "messages": [
                        {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                        {"role": "user", "content": body[:15000]},
                    ],
                },
                timeout=120,
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=contents,
                config=types.GenerateContentConfig(tools=tools),
            )
            if response.status_code == 429:
                wait = int(response.headers.get("retry-after", GROQ_RETRY_BACKOFF_SECONDS))
                if attempt < GROQ_MAX_RETRIES - 1:
                    print(f"    ! Groq rate-limited (429); waiting {wait}s and retrying "
                          f"({attempt + 1}/{GROQ_MAX_RETRIES})")
                    time.sleep(wait)
                    continue
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            break
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
            print(f"    ! Groq request failed: {err}")
            print(f"    ! Gemini request failed: {err}")
            return None
    return None

    if content is None:
        print("    ! Groq rate-limited after retries; skipping this post")
        return None

def discover_candidates() -> list[dict]:
    """One call, grounded with Google Search, to find candidate opportunities
    and events. Returns a list of {kind, title, url, why_relevant} dicts."""
    text = call_gemini(DISCOVERY_PROMPT, [types.Tool(google_search=types.GoogleSearch())])
    if not text:
        return []

    try:
        parsed = json.loads(extract_json_object(content))
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print("    ! Groq returned unparseable JSON; skipping this post")
        return None
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
    text = call_gemini(prompt, [
        types.Tool(url_context=types.UrlContext()),
        types.Tool(google_search=types.GoogleSearch()),
    ])
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
    return fields if isinstance(fields, dict) and fields.get("title") else None


def extract_event(candidate: dict) -> dict | None:
    prompt = EVENT_EXTRACTION_PROMPT_TEMPLATE.format(
        url=candidate["url"], title=candidate["title"]
    )
    text = call_gemini(prompt, [
        types.Tool(url_context=types.UrlContext()),
        types.Tool(google_search=types.GoogleSearch()),
    ])
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
    """Same hash scan.mjs uses, so a post and a scraped page describing the same
    opportunity collapse into one row instead of duplicating."""
    """Same hash scan.mjs and social_discover.py use, so the same underlying
    opportunity/event found twice collapses into one row instead of
    duplicating."""
    return hashlib.sha256(f"{title}::{url or ''}".lower().encode("utf-8")).hexdigest()


def save_grant(fields: dict, post: dict) -> bool:
    """Upsert one extracted opportunity into `grants`, flagged as LinkedIn-sourced
    and priority so it sorts to the top of the Grant Scanner.
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


    application_url always points back to the LinkedIn post itself, not the
    link or email Groq pulled out of the post text — those are often a
    mailto: address (as with the MECS carbon finance post) or a login-walled
    procurement portal, which makes for a broken or unhelpful "Go to
    opportunity" click. The LinkedIn post always loads and shows full context,
    including how to apply, so that's what the button should point to.
    """
    application_url = post["post_url"]
def save_opportunity(fields: dict, candidate: dict) -> bool:
    """Upsert one extracted opportunity into `grants`, tagged source_type
    'gemini' so the Grant Scanner shows a green pill on it."""
    title = str(fields.get("title") or "").strip()
    if not title:
        return False

    # Deterministic backstop: don't trust Groq's own "has this passed?"
    # judgment alone. If it extracted a specific deadline, check it against
    # today's actual date before saving anything.
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
            pass  # not a parseable date; let it through rather than guessing
            pass

    row = {
        "title": title,
        "funder": fields.get("funder") or post.get("author_name"),
        "funder": fields.get("funder"),
        "amount": fields.get("amount"),
        "currency": fields.get("currency"),
        "deadline": fields.get("deadline"),
@@ -570,8 +378,7 @@ def save_grant(fields: dict, post: dict) -> bool:
        "fit_analysis": fields.get("fit_analysis"),
        "application_url": application_url,
        "content_hash": content_hash(title, application_url),
        "source_type": "linkedin",
        "priority": 1,
        "source_type": "gemini",
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }

@@ -588,76 +395,99 @@ def save_grant(fields: dict, post: dict) -> bool:
        timeout=30,
    )
    if not response.ok:
        print(f"    ! saving grant failed ({response.status_code}): {response.text[:300]}")
        print(f"    ! saving opportunity failed ({response.status_code}): {response.text[:300]}")
        return False
    print(f"    + {title}"
    print(f"    + [opportunity] {title}"
          + (f"  (deadline {fields['deadline']})" if fields.get("deadline") else ""))
    return True


def log_posts(rows: list[dict]) -> int:
    """Keep a record of every post we processed, so we never pay to scrape or
    re-extract the same one twice."""
    if not rows:
        return 0
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
        f"{SUPABASE_URL}/rest/v1/social_posts",
        f"{SUPABASE_URL}/rest/v1/events",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,return=representation",
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
        json=rows,
        params={"on_conflict": "content_hash"},
        json=[row],
        timeout=30,
    )
    if not response.ok:
        print(f"! logging posts failed ({response.status_code}): {response.text[:300]}")
        return 0
    return len(response.json())
        print(f"    ! saving event failed ({response.status_code}): {response.text[:300]}")
        return False
    print(f"    + [event] {title}"
          + (f"  ({fields['start_date']})" if fields.get("start_date") else ""))
    return True


def main() -> None:
    sources = fetch_social_sources()
    print(f"Social discovery — {len(sources)} company page(s) to check")
    if not sources:
        print("No active rows in social_sources. Nothing to do.")
        return

    candidates: list[dict] = []
    for source in sources:
        name = source.get("name") or source["url"]
        discover_by = source.get("discover_by") or "company_url"
        print(f"\n→ {name}  [{discover_by}]")
        records = fetch_company_posts(source["url"], discover_by)
        print(f"  pulled {len(records)} post(s)")
        if not records:
            print("    (nothing came back — if this page keeps returning 0, check"
                  " its discover_by value in social_sources)")
        hits = select_solicitations(records, source["url"])
        print(f"  {len(hits)} look like open solicitations")
        candidates.extend(hits)

    print("Gemini discovery — searching for candidate opportunities and events")
    candidates = discover_candidates()
    print(f"{len(candidates)} candidate(s) found")
    if not candidates:
        print("\nDone. No new solicitations found.")
        print("Done. Nothing found this run.")
        return

    already = seen_post_urls([row["post_url"] for row in candidates])
    fresh = [row for row in candidates if row["post_url"] not in already]
    print(f"\n{len(fresh)} new post(s) to extract ({len(candidates) - len(fresh)} seen before)")

    saved = 0
    for post in fresh:
        print(f"  → {(post.get('headline') or post['post_url'])[:70]}")
        fields = extract_opportunity(post)
        if not fields:
            print("    - nothing extractable; skipped")
            continue
        if save_grant(fields, post):
            saved += 1

    logged = log_posts(fresh)
    print(f"\nDone. {saved} opportunity/ies added to the Grant Scanner, {logged} post(s) logged.")
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
