"""
Clean cooking / clean energy opportunity + event discovery via Gemini.

Uses Gemini's built-in Google Search grounding to find candidate items
matching BURN's profile — both funding opportunities (RFPs, EOIs, calls for
proposals, "Call for Solutions", tenders, results-based financing calls) and
industry events (conferences, summits, forums, webinars) — then a second,
per-candidate call using Gemini's url_context tool to actually read that
candidate's page and extract full structured fields.
"""

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
import yaml
from google import genai
from google.genai import types
from google.genai import errors as genai_errors

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]

client = genai.Client(api_key=GEMINI_API_KEY)

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


def _load_yaml(name: str) -> dict:
    with open(CONFIG_DIR / name, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


# If this ever 404s, check ai.google.dev/gemini-api/docs/models for the
# current flash-tier model name and swap it here — everything else stays
# the same.
GEMINI_MODEL = "gemini-2.5-flash"


MAX_OPPORTUNITIES_PER_RUN = 15
MAX_EVENTS_PER_RUN = 50

MAX_ITEMS_PER_OPPORTUNITY_PAGE = 15
MAX_EVENTS_PER_PAGE = 10  # events taken from one fixed events-listing page

GEMINI_MAX_RETRIES = 3
GEMINI_RETRY_BACKOFF_SECONDS = 20
GEMINI_PACING_SECONDS = 2.0

TODAY = datetime.now(timezone.utc).date()

# Company profile and priority countries live in config/company.yaml.
_company = _load_yaml("company.yaml")
BURN_PROFILE = _company["burn_profile"]

_sources_config = _load_yaml("sources.yaml")

FIXED_OPPORTUNITY_SOURCES = [
    source
    for source in (_sources_config.get("sources") or [])
    if isinstance(source, dict) and source.get("title") and source.get("url")
]

# The "Events listed on" title prefix is what tells the event_extraction
# prompt to treat the page as a listing and return several events from it.
FIXED_EVENT_SOURCES = [
    {"title": f"Events listed on {urlparse(url).hostname or url}", "url": url}
    for url in (_sources_config.get("event_sources") or [])
    if isinstance(url, str) and url.strip()
]

_taxonomy = _load_yaml("taxonomy.yaml")
PRIMARY_EVENT_TOPICS = _taxonomy.get("primary_topics") or []
SECONDARY_EVENT_TOPICS = _taxonomy.get("secondary_topics") or []
CORE_EVENT_TOPICS = _taxonomy.get("core_topics") or []
RELEVANCE_LEVELS = _taxonomy.get("relevance_levels") or {}
RELEVANCE_EXCLUSIONS = _taxonomy.get("exclusions") or []
RELEVANCE_LEVEL_VALUES = {"high", "medium", "low", "not_relevant"}


EVENT_GEOGRAPHY_PRIORITY = _company.get("geography_priority") or []

# Prompt wording lives in config/prompts.yaml — edit that file to change what
# Gemini is asked, no code changes needed. See its header for the full list
# of {placeholders} filled in below.
PROMPTS = _load_yaml("prompts.yaml")

_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


def render_prompt(template: str, **values) -> str:
    """Fill {name} placeholders from `values`. Any other braces — the JSON
    examples, or placeholders not supplied yet (e.g. {url}/{title} on the
    extraction templates, filled per candidate later) — are left untouched,
    so the YAML can use plain single braces with no escaping."""
    return _PLACEHOLDER.sub(
        lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0),
        template,
    )


_PROMPT_VALUES = {
    "today": TODAY.isoformat(),
    "burn_profile": BURN_PROFILE,
    "max_opportunities": MAX_OPPORTUNITIES_PER_RUN,
    "max_events": MAX_EVENTS_PER_RUN,
    "max_items_per_opportunity_page": MAX_ITEMS_PER_OPPORTUNITY_PAGE,
    "max_events_per_page": MAX_EVENTS_PER_PAGE,
    "core_topics": "\n".join(f"- {topic}" for topic in CORE_EVENT_TOPICS),
    "primary_topics": "\n".join(f"- {topic}" for topic in PRIMARY_EVENT_TOPICS),
    "secondary_topics": "\n".join(f"- {topic}" for topic in SECONDARY_EVENT_TOPICS),
    "geography_priority": "\n".join(
        f"   {i}. {country}"
        for i, country in enumerate(EVENT_GEOGRAPHY_PRIORITY, start=1)
    ),
    "fixed_opportunity_sources": "\n".join(
        f"- {source['title']}: {source['url']}" for source in FIXED_OPPORTUNITY_SOURCES
    ),
    "fixed_event_sources": "\n".join(
        f"- {source['title']}: {source['url']}" for source in FIXED_EVENT_SOURCES
    ),
}

