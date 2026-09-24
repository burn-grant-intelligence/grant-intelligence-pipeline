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
import re
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
# social_discover.py. Opportunities and events are capped SEPARATELY (each
# category has its own budget below) rather than sharing one combined pool —
# events are deliberately given a much bigger allowance since they don't need
# the tight company-fit judgment opportunities do (see PRIMARY_EVENT_TOPICS/
# SECONDARY_EVENT_TOPICS below),
# and this is meant to surface as many relevant events as genuinely exist,
# not just fill a shared quota that opportunities would otherwise crowd out.
MAX_OPPORTUNITIES_PER_RUN = 15
MAX_EVENTS_PER_RUN = 25

# A fixed-source page (see FIXED_OPPORTUNITY_SOURCES below) can be a listing
# of several distinct open calls rather than a single opportunity — this
# caps how many of those Gemini may extract from any one page in a single
# call, so a large listing page can't blow up run time or produce a wall of
# near-duplicate items.
MAX_ITEMS_PER_OPPORTUNITY_PAGE = 5

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

# Specific funder/program pages BURN wants checked on every single run,
# rather than left to chance via discover_candidates()'s broad Google-search
# grounding above — a niche funder's own page may simply never surface for
# generic topic searches even when it's a strong, known fit. Added
# 2026-09-18 per user request, mirroring the fixed `sources` table
# scan.mjs/crawl_discover.py already read from for the Groq pipeline; this
# is the Gemini pipeline's own small, hardcoded equivalent.
#
# Unlike discover_candidates()'s results, these are NOT filtered by
# seen_urls() in main() — they're re-extracted every run, since the page
# itself can change over time (a listing page gaining a new call, a
# single-call page's deadline moving). The title-based dedup in
# save_opportunity() (on_conflict=title_key) already prevents an unchanged,
# already-saved opportunity from duplicating — it just refreshes
# last_seen_at.
#
# Each entry's "title" is a human label for logging, not literally the
# expected opportunity's title — extract_opportunity()'s prompt treats it as
# a loose hint the way it already does for discover_candidates()'s guesses.
FIXED_OPPORTUNITY_SOURCES = [
    {
        "title": "Africa-Europe Innovation Platform — Funding Opportunities",
        "url": "https://www.africaeuropeinnovation.net/funding-opportunities/",
    },
    {
        "title": "LEAP ENERGY — AU-EU Partnership Call for Funding",
        "url": "https://leap-energy.eu/call-funding",
    },
    {
        "title": "Mitigation Action Facility — Call for Projects 2026",
        "url": "https://mitigation-action.org/call-for-projects-2026/#application",
    },
    {
        "title": "FOREST Partnership — FOREST Pathways Joint Call 2026",
        "url": "https://forest-partnership.eu/jointcall2026/",
    },
]

# Deliberately broader than BURN_PROFILE's own fit criteria — events are a
# lightweight visibility/networking feature, not something that needs to
# pass the same company-fit bar as a funding opportunity, so this list is
# topic-only. Split into two tiers per explicit user feedback after reviewing
# actual results in the Events tab: PRIMARY is the core sector list (search
# this thoroughly, first); SECONDARY widens coverage but should not crowd out
# primary-topic events — see how these are used in DISCOVERY_PROMPT below.
PRIMARY_EVENT_TOPICS = [
    "carbon markets",
    "climate",
    "clean cooking",
    "energy",
    "development finance",
    "environmental, social and governance (ESG)",
    "sustainability",
]
SECONDARY_EVENT_TOPICS = [
    "climate technology and innovation",
    "impact investment",
    "gender and inclusive development",
    "Africa / emerging-market development",
]
# Removed "nature / environmental markets (carbon credits, biodiversity
# credits, ecosystem-service markets)" per explicit user feedback after
# reviewing actual Events tab results — even framed around "market
# mechanisms," this topic was the direct source of biodiversity/conservation
# events slipping through. Biodiversity is a different focus area from
# BURN's clean cooking / carbon-market-for-cookstoves business; see the
# blanket biodiversity exclusion below, which now excludes it regardless of
# framing rather than only excluding "conservation policy" summits.

