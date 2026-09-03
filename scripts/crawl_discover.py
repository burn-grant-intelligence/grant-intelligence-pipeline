"""
Crawl-based opportunity discovery.

Walks a rotating subset of funder websites, looking for pages that read like a
real open funding call (not news, not a press release), and drops the URLs into
the `crawl_queue` table in Supabase. The Node scanner (scripts/scan.mjs) then
picks those URLs up on its next run and does the usual fetch + Groq extraction.

This exists as a free alternative to the Google Custom Search discovery step:
instead of asking Google what's on these sites, we walk the sites ourselves.

Run locally:  python scripts/crawl_discover.py
Runs in CI:   see .github/workflows/crawl-discover.yml
"""

import asyncio
import os
import sys
from datetime import datetime, timezone

import requests
from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.deep_crawling import BestFirstCrawlingStrategy
from crawl4ai.deep_crawling.filters import (
    ContentTypeFilter,
    DomainFilter,
    FilterChain,
    URLPatternFilter,
)
from crawl4ai.deep_crawling.scorers import KeywordRelevanceScorer

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# Extra sites to walk beyond whatever is in the `sources` table — useful for a
# site you want crawled but haven't (or won't) register as a formal scan source.
# Usually this should just be empty; add rows to `sources` in Supabase instead,
# since that keeps one single list that both the scanner and the crawler read.
EXTRA_SITES = []

# How deep to follow links per site, and how many pages to visit before
# stopping. Based on a real test run (57 pages across 3 sites in 28 seconds),
# there's plenty of headroom here — these caps exist to keep any one
# unusually large site from eating the whole run, not because of a real
# time constraint.
MAX_DEPTH = 2
MAX_PAGES_PER_SITE = 25

# Words that make a URL look worth following/scoring highly during the crawl.
CRAWL_KEYWORDS = [
    "grant", "grants", "funding", "fund", "opportunity", "opportunities",
    "call", "proposals", "rfp", "rfa", "eoi", "tender", "apply",
    "application", "challenge", "financing",
]

# Skip obvious non-opportunity sections outright.
SKIP_URL_PATTERNS = [
    "*/news/*", "*/press*", "*/blog/*", "*/events/*", "*/team/*",
    "*/careers/*", "*/jobs/*", "*/privacy*", "*/terms*", "*/login*",
    "*/media/*", "*/stories/*", "*/newsletter*", "*/tag/*", "*/category/*",
]

# A page only makes the queue if it reads like an actual open call: it has to
# mention a timing signal AND an eligibility signal. This is the same principle
# as the press-release exclusion in scan.mjs's extraction prompt — a news story
# about a fund existing is not that fund's own call for applications.
TIMING_SIGNALS = [
    "deadline", "closing date", "closes on", "apply by", "submission date",
    "submit by", "rolling basis", "applications close", "expires",
]
ELIGIBILITY_SIGNALS = [
    "eligibility", "eligible", "who can apply", "criteria", "requirements",
    "qualify", "applicants must",
]
APPLY_SIGNALS = [
    "how to apply", "apply now", "submit your", "application form",
    "application process", "call for", "request for",
]

# A handful of the sources we crawl are broad, multi-sector development-bank
# procurement portals (World Bank, AfDB, EBRD, EIB, UNGM, UNDP...) that publish
# tenders for everything from IT systems to road construction, not just clean
# cooking / energy. Without a topic check, those sites would flood the queue
# with real-but-irrelevant tenders. So a page only qualifies if it *also*
# mentions something in BURN's actual space.
TOPIC_SIGNALS = [
    "cooking", "cookstove", "cook stove", "stove", "biomass", "lpg",
    "clean energy", "renewable energy", "energy access", "off-grid",
    "off grid", "mini-grid", "mini grid", "solar", "sustainable energy",
    "energy efficiency", "electrification", "carbon credit", "carbon market",
    "climate finance", "climate change", "emissions", "sdg7", "sdg 7",
    "clean cooking", "household energy", "fuel efficient",
]