OPPORTUNITY_DISCOVERY_PROMPT = render_prompt(PROMPTS["opportunity_discovery"], **_PROMPT_VALUES)
EVENT_DISCOVERY_PROMPT = render_prompt(PROMPTS["event_discovery"], **_PROMPT_VALUES)

# {url} and {title} are left in these two and filled per candidate by
# extract_opportunity() / extract_event().
OPPORTUNITY_EXTRACTION_PROMPT_TEMPLATE = render_prompt(PROMPTS["opportunity_extraction"], **_PROMPT_VALUES)
EVENT_EXTRACTION_PROMPT_TEMPLATE = render_prompt(PROMPTS["event_extraction"], **_PROMPT_VALUES)


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
    return text[start : end + 1] if start != -1 and end > start else text


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
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=contents,
                config=types.GenerateContentConfig(tools=tools),
            )
            return response.text
        except genai_errors.APIError as err:
            is_rate_limited = getattr(err, "code", None) == 429
            if is_rate_limited and attempt < GEMINI_MAX_RETRIES - 1:
                wait = GEMINI_RETRY_BACKOFF_SECONDS
                print(
                    f"    ! Gemini rate-limited (429); waiting {wait}s and retrying "
                    f"({attempt + 1}/{GEMINI_MAX_RETRIES})"
                )
                time.sleep(wait)
                continue
            print(f"    ! Gemini request failed: {err}")
            return None
        except Exception as err:
            print(f"    ! Gemini request failed: {err}")
            return None
    return None


def _discover(prompt: str, kind: str, limit: int) -> list[dict]:
    """One Google-Search-grounded discovery call for a single category.
    Returns up to `limit` {kind, title, url, ...} dicts, tagged with `kind`
    here since each prompt only covers one category."""
    text = call_gemini(prompt, [types.Tool(google_search=types.GoogleSearch())])
    if not text:
        return []

    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print(f"  ! Gemini {kind} discovery call returned unparseable JSON")
        return []

    candidates = parsed.get("candidates") or []
    if not isinstance(candidates, list):
        return []

    cleaned = []
    for c in candidates:
        if not isinstance(c, dict):
            continue
        if not c.get("url") or not c.get("title"):
            continue
        cleaned.append({**c, "kind": kind})

    # Enforce the limit here rather than trusting the model to respect it.
    return cleaned[:limit]


def discover_candidates() -> list[dict]:
    """Two separate discovery calls — one for opportunities, one for events —
    each with its own prompt and budget, so neither category crowds out the
    other."""
    opportunities = _discover(
        OPPORTUNITY_DISCOVERY_PROMPT, "opportunity", MAX_OPPORTUNITIES_PER_RUN
    )
    time.sleep(GEMINI_PACING_SECONDS)
    events = _discover(EVENT_DISCOVERY_PROMPT, "event", MAX_EVENTS_PER_RUN)
    return opportunities + events


def extract_opportunity(candidate: dict) -> list[dict]:
    """Returns the extracted opportunity field-dicts found on this page —
    almost always zero or one, but can be several when the page turns out to
    be a listing/index of multiple distinct open calls (see
    MAX_ITEMS_PER_OPPORTUNITY_PAGE and the prompt's own instructions above).
    An empty list means nothing extractable, not an error."""
    prompt = render_prompt(
        OPPORTUNITY_EXTRACTION_PROMPT_TEMPLATE,
        url=candidate["url"],
        title=candidate["title"],
    )
    text = call_gemini(
        prompt,
        [
            types.Tool(url_context=types.UrlContext()),
            types.Tool(google_search=types.GoogleSearch()),
        ],
    )
    if not text:
        return []
    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print(
            f"    ! unparseable JSON from opportunity extraction (raw reply started: {text[:200]!r})"
        )
        return []
    grants = parsed.get("grants") or []
    if not grants or not isinstance(grants, list):
        # Gemini explicitly judged this page not worth extracting (per the
        # exclusion rules in the prompt) rather than a technical failure —
        # print a preview so a real run's log says WHY, not just that it
        # happened, which is what actually lets the per-category limits and
        # prompts get tuned against real data.
        print(f"    (Gemini returned no grants; raw reply started: {text[:200]!r})")
        return []
    valid = [g for g in grants if isinstance(g, dict) and g.get("title")]
    return valid[:MAX_ITEMS_PER_OPPORTUNITY_PAGE]