# Country priority order, per explicit user request — search (and the Events
# tab displays) in this order, then broader Africa-wide events, then
# international ones. Keep this list in sync with GEOGRAPHY_PRIORITY in
# components/EventsScanner.tsx — same order, same reasoning.
EVENT_GEOGRAPHY_PRIORITY = [
    "Kenya",
    "Tanzania",
    "Ghana",
    "Zambia",
    "Nigeria",
    "Malawi",
    "Mozambique",
    "Rwanda",
    "Burundi",
    "Ethiopia",
    "Ivory Coast",
]

DISCOVERY_PROMPT = f"""Today's date is {TODAY.isoformat()}. Use Google Search to find CURRENTLY OPEN / UPCOMING items relevant to the company described below, across two SEPARATE categories, each with its OWN limit — filling one category does not reduce the other's limit.

{BURN_PROFILE}

CATEGORY "opportunity" — up to {MAX_OPPORTUNITIES_PER_RUN} items: a genuine, currently open funding or procurement call — an RFP, EOI, "Call for Solutions", call for proposals, tender, results-based financing call, or similar. Topics: clean cooking, cookstoves, clean/renewable energy, energy access, energy transition, carbon credits/carbon markets, climate finance. Lean broad here at the discovery stage — a detailed fit assessment happens later, per item, so when a topically-relevant opportunity's exact fit is unclear at this stage, include it rather than filtering it out now.

Do NOT surface as an "opportunity", even if a search result technically uses grant/funding-call language:
- Anything outside clean cooking, energy, climate, or carbon-markets BY SECTOR — e.g. global health / public health / medical calls (including sexual and reproductive health), biotechnology or life-sciences research calls, agriculture (see the profile's own agriculture exclusion above), or any other unrelated industry. A generic "call for proposals", "open call", or "network projects" framing does not make an off-sector call relevant — judge by what the funding is actually FOR, not the shape of the call.
- A call to recruit individual consultants, evaluators, or experts onto a roster/pool for a program that already exists — e.g. an "Open Roster of Expert Practitioners" or similar expert-recruitment call. This is procurement of PEOPLE, not funding for a company's own operations, even when the program itself (clean cooking, eCooking, etc.) is squarely on-topic.
- A request for proposals to evaluate, audit, or review an EXISTING funded program on behalf of its funder or implementer — e.g. a "Mid-Term Evaluation" or "Terminal Evaluation" RFP. This funds an assessment of someone else's program, not the company's own manufacturing or distribution work.

CATEGORY "event" — up to {MAX_EVENTS_PER_RUN} items: a genuine, upcoming (not already past) industry event — a conference, summit, forum, webinar, or trade show — NOT a funding call, NOT a news article about a past event. Events do NOT need to match the company profile as tightly as opportunities do (this is for general visibility/networking).

Search these PRIMARY topics thoroughly first — this is a high season for this kind of event, so actively look across all of them rather than stopping at the first few you find:
{chr(10).join(f"- {topic}" for topic in PRIMARY_EVENT_TOPICS)}

Once you've covered the primary topics well, use any remaining budget on these SECONDARY topics too — genuinely relevant secondary-topic events are still worth including, but don't let them crowd out primary-topic events if you have to choose:
{chr(10).join(f"- {topic}" for topic in SECONDARY_EVENT_TOPICS)}

GEOGRAPHIC PRIORITY — search for events in this order, and don't stop after the first country or two:
1. Events actually held in, or specifically focused on, these countries, searched IN THIS EXACT ORDER — actively search for each one by name rather than only taking what turns up incidentally:
{chr(10).join(f"   {i}. {country}" for i, country in enumerate(EVENT_GEOGRAPHY_PRIORITY, start=1))}
2. Once those are covered, Africa-wide or multi-country African events (not tied to one specific country above).
3. Only then, international / global events with no particular African focus.
This ordering is about search priority and effort, not a hard filter — a strong international event is still worth including, just after you've made a genuine effort on 1 and 2 above.

Do NOT include, even if a keyword above technically matches:
- Generic diplomatic/policy commemorations, anniversaries, or broad multilateral/macroeconomic summits that aren't a concrete clean-energy/climate/carbon-markets industry conference a company would actually attend for business purposes — e.g. a "High-Level Meeting to Commemorate the Nth Anniversary of [a Declaration]", the IMF/World Bank Annual Meetings, WEF Davos, or a G7/G20 finance-ministers meeting. These technically touch "development finance" but are broad global-economy events, not a clean cooking/climate/carbon-markets industry event.
- General food-system, agriculture, or nutrition events (e.g. a "World Food Forum") — same rationale as the agriculture exclusion for opportunities above, unless the event is specifically about clean-cooking fuel or technology.
- A narrow, single-fuel-or-technology industry trade event with no real connection to clean cooking, climate finance, or carbon markets — e.g. a generic LPG/"Liquid Gas Week"-style conference, or a solar-power/photovoltaic-specific event (e.g. "Solar Power Africa", "Intersolar"). BURN's core products are cooking appliances (LPG, biomass, electric induction, ethanol, charcoal) and carbon credits, not solar power generation — a solar-only event is a different niche even though solar is adjacent "clean energy".
- Anything primarily about biodiversity, ecosystem services, or nature conservation — even if it uses market/credit language (e.g. "biodiversity credits"). This is a different focus area from BURN's clean cooking and carbon-market business; exclude it regardless of framing, not just general-conservation-policy summits.
- A carbon-markets/climate/energy event that is explicitly regional to a single NON-African market with no stated Africa or emerging-market relevance — e.g. "Carbon Unbound North America", a US- or EU-only carbon-trading conference. BURN's operations, carbon projects, and target audience are Africa-based, so a region-locked non-Africa event has little practical value even when the sector matches exactly. This is different from a genuinely global/international event (e.g. a worldwide climate summit) — the geographic-priority note above already says those are still fine to include, just lower priority than Africa-focused ones.
- An academic or scientific RESEARCH conference — a university- or academic-society-run event where the core activity is researchers presenting papers, not a business/industry event with a corporate, funder, investor, or policy audience — e.g. a "[Nth] International Conference on [Topic] Monitoring/Remediation/Research" style event, an IEEE/academic-proceedings conference, or a university department's own symposium. This applies EVEN IF the paper topics technically overlap (environmental pollution, climate science, energy research) — BURN is a manufacturer looking for business/networking value, not academic research dissemination. A genuinely mixed industry+research summit with clear corporate/policy participation (not just a call for academic papers) is still fine.

Do NOT pad the list to reach the event limit. If, after a genuine search across the geographic priority order above, you only find a modest number of strong-fit events, return that smaller number rather than filling remaining slots with weak-fit, off-topic, or exclusion-adjacent events just to approach the {MAX_EVENTS_PER_RUN} limit — a shorter list of real matches is much more useful than a longer list padded with noise. This especially applies once you've moved past BURN's priority countries and general Africa — treat international/non-African events as optional bonus items, included only when they are a clear, strong fit on their own merits, not as filler.

Respond with ONLY a JSON object (no markdown fences, no prose before or after) of the shape:
{{ "candidates": [ {{ "kind": "opportunity" | "event", "title": string, "url": string, "why_relevant": string }} ] }}

Rules:
- "url" must be the actual source page you found via search — never invent or guess a URL.
- Skip anything whose deadline or event date is clearly before {TODAY.isoformat()}.
- Skip news recaps of funding already awarded, and recaps of events that already happened.
- Do not list the same underlying opportunity or event twice under different URLs OR under slightly different title wording — e.g. "African Energy Week 2026" and "Africa Energy Week 2026" naming the same conference, by the same organizer, on the same dates. Recognize these as ONE candidate, not two, even if your search turned up a separate page for each.
- Each category's limit is independent — a full "event" category does not reduce how many "opportunity" items you can return, and vice versa.
- It's fine to return fewer than a category's limit, or zero for a category, if that's genuinely all that qualifies.

If nothing qualifies at all, respond with exactly: {{ "candidates": [] }}"""