def fetch_active_sites() -> list[str]:
    """Pull every active source's URL from the same `sources` table the regular
    scanner reads, so the crawler automatically covers whatever you've already
    added to the app — no separate list to keep in sync."""
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/sources",
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            params={"select": "url", "active": "eq.true"},
            timeout=30,
        )
        response.raise_for_status()
        urls = [row["url"] for row in response.json() if row.get("url")]
    except Exception as err:
        print(f"! Failed to fetch sources from Supabase: {err}")
        urls = []

    combined = list(dict.fromkeys(urls + EXTRA_SITES))  # de-dupe, keep order
    return combined


def looks_like_open_call(text: str) -> bool:
    """Cheap pre-filter so we don't queue up news articles for the LLM to chew on."""
    if not text:
        return False
    lowered = text.lower()
    if len(lowered) < 400:
        return False
    has_timing = any(signal in lowered for signal in TIMING_SIGNALS)
    has_eligibility = any(signal in lowered for signal in ELIGIBILITY_SIGNALS)
    has_apply = any(signal in lowered for signal in APPLY_SIGNALS)
    has_topic = any(signal in lowered for signal in TOPIC_SIGNALS)
    return has_timing and (has_eligibility or has_apply) and has_topic


def queue_urls(rows: list[dict]) -> int:
    """Upsert discovered URLs into crawl_queue. Existing URLs are left alone."""
    if not rows:
        return 0
    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/crawl_queue",
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
        print(f"  ! supabase insert failed ({response.status_code}): {response.text[:300]}")
        return 0
    return len(response.json())


async def crawl_site(crawler: AsyncWebCrawler, seed_url: str) -> list[dict]:
    domain = seed_url.split("/")[2]

    strategy = BestFirstCrawlingStrategy(
        max_depth=MAX_DEPTH,
        max_pages=MAX_PAGES_PER_SITE,
        include_external=False,
        url_scorer=KeywordRelevanceScorer(keywords=CRAWL_KEYWORDS, weight=1.0),
        filter_chain=FilterChain([
            DomainFilter(allowed_domains=[domain]),
            ContentTypeFilter(allowed_types=["text/html"]),
            URLPatternFilter(patterns=SKIP_URL_PATTERNS, reverse=True),
        ]),
    )

    config = CrawlerRunConfig(
        deep_crawl_strategy=strategy,
        cache_mode=CacheMode.BYPASS,
        stream=False,
        page_timeout=30000,
        verbose=False,
    )

    print(f"\n→ crawling {seed_url}")
    try:
        results = await crawler.arun(url=seed_url, config=config)
    except Exception as err:  # a dead site shouldn't kill the whole run
        print(f"  ! crawl failed: {err}")
        return []

    hits = []
    for result in results:
        if not result.success:
            continue
        markdown = getattr(result.markdown, "raw_markdown", "") or ""
        if looks_like_open_call(markdown):
            hits.append({
                "url": result.url,
                "source_domain": domain,
                "discovered_at": datetime.now(timezone.utc).isoformat(),
                "status": "pending",
            })

    print(f"  visited {len(results)} pages, {len(hits)} look like open calls")
    return hits


async def main() -> None:
    sites = fetch_active_sites()
    print(f"Crawl discovery — {len(sites)} site(s) this run")
    if not sites:
        print("No active sites found (sources table empty, or the request failed). Nothing to do.")
        return

    browser_config = BrowserConfig(headless=True, verbose=False)
    all_hits: list[dict] = []

    async with AsyncWebCrawler(config=browser_config) as crawler:
        for site in sites:
            all_hits.extend(await crawl_site(crawler, site))

    # De-dupe within this run before sending to Supabase.
    unique = {row["url"]: row for row in all_hits}
    queued = queue_urls(list(unique.values()))

    print(f"\nDone. {len(unique)} candidate URL(s) found, {queued} newly queued.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(1)