def extract_event(candidate: dict) -> list[dict]:
    """Returns the extracted event field-dicts for this candidate — at most
    one for a single-event candidate, up to MAX_EVENTS_PER_PAGE for a fixed
    events-listing page. An empty list means nothing extractable."""
    prompt = render_prompt(
        EVENT_EXTRACTION_PROMPT_TEMPLATE,
        url=candidate["url"],
        title=candidate["title"],
    )
    text = call_gemini(
        prompt,
        [
            types.Tool(url_context=types.UrlContext()),
            types.Tool(google_search=types.GoogleSearch()),
        ],
    )
    if not text:
        return []
    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print(
            f"    ! unparseable JSON from event extraction (raw reply started: {text[:200]!r})"
        )
        return []
    events = parsed.get("events") or []
    if not events or not isinstance(events, list):
        print(f"    (Gemini returned no events; raw reply started: {text[:200]!r})")
        return []
    valid = [e for e in events if isinstance(e, dict) and e.get("title")]
    is_listing = candidate["title"].startswith("Events listed on")
    return valid[:MAX_EVENTS_PER_PAGE] if is_listing else valid[:1]


CONFERENCE_MILL_TITLE = re.compile(
    r"^(international|global|world)\s+(conference|congress|summit)\s+on\b.*\([A-Z]{2,8}\)\s*$",
    re.IGNORECASE,
)


def looks_like_conference_mill(title: str) -> bool:
    return bool(CONFERENCE_MILL_TITLE.match(str(title).strip()))


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


# Workaround for a gap in grants.title_key / events.title_key: that DB
# column only strips punctuation, so "Some Event" and "Some Event 2026" hash
# to different keys and both get saved — seen in practice with WEF's
# "Sustainable Development Impact Meetings" showing up with and without the
# year across two runs. Rather than change the shared, generated DB column
# (also mirrored in ApplicationTracker.tsx for manual grant entry), catch it
# here: fetch existing titles once per run, loosely normalize the same way
# title_key does PLUS stripping a trailing year, and skip saving anything
# that already matches. Cached per table so repeated candidates in the same
# run don't re-fetch.
_seen_loose_title_keys: dict[str, set[str]] = {}


def _loose_title_key(title: str) -> str:
    stripped = re.sub(r"\s*20\d{2}\s*$", "", str(title).strip())
    return re.sub(r"[^a-z0-9]", "", stripped.lower())


def _is_duplicate_title(table: str, title: str) -> bool:
    if table not in _seen_loose_title_keys:
        keys: set[str] = set()
        try:
            response = requests.get(
                f"{SUPABASE_URL}/rest/v1/{table}",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                },
                params={"select": "title"},
                timeout=30,
            )
            response.raise_for_status()
            keys = {
                _loose_title_key(row["title"])
                for row in response.json()
                if row.get("title")
            }
        except Exception as err:
            print(f"  ! could not check existing {table} titles for duplicates: {err}")
        _seen_loose_title_keys[table] = keys
    return _loose_title_key(title) in _seen_loose_title_keys[table]


def _remember_title(table: str, title: str) -> None:
    _seen_loose_title_keys.setdefault(table, set()).add(_loose_title_key(title))


# Second, fuzzier duplicate check for events only. The loose title key above
# misses the same event saved under different wordings — seen in practice
# with "Carbon Markets Africa Summit" vs "Carbon Markets Africa Summit (CMAS)
# 2026" and "Global Off-Grid Solar Forum & Expo 2026" vs "9th Global Off-Grid
# Solar Forum & Expo", which became common once listing pages started
# yielding several events each. Two events count as the same when they start
# within EVENT_DUPLICATE_DATE_WINDOW_DAYS of each other AND share at least 2
# meaningful title words making up most of the shorter title. Requiring a
# date match keeps genuinely different events with similar names apart.
# Includes discarded rows, so a discarded event isn't re-added under a new
# wording either.
EVENT_DUPLICATE_DATE_WINDOW_DAYS = 3
EVENT_DUPLICATE_MIN_OVERLAP = 0.75