OPPORTUNITY_EXTRACTION_PROMPT_TEMPLATE = f"""Read the page at the URL below using your url_context tool, then extract a structured, OPEN funding or procurement opportunity from it, and assess how well it fits the company described below.

You also have Google Search available. The URL below often comes from a search-grounding redirect rather than the funder's own page, so it sometimes lands on the wrong thing — a general press-release index, a news list, a category/homepage, or a page that fails to load — instead of the specific "{{title}}" item. If url_context does not show you the specific opportunity itself (not a list, not an unrelated page, not empty/broken), use Google Search to find the correct, specific page for "{{title}}" — search by its name and, if known, its funder — then read THAT page with url_context instead of giving up. Only fall back to an empty result if, after actually trying to search for and read the specific page, you still cannot find real, extractable content about it.

Today's date is {TODAY.isoformat()}. Use this — not any date you might otherwise assume — whenever you need to judge whether a stated deadline has already passed.

{BURN_PROFILE}

URL to read first: {{url}}
This page was already flagged as a likely "{{title}}" opportunity — confirm or correct that from the actual page content (or from the specific page you find via search, per above).

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

A human reviews every opportunity you extract in the Grant Scanner before deciding whether to pursue it, and can discard anything irrelevant with one click. So lean toward EXTRACTING a genuine, open, on-topic funding/procurement opportunity even when: the company-fit looks partial, uncertain, or even like a real mismatch (e.g. it needs an accredited intermediary, targets a different tier of operator, or only partially overlaps the profile's geography or focus) — note that plainly in fit_analysis instead of returning nothing; or some secondary field (amount, exact deadline, eligibility) is thin or unstated — use null for that field rather than skipping the whole item. Only return {{{{ "grants": [] }}}} for one of the specific structural reasons listed below, never merely because fit looks weak or details are incomplete.

Return {{{{ "grants": [] }}}} — i.e. extract nothing — if the page is:
- Announcing that someone has ALREADY won, received or been awarded funding.
- A recap of an event, conference, webinar or partnership, even if funding is mentioned.
- A job vacancy for a permanent or fixed-term STAFF employee, rather than a competitively tendered consultancy.
- Advertising a paid course, training programme, certification, workshop, webinar or masterclass — not a grant, tender or funding opportunity that provides money or a contract TO the company.
- An opportunity whose stated deadline is before {TODAY.isoformat()} (today).
- Primarily an agriculture, forestry or land-use opportunity, even where climate or energy is mentioned.
- Outside clean cooking, energy, climate, or carbon-markets BY SECTOR — e.g. global health / public health / medical funding (including sexual and reproductive health), biotechnology or life-sciences research calls, or any other industry unrelated to the company's business — even when it is a genuine, open, well-run funding call on its own terms.
- A call to recruit individual consultants, evaluators, or experts onto a roster/pool for a program that already exists (e.g. an "Open Roster of Expert Practitioners") — this procures PEOPLE, not funding for the company's own operations, regardless of how on-topic the underlying program is.
- A request for proposals to evaluate, audit, or review an EXISTING funded program on behalf of its funder (e.g. a "Mid-Term Evaluation" or "Terminal Evaluation" RFP) — a consultancy to assess someone else's program, not funding for the company.
- Not actually a funding/procurement opportunity at all (e.g. the page turned out to be unrelated, broken, or paywalled with no visible content).

If the page describes a single opportunity, extract exactly that one item. If the page is instead a LISTING or INDEX of several distinct open opportunities — e.g. a funder's "current calls" or "funding opportunities" page linking out to multiple separate programs — extract EACH genuinely distinct, currently-open one as its own separate item in the "grants" array, up to a maximum of {MAX_ITEMS_PER_OPPORTUNITY_PAGE} items. Do not merge separate calls into one summary item, and do not invent items beyond what the page actually lists; if there are more distinct calls than the maximum, keep the ones that best fit the company profile above."""

