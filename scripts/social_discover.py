"""
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
"""

import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BRIGHTDATA_API_KEY = os.environ["BRIGHTDATA_API_KEY"]
GROQ_API_KEY = os.environ["GROQ_API_KEY"]

# Bright Data's "LinkedIn posts" dataset. Confirmed working against a real
# company page with type=discover_new & discover_by=company_url.
DATASET_ID = "gd_lyy3tktm25m4avu764"
SCRAPE_URL = "https://api.brightdata.com/datasets/v3/scrape"
PROGRESS_URL = "https://api.brightdata.com/datasets/v3/progress"
SNAPSHOT_URL = "https://api.brightdata.com/datasets/v3/snapshot"

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-20b"

# --- Cost / noise controls -------------------------------------------------
POSTS_PER_COMPANY = 10
MAX_AGE_DAYS = 45

POLL_INTERVAL_SECONDS = 15
POLL_MAX_ATTEMPTS = 20

# --- What counts as an opportunity ----------------------------------------
# Deliberately narrow: only real solicitations. Loose words like "funding" or
# "grant" on their own are NOT enough — a funder saying "we granted $2m to X"
# is not something you can apply to.
SOLICITATION_SIGNALS = [
    "request for proposal", "request for proposals", "rfp", "rfq",
    "request for quotation", "request for application", "rfa",
    "expression of interest", "expressions of interest", "eoi",
    "call for proposal", "call for proposals", "call for application",
    "call for applications", "call for solutions", "call for innovation",
    "call for innovations", "call for expression", "call for tender",
    "call for tenders", "invitation to tender", "invitation to bid",
    "invitation for bids", "new tender", "open tender", "tender notice",
    "terms of reference", "prequalification", "pre-qualification",
    "procurement notice", "challenge fund", "funding call",
    "applications are open", "applications are now open", "now accepting applications",
    "call for consultants", "consultancy opportunity", "seeking a consultant",
    "seeking consultants", "seeking proposals", "seeking applications",
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
- Track record: 7.4M+ stoves sold, 37.5M+ lives impacted, 56.7K+ jobs created since 2013, 81M+ tons of CO2 reduced.
- Geography: operates across 20+ African countries (home delivery in 9, B2B sales in 8, call centers in 10, carbon projects in 10).
- Carbon finance: a vertically integrated carbon project developer, 5M+ carbon credits issued, certified by Gold Standard and MMECD — strong fit for carbon finance, results-based financing, and climate-linked funding.
- Distribution: an established last-mile distribution network across its countries of operation.
- Gender: products and programs center women as primary household cooking-fuel decision-makers and beneficiaries.
- Funding BURN typically seeks: grants, catalytic/concessional funding, results-based financing, R&D funding, and scale-up/working capital. BURN is generally NOT a fit for micro-loans or funding explicitly reserved for small/early-stage/first-time operators.
- Strong-fit program patterns: results-based financing (RBF) programs for clean cooking, calls for proposals / "Call4Solutions" / tenders specifically for cookstove distribution or manufacturing, institutional and school-cooking programs, and higher-tier/modern eCooking scale-up programs.
- Agriculture is generally NOT a fit: BURN is a clean cookstove company, not an agriculture company. Funding primarily for on-farm equipment, agricultural inputs, crop or livestock production, agri-processing, or farm-level energy systems is a poor fit — even if it touches climate or energy — UNLESS it specifically funds clean cookstove manufacturing or distribution."""

EXTRACTION_SYSTEM_PROMPT = f"""You extract a structured, OPEN funding or procurement opportunity from the text of a LinkedIn post, and assess how well it fits BURN Manufacturing, a specific company described below.

{BURN_PROFILE}

The text you are given is a LinkedIn post published by a funder, development programme or foundation. It has already been screened as looking like a solicitation. Your job is to turn it into structured data.

Respond with ONLY a JSON object — no markdown code fences, no explanation before or after — of the shape:
{{ "grants": [ {{ ... }} ] }}

Each item must have exactly these fields (use null for anything not stated — never guess or invent values):
{{
  "title": string,
  "funder": string | null,
  "amount": number | null,
  "currency": string | null,
  "deadline": string | null,        // ISO date "YYYY-MM-DD" only if a specific date is stated. A post saying "open until 23.55 BST on Tuesday 15 September 2026" means "2026-09-15".
  "geography": string | null,
  "focus_areas": string[],          // choose from: clean energy, clean cooking, climate change, GHG reduction, energy transition, deforestation, manufacturing, women/gender, tech & innovation, engineering, AI/data
  "eligibility": string | null,
  "description": string | null,     // 1-2 sentence neutral summary of the opportunity itself
  "application_url": string | null, // the outbound link where you apply, if the post states one
  "fit_analysis": string | null     // 2-4 sentences assessing how well THIS opportunity fits BURN specifically
}}

Rules for "fit_analysis":
- Write it as an analyst briefing BURN's grants team, not marketing copy.
- Reference concrete matching points from the profile above where they apply: geography overlap, product/fuel-type match, carbon finance or gender-program fit, or distribution-network relevance.
- If something looks like a MISMATCH, say so plainly — e.g. it targets operators far smaller than BURN's scale, the geography excludes BURN's countries, it is an equity investment rather than a grant, or it is a consultancy/advisory assignment rather than funding for BURN's own operations.
- If the post gives too little detail to judge fit, set this field to null rather than guessing.

Return {{ "grants": [] }} — i.e. extract nothing — if the post is:
- Announcing that someone has ALREADY won, received or been awarded funding.
- A recap of an event, conference, webinar or partnership, even if funding is mentioned.
- A job vacancy for an individual employee (a staff role), rather than a tender, consultancy assignment or funding call open to organisations.
- An opportunity whose stated deadline has clearly already passed.
- Primarily an agriculture, forestry or land-use opportunity — farming, crops, livestock, irrigation, agri-processing, agroforestry, reforestation/afforestation, tree planting, REDD+, land restoration, biodiversity or conservation — even where climate or energy is mentioned. BURN's scope is clean cooking, cookstoves, clean energy and energy transition, and carbon markets. An efficient-cookstove programme that cites reduced deforestation as a co-benefit IS in scope; a forestry or land-restoration programme is not.

Otherwise extract exactly one item describing the opportunity."""


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
    """Narrow gate: a real, time-bound, on-topic call for applications."""
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
        and any(signal in text for signal in TIMING_SIGNALS)
        and any(signal in text for signal in TOPIC_SIGNALS)
    )


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

        age = post_age_days(record)
        if age is not None and age > MAX_AGE_DAYS:
            continue
        if not is_solicitation(record):
            continue

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


def extract_json_object(text: str) -> str:
    """Pull the first {...} block out of the model's reply, in case it wraps
    the JSON in prose or code fences despite instructions."""
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


def extract_opportunity(post: dict) -> dict | None:
    """Run one post through Groq and get structured opportunity fields back."""
    body = "\n\n".join(filter(None, [
        f"Posted by: {post.get('author_name') or 'Unknown'}",
        f"Posted on: {post.get('posted_at') or 'Unknown'}",
        f"Headline: {post.get('headline') or ''}",
        f"Post:\n{post.get('post_text') or ''}",
        f"Links in the post: {', '.join(post['post_links'])}" if post["post_links"] else "",
    ]))

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
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
    except Exception as err:
        print(f"    ! Groq request failed: {err}")
        return None

    try:
        parsed = json.loads(extract_json_object(content))
    except (json.JSONDecodeError, TypeError):
        print("    ! Groq returned unparseable JSON; skipping this post")
        return None

    grants = parsed.get("grants") or []
    if not grants or not isinstance(grants, list):
        return None
    fields = grants[0]
    return fields if isinstance(fields, dict) and fields.get("title") else None


def content_hash(title: str, url: str) -> str:
    """Same hash scan.mjs uses, so a post and a scraped page describing the same
    opportunity collapse into one row instead of duplicating."""
    return hashlib.sha256(f"{title}::{url or ''}".lower().encode("utf-8")).hexdigest()


def save_grant(fields: dict, post: dict) -> bool:
    """Upsert one extracted opportunity into `grants`, flagged as LinkedIn-sourced
    and priority so it sorts to the top of the Grant Scanner."""
    application_url = (
        fields.get("application_url")
        or (post["post_links"][0] if post["post_links"] else None)
        or post["post_url"]
    )
    title = str(fields.get("title") or "").strip()
    if not title:
        return False

    row = {
        "title": title,
        "funder": fields.get("funder") or post.get("author_name"),
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
        "source_type": "linkedin",
        "priority": 1,
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
        print(f"    ! saving grant failed ({response.status_code}): {response.text[:300]}")
        return False
    print(f"    + {title}"
          + (f"  (deadline {fields['deadline']})" if fields.get("deadline") else ""))
    return True


def log_posts(rows: list[dict]) -> int:
    """Keep a record of every post we processed, so we never pay to scrape or
    re-extract the same one twice."""
    if not rows:
        return 0
    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/social_posts",
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,return=representation",
        },
        json=rows,
        timeout=30,
    )
    if not response.ok:
        print(f"! logging posts failed ({response.status_code}): {response.text[:300]}")
        return 0
    return len(response.json())


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

    if not candidates:
        print("\nDone. No new solicitations found.")
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


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