_TITLE_STOPWORDS = {
    "the", "and", "of", "for", "in", "on", "at", "to", "a", "an", "annual",
    "edition", "events", "event",
}

_seen_event_signatures: list[tuple[set[str], object, str]] | None = None


def _title_tokens(title: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", str(title).lower())
    return {
        w
        for w in words
        if w not in _TITLE_STOPWORDS
        and not re.fullmatch(r"\d+(st|nd|rd|th)?", w)  # years, "9th", "11"
    }


def _parse_date(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def _titles_match(a: set[str], b: set[str], min_overlap: float = EVENT_DUPLICATE_MIN_OVERLAP) -> bool:
    if not a or not b:
        return False
    shared = len(a & b)
    return shared >= 2 and shared / min(len(a), len(b)) >= min_overlap


# Looser title agreement needed when organizer AND exact dates already match
# (find_duplicate_event_id): enough for "African Energy Week" vs "Africa
# Energy Week" (2 of 3 words), not for one organizer's parallel events on the
# same days, e.g. "World Climate Summit COP31" vs "World Climate Impact Hub"
# (2 of 4).
EVENT_DUPLICATE_SAME_ORGANIZER_OVERLAP = 0.6


def _is_near_duplicate_event(title: str, start_date) -> str | None:
    """Returns the title of an already-saved event that looks like the same
    one (see comment above), else None."""
    global _seen_event_signatures
    start = _parse_date(start_date)
    if start is None:
        return None
    if _seen_event_signatures is None:
        _seen_event_signatures = []
        try:
            response = requests.get(
                f"{SUPABASE_URL}/rest/v1/events",
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                },
                params={"select": "title,start_date"},
                timeout=30,
            )
            response.raise_for_status()
            _seen_event_signatures = [
                (_title_tokens(row["title"]), _parse_date(row.get("start_date")), row["title"])
                for row in response.json()
                if row.get("title")
            ]
        except Exception as err:
            print(f"  ! could not check existing events for near-duplicates: {err}")
    tokens = _title_tokens(title)
    for other_tokens, other_start, other_title in _seen_event_signatures:
        if other_start is None:
            continue
        if abs((start - other_start).days) > EVENT_DUPLICATE_DATE_WINDOW_DAYS:
            continue
        if _titles_match(tokens, other_tokens):
            return other_title
    return None


def _remember_event(title: str, start_date) -> None:
    global _seen_event_signatures
    if _seen_event_signatures is None:
        _seen_event_signatures = []
    _seen_event_signatures.append((_title_tokens(title), _parse_date(start_date), title))


def save_opportunity(fields: dict, candidate: dict) -> bool:
    """Upsert one extracted opportunity into `grants`, tagged source_type
    'gemini' so the Grant Scanner shows a green pill on it."""
    title = str(fields.get("title") or "").strip()
    if not title:
        return False

    if _is_duplicate_title("grants", title):
        print(
            f"    - skipped (looks like a duplicate already saved, under a different title): {title}"
        )
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
        # title_key, not content_hash — see supabase/dedup_migration.sql. Two
        # sources announcing the same call under different URLs now collapse
        # into one row, and because `discarded` is absent from this payload,
        # re-finding something the user discarded refreshes it without
        # bringing it back to the Grant Scanner.
        params={"on_conflict": "title_key"},
        json=[row],
        timeout=30,
    )
    if not response.ok:
        print(
            f"    ! saving opportunity failed ({response.status_code}): {response.text[:300]}"
        )
        return False
    _remember_title("grants", title)
    print(
        f"    + [opportunity] {title}"
        + (f"  (deadline {fields['deadline']})" if fields.get("deadline") else "")
    )
    return True