EVENT_EXTRACTION_PROMPT_TEMPLATE = f"""Read the page at the URL below using your url_context tool, then extract structured details about the industry event it describes.

You also have Google Search available. The URL below often comes from a search-grounding redirect rather than the event's own page, so it sometimes lands on the wrong thing — a general press-release index, a news list, a category/homepage, or a page that fails to load — instead of the specific "{{title}}" event page. If url_context does not show you the specific event itself (not a list, not an unrelated page, not empty/broken), use Google Search to find the correct, specific event page for "{{title}}" — search by its name and, if known, its organizer — then read THAT page with url_context instead of giving up. Only fall back to an empty result if, after actually trying to search for and read the specific page, you still cannot find real, extractable content about it.

Today's date is {TODAY.isoformat()}. Use this — not any date you might otherwise assume — whenever you need to judge whether the event has already happened.

URL to read first: {{url}}
This page was already flagged as a likely "{{title}}" event — confirm or correct that from the actual page content (or from the specific page you find via search, per above).

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
  "geography": string | null,       // the SPECIFIC country the event is in or focused on — see "Rules for geography" below
  "focus_areas": string[],          // choose from: clean energy, clean cooking, climate change, GHG reduction, energy transition, deforestation, manufacturing, women/gender, tech & innovation, engineering, AI/data
  "description": string | null,     // 1-2 sentence neutral summary of what the event is
  "fit_analysis": string | null     // 2-4 sentences on why this event specifically is (or isn't) worth BURN's attendance — same idea as the "fit_analysis" field the opportunities pipeline writes, but framed around visibility/networking value rather than fundability
}}}}

Rules for "geography":
- Prefer a single, specific country name (e.g. "Nigeria", "Kenya", "Malawi") over a broad region ("Africa", "West Africa", "Sub-Saharan Africa") whenever the country is knowable — this is what powers a country-level filter downstream, so precision matters.
- Infer the country from whatever tells you where it actually is: the venue/location, the organizer, or often the event's own name (e.g. "Nigeria Energy Forum", "11th Nigeria Energy Forum (virtual)" → "Nigeria" — a virtual event still gets the country it's about/organized for, not a generic label). Don't require the page to spell out "Nigeria" in so many words if the title or venue already makes it unambiguous.
- Only fall back to a broader label ("Africa", "East Africa", etc.) when the event genuinely spans multiple countries with no single host country (e.g. a pan-African roadshow, a multi-city regional tour).
- Use "International" or "Global" only when the event has no particular country or regional tie at all.
- Use null only if you truly cannot determine any location signal from the page, title, or organizer.

Rules for "fit_analysis" (same spirit as the opportunities pipeline's, framed for an event rather than a funding call):
- Write it as an analyst briefing the company's grants/BD team on whether attending is worthwhile, not marketing copy.
- Reference concrete matching points from the company profile above where they apply: carbon finance/carbon markets relevance, clean cooking/energy-access relevance, geography overlap with BURN's countries of operation, or a plausible funder/investor/partner audience likely to be present.
- If it's a stretch — very broad/generic conference, a geography with no overlap, or a niche adjacent to but not really about BURN's sectors — say so plainly rather than inflating it.
- If the page gives too little detail to judge this, set the field to null rather than guessing.

Return {{{{ "events": [] }}}} — i.e. extract nothing — if the page is:
- Describing an event whose dates have clearly already passed.
- Actually a funding/procurement opportunity rather than an event (a call for proposals, RFP, tender, etc.) — that belongs in the opportunities pipeline, not here.
- Not actually describing a real, specific event (broken page, unrelated content, generic company homepage).
- A generic diplomatic/policy commemoration, anniversary, or broad multilateral/macroeconomic summit rather than a concrete clean-energy/climate/carbon-markets industry conference — e.g. a "High-Level Meeting to Commemorate the Nth Anniversary of [a Declaration]", the IMF/World Bank Annual Meetings, WEF Davos, or a G7/G20 finance-ministers meeting.
- A general food-system, agriculture, or nutrition event, unless specifically about clean-cooking fuel or technology.
- A narrow single-fuel-or-technology trade event with no real connection to clean cooking, climate finance, or carbon markets — e.g. a generic LPG/"Liquid Gas Week"-style conference, or a solar-power/photovoltaic-specific event ("Solar Power Africa", "Intersolar" and similar).
- Anything primarily about biodiversity, ecosystem services, or nature conservation — even if it uses market/credit language (e.g. "biodiversity credits"). Exclude regardless of framing, not just general-conservation-policy summits.
- A carbon-markets/climate/energy event explicitly regional to a single NON-African market with no stated Africa or emerging-market relevance (e.g. "Carbon Unbound North America", a US- or EU-only carbon-trading conference) — different from a genuinely global/international event, which is still fine.
- An academic or scientific research conference — a university- or academic-society-run event centered on researchers presenting papers, not a business/industry event with a corporate, funder, investor, or policy audience (e.g. a "[Nth] International Conference on [Topic] Monitoring/Remediation/Research", an IEEE/academic-proceedings conference) — even if the paper topics technically overlap with climate/environment/energy. A genuinely mixed industry+research summit with clear corporate/policy participation is still fine.

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
    text = call_gemini(DISCOVERY_PROMPT, [types.Tool(google_search=types.GoogleSearch())])
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

    # Cap each category independently — Gemini is asked for two separate
    # budgets (see DISCOVERY_PROMPT), but nothing stops it from returning
    # more of one kind than asked, so enforce both limits here rather than
    # trusting the model, same as the old single combined slice used to.
    opportunities = [c for c in cleaned if c["kind"] == "opportunity"][:MAX_OPPORTUNITIES_PER_RUN]
    events = [c for c in cleaned if c["kind"] == "event"][:MAX_EVENTS_PER_RUN]
    return opportunities + events


def extract_opportunity(candidate: dict) -> list[dict]:
    """Returns the extracted opportunity field-dicts found on this page —
    almost always zero or one, but can be several when the page turns out to
    be a listing/index of multiple distinct open calls (see
    MAX_ITEMS_PER_OPPORTUNITY_PAGE and the prompt's own instructions above).
    An empty list means nothing extractable, not an error."""
    prompt = OPPORTUNITY_EXTRACTION_PROMPT_TEMPLATE.format(
        url=candidate["url"], title=candidate["title"]
    )
    text = call_gemini(prompt, [
        types.Tool(url_context=types.UrlContext()),
        types.Tool(google_search=types.GoogleSearch()),
    ])
    if not text:
        return []
    try:
        parsed = json.loads(extract_json_object(text))
    except (json.JSONDecodeError, TypeError):
        print(f"    ! unparseable JSON from opportunity extraction (raw reply started: {text[:200]!r})")
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
        print(f"    ! saving opportunity failed ({response.status_code}): {response.text[:300]}")
        return False
    print(f"    + [opportunity] {title}"
          + (f"  (deadline {fields['deadline']})" if fields.get("deadline") else ""))
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


def find_duplicate_event_id(organizer: str | None, start_date: str | None, end_date: str | None) -> str | None:
    """Looks for an existing `events` row that's almost certainly the same
    real-world event as the one just extracted, even when its title text is
    genuinely different — e.g. "African Energy Week 2026" vs "Africa Energy
    Week 2026", the same African Energy Chamber conference, extracted from
    two different source pages under two slightly different titles.
    title_key's exact-match dedup can't catch this: those titles aren't
    punctuation/case variants of each other, they're genuinely different
    strings.

    Same organizer + identical start_date + identical end_date is a much
    higher-precision "same event" signal than fuzzy title matching — two
    unrelated real events sharing an organizer AND exact matching dates is
    vanishingly unlikely, whereas two events can easily share a generic
    title fragment ("Energy Week", "Africa", "2026"). Requires both an
    organizer and a start_date; returns None (fall through to the normal
    title_key upsert) when either is missing, rather than guessing off
    partial data.

    Deliberately does NOT filter out already-discarded rows: if it did, a
    previously-discarded event rediscovered under a new near-duplicate
    title would fail to match here, fall through to the title_key upsert,
    and insert as a brand-new (non-discarded) row — silently undoing the
    discard. Matching against discarded rows too, and never sending
    `discarded` in the eventual payload (see save_event below), keeps a
    discard permanent even across a title change like this one — same
    property dedup_migration.sql established for title_key, extended here.
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
                "select": "id,organizer",
                "start_date": f"eq.{start_date}",
                "end_date": f"eq.{end_date}" if end_date else "is.null",
            },
            timeout=30,
        )
        response.raise_for_status()
    except Exception as err:
        print(f"    ! could not check for duplicate events: {err}")
        return None
    for existing in response.json():
        if normalize_organizer(existing.get("organizer")) == org_key:
            return existing["id"]
    return None


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
    # find_duplicate_event_id). Patch that exact row by id instead of
    # upserting by title_key, which would treat the new wording as a
    # brand-new row and duplicate it. `title` is deliberately left out of
    # this payload so the survivor keeps whichever title it was first saved
    # under, and `discarded` is never sent here either, same as the
    # title_key upsert below.
    duplicate_id = find_duplicate_event_id(
        fields.get("organizer"), fields.get("start_date"), fields.get("end_date")
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
        print(f"    + [event] {title}  (same organizer + dates as an existing entry — merged, not duplicated)")
        return True

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
        print(f"    ! saving event failed ({response.status_code}): {response.text[:300]}")
        return False
    print(f"    + [event] {title}"
          + (f"  ({fields['start_date']})" if fields.get("start_date") else ""))
    return True


def main() -> None:
    print("Gemini discovery — searching for candidate opportunities and events")

    saved_opportunities = 0
    saved_events = 0

    # Fixed sources first: specific funder pages checked on every run
    # regardless of what the broad search below happens to surface — see
    # FIXED_OPPORTUNITY_SOURCES above for why these bypass seen_urls().
    if FIXED_OPPORTUNITY_SOURCES:
        print(f"\nChecking {len(FIXED_OPPORTUNITY_SOURCES)} fixed opportunity source(s)")
        for source in FIXED_OPPORTUNITY_SOURCES:
            print(f"  → [fixed] {source['title'][:70]}")
            fields_list = extract_opportunity(source)
            if not fields_list:
                print("    - nothing extractable; skipped")
            for fields in fields_list:
                if save_opportunity(fields, source):
                    saved_opportunities += 1
            time.sleep(GEMINI_PACING_SECONDS)

    candidates = discover_candidates()
    print(f"\n{len(candidates)} candidate(s) found via search")

    fresh = []
    if candidates:
        already = seen_urls([c["url"] for c in candidates])
        fresh = [c for c in candidates if c["url"] not in already]
        print(f"{len(fresh)} new candidate(s) to extract ({len(candidates) - len(fresh)} seen before)")

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