def normalize_organizer(name: str | None) -> str:
    """Same spirit as title_key's normalization (supabase/dedup_migration.sql),
    applied to organizer names instead of titles: drops parenthetical
    abbreviations (the "(AEC)" in "African Energy Chamber (AEC)") and all
    non-alphanumeric characters, then lowercases. Lets "African Energy
    Chamber (AEC)" and "African Energy Chamber" compare equal."""
    if not name:
        return ""
    name = re.sub(r"\([^)]*\)", "", name)
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def find_duplicate_event_id(
    organizer: str | None, start_date: str | None, end_date: str | None, title: str = ""
) -> str | None:
    """Looks for an existing `events` row that's almost certainly the same
    real-world event as the one just extracted, even when its title text is
    genuinely different — e.g. "African Energy Week 2026" vs "Africa Energy
    Week 2026", the same African Energy Chamber conference, extracted from
    two different source pages under two slightly different titles. Neither
    title_key nor the title-word check (_is_near_duplicate_event) catches
    that pair: "african" and "africa" are different words.

    Same organizer + identical start_date + identical end_date is a much
    higher-precision "same event" signal than fuzzy title matching — two
    unrelated real events sharing an organizer AND exact matching dates is
    vanishingly unlikely — except for one organizer's parallel events on the
    same days (a summit and its side "hub"), so the titles must also broadly
    agree (EVENT_DUPLICATE_SAME_ORGANIZER_OVERLAP). Requires both an organizer and a start_date;
    returns None (fall through to the normal title_key upsert) when either
    is missing, rather than guessing off partial data.

    Deliberately does NOT filter out already-discarded rows: matching them
    too, and never sending `discarded` in the merge payload (see save_event),
    keeps a discard permanent even across a title change.
    """
    if not organizer or not start_date:
        return None
    org_key = normalize_organizer(organizer)
    if not org_key:
        return None
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/events",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            params={
                "select": "id,organizer,title",
                "start_date": f"eq.{start_date}",
                "end_date": f"eq.{end_date}" if end_date else "is.null",
            },
            timeout=30,
        )
        response.raise_for_status()
    except Exception as err:
        print(f"    ! could not check for duplicate events: {err}")
        return None
    tokens = _title_tokens(title)
    for existing in response.json():
        if normalize_organizer(existing.get("organizer")) == org_key and _titles_match(
            tokens, _title_tokens(existing.get("title") or ""), EVENT_DUPLICATE_SAME_ORGANIZER_OVERLAP
        ):
            return existing["id"]
    return None


def save_event(fields: dict, candidate: dict) -> bool:
    """Upsert one extracted event into the separate `events` table."""
    title = str(fields.get("title") or "").strip()
    if not title:
        return False

    if looks_like_conference_mill(title):
        print(f"    - skipped (looks like a conference-mill listing): {title}")
        return False

    # Prefer the event's own page Gemini reported (essential for events taken
    # from a listing page, which would otherwise all share the listing URL).
    extracted_url = str(fields.get("url") or "").strip()
    url = extracted_url if extracted_url.startswith("http") else candidate["url"]

    start_date_raw = fields.get("start_date")
    if start_date_raw:
        try:
            if datetime.strptime(str(start_date_raw), "%Y-%m-%d").date() < TODAY:
                print(f"    - skipped (event date {start_date_raw} has already passed)")
                return False
        except ValueError:
            pass

    # The loose title key strips a trailing year, so on its own it would treat
    # next year's edition ("Africa Energy Indaba 2027") as a duplicate of this
    # year's ("... 2026") and never save it. When the event has a date, the
    # date-aware check below (_is_near_duplicate_event, which also ignores
    # years in titles) covers the same "with/without the year" case safely —
    # so only fall back to the loose key for undated events.
    if _parse_date(start_date_raw) is None and _is_duplicate_title("events", title):
        print(
            f"    - skipped (looks like a duplicate already saved, under a different title): {title}"
        )
        return False

    same_as = _is_near_duplicate_event(title, start_date_raw)
    if same_as:
        print(f"    - skipped (looks like the same event as already-saved \"{same_as}\"): {title}")
        return False

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
        "fit_analysis": fields.get("fit_analysis"),
        "url": url,
        "content_hash": content_hash(title, url),
        "source_type": "gemini",
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }

    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
    }

    # Same organizer + identical dates under a differently-worded title —
    # almost certainly the same real-world event already saved (see
    # find_duplicate_event_id). Refresh that exact row by id instead of
    # upserting by title_key, which would treat the new wording as a
    # brand-new row. `title` is left out so the row keeps the title it was
    # first saved under, and `discarded` is never sent, so a discard sticks.
    # Its existing relevance score is kept too (no re-classification).
    duplicate_id = find_duplicate_event_id(
        fields.get("organizer"), fields.get("start_date"), fields.get("end_date"), title
    )
    if duplicate_id:
        patch_row = {k: v for k, v in row.items() if k != "title"}
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/events",
            headers=headers,
            params={"id": f"eq.{duplicate_id}"},
            json=patch_row,
            timeout=30,
        )
        if not response.ok:
            print(f"    ! updating duplicate event failed ({response.status_code}): {response.text[:300]}")
            return False
        _remember_title("events", title)
        _remember_event(title, start_date_raw)
        print(f"    - merged into existing entry (same organizer + dates): {title}")
        return False

    # Score it now so it arrives in the Events tab with a relevance badge,
    # rather than waiting for a reclassify_events.py run. A not_relevant event
    # is still saved, but already discarded — that keeps it (and rewordings
    # of it, via the duplicate checks above) from being re-added next run.
    # If scoring fails, save it unscored; reclassify_events.py can fill it in.
    classification = classify_event(
        fields, fields.get("fit_analysis") or fields.get("description") or ""
    )
    not_relevant = False
    if classification:
        row.update(classification)
        not_relevant = classification["relevance_level"] == "not_relevant"
        if not_relevant:
            row["discarded"] = True
            row["discarded_at"] = datetime.now(timezone.utc).isoformat()

    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/events",
        headers=headers,
        # title_key, not content_hash — same reasoning as save_opportunity
        # above, and the same discard-stickiness guarantee for the Events tab.
        params={"on_conflict": "title_key"},
        json=[row],
        timeout=30,
    )
    if not response.ok:
        print(
            f"    ! saving event failed ({response.status_code}): {response.text[:300]}"
        )
        return False
    _remember_title("events", title)
    _remember_event(title, start_date_raw)
    if not_relevant:
        print(
            f"    - saved as discarded (not_relevant: {classification.get('relevance_rationale')}): {title}"
        )
        return False
    print(
        f"    + [event] {title}"
        + (f"  ({fields['start_date']})" if fields.get("start_date") else "")
        + (f"  [{classification['relevance_level']}]" if classification else "")
    )
    return True


# --- Relevance classification --------------------------------------------

def _build_classification_system_prompt() -> str:
    core_list = "\n".join(f"- {t}" for t in CORE_EVENT_TOPICS)
    primary_list = "\n".join(f"- {t}" for t in PRIMARY_EVENT_TOPICS)
    secondary_list = "\n".join(f"- {t}" for t in SECONDARY_EVENT_TOPICS)
    exclusions_list = "\n".join(f"- {e}" for e in RELEVANCE_EXCLUSIONS)
    return f"""You classify a scheduled event against a fixed relevance taxonomy, based on what the event is actually about — not whether its title merely contains a relevant-sounding word. Use the event's location and geography as well as its topic.

Core topics (the company's central business):
{core_list}

Primary topics:
{primary_list}

Secondary / strategic topics:
{secondary_list}

Relevance levels:
- high: {RELEVANCE_LEVELS.get('high', '')}
- medium: {RELEVANCE_LEVELS.get('medium', '')}
- low: {RELEVANCE_LEVELS.get('low', '')}
- not_relevant: {RELEVANCE_LEVELS.get('not_relevant', '')}

Exclusions — an event matching ANY of these is "not_relevant", whatever its topic:
{exclusions_list}

Respond with ONLY a JSON object — no markdown fences, no explanation before or after — of the shape:
{{
  "core_topics": string[],        // subset of the core topic list above this event substantively covers; [] if none
  "primary_topics": string[],     // subset of the primary topic list above this event substantively covers; [] if none
  "secondary_topics": string[],   // subset of the secondary topic list above; [] if none
  "relevance_level": "high" | "medium" | "low" | "not_relevant",
  "rationale": string              // 1-2 sentences, grounded in the event's actual content, explaining the level
}}"""


CLASSIFICATION_SYSTEM_PROMPT = _build_classification_system_prompt()


def _normalize_topics(topics, allowed: list[str]) -> list[str]:
    allowed_lookup = {t.lower(): t for t in allowed}
    return [allowed_lookup[str(t).lower()] for t in (topics or []) if str(t).lower() in allowed_lookup]


def classify_event(fields: dict, raw_text: str) -> dict | None:
    """Scores one event's relevance against config/taxonomy.yaml. Returns
    None on a request/parse failure — callers should treat that as "skip",
    not as a not_relevant verdict."""
    content = (
        f"Title: {fields.get('title')}\n"
        f"Location: {fields.get('location')}\n"
        f"Geography: {fields.get('geography')}\n"
        f"Description: {fields.get('description')}\n"
        f"Excerpt: {raw_text[:4000]}"
    )
    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=content,
            config=types.GenerateContentConfig(
                system_instruction=CLASSIFICATION_SYSTEM_PROMPT,
                response_mime_type="application/json",
            ),
        )
        text = response.text or "{}"
    except genai_errors.APIError as err:
        print(f"    ! Gemini classification request failed: {err}")
        return None

    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print(f"    ! unparseable JSON from classification (raw reply started: {text[:200]!r})")
        return None

    relevance_level = parsed.get("relevance_level")
    if relevance_level not in RELEVANCE_LEVEL_VALUES:
        # Treat a malformed answer as a failure ("skip"), not as a
        # not_relevant verdict — the latter would discard the event.
        print(f"    ! unexpected relevance_level from classification: {relevance_level!r}")
        return None

    return {
        "core_topics": _normalize_topics(parsed.get("core_topics"), CORE_EVENT_TOPICS),
        "primary_topics": _normalize_topics(parsed.get("primary_topics"), PRIMARY_EVENT_TOPICS),
        "secondary_topics": _normalize_topics(parsed.get("secondary_topics"), SECONDARY_EVENT_TOPICS),
        "relevance_level": relevance_level,
        "relevance_rationale": parsed.get("rationale"),
    }


def main() -> None:
    print("Gemini discovery — searching for candidate opportunities and events")

    saved_opportunities = 0
    saved_events = 0

    # Fixed sources first: specific funder pages checked on every run
    # regardless of what the broad search below happens to surface — see
    # FIXED_OPPORTUNITY_SOURCES above for why these bypass seen_urls().
    if FIXED_OPPORTUNITY_SOURCES:
        print(
            f"\nChecking {len(FIXED_OPPORTUNITY_SOURCES)} fixed opportunity source(s)"
        )
        for source in FIXED_OPPORTUNITY_SOURCES:
            print(f"  → [fixed] {source['title'][:70]}")
            fields_list = extract_opportunity(source)
            if not fields_list:
                print("    - nothing extractable; skipped")
            for fields in fields_list:
                if save_opportunity(fields, source):
                    saved_opportunities += 1
            time.sleep(GEMINI_PACING_SECONDS)

    # Fixed event sources: known events-listing pages checked on every run —
    # see FIXED_EVENT_SOURCES above for why these bypass seen_urls() too.
    if FIXED_EVENT_SOURCES:
        print(f"\nChecking {len(FIXED_EVENT_SOURCES)} fixed event source(s)")
        for source in FIXED_EVENT_SOURCES:
            print(f"  → [fixed] {source['title'][:70]}")
            fields_list = extract_event(source)
            if not fields_list:
                print("    - nothing extractable; skipped")
            for fields in fields_list:
                if save_event(fields, source):
                    saved_events += 1
            time.sleep(GEMINI_PACING_SECONDS)

    candidates = discover_candidates()
    print(f"\n{len(candidates)} candidate(s) found via search")

    fresh = []
    if candidates:
        already = seen_urls([c["url"] for c in candidates])
        fresh = [c for c in candidates if c["url"] not in already]
        print(
            f"{len(fresh)} new candidate(s) to extract ({len(candidates) - len(fresh)} seen before)"
        )

    for candidate in fresh:
        print(f"  → [{candidate['kind']}] {candidate['title'][:70]}")
        if candidate["kind"] == "opportunity":
            fields_list = extract_opportunity(candidate)
            if not fields_list:
                print("    - nothing extractable; skipped")
            for fields in fields_list:
                if save_opportunity(fields, candidate):
                    saved_opportunities += 1
        else:
            fields_list = extract_event(candidate)
            if not fields_list:
                print("    - nothing extractable; skipped")
            for fields in fields_list:
                if save_event(fields, candidate):
                    saved_events += 1
        time.sleep(GEMINI_PACING_SECONDS)

    print(
        f"\nDone. {saved_opportunities} opportunity/ies added to the Grant Scanner, "
        f"{saved_events} event(s) added to the Events tab."
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
