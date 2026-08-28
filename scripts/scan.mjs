// scripts/scan.mjs
//
// Grant Intelligence scraper connector.
// Reads sources (RSS or plain HTML) from Supabase, extracts structured grant
// fields via Groq's free-tier LLM API, and upserts results back into Supabase
// with dedup by content hash. Once a day, also runs a small batch of Google
// searches to discover new candidate pages beyond the fixed source list.
//
// Run locally:  node scripts/scan.mjs
// Run in CI:    see .github/workflows/daily-scan.yml

import crypto from "node:crypto";
import Parser from "rss-parser";
import { chromium } from "playwright";
import Groq from "groq-sdk";
import { supabaseAdmin as supabase } from "./supabaseAdmin.mjs";

if (!process.env.GROQ_API_KEY) {
  throw new Error("Missing GROQ_API_KEY. Get a free key at console.groq.com and set it as an env var.");
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// If this model name ever 404s, check console.groq.com/docs/models for the current
// list of available models and swap it here — everything else stays the same.
const GROQ_MODEL = "openai/gpt-oss-20b";

// Fixed company context fed to the model on every extraction so it can judge
// fit, not just summarize. Update this block if BURN's business changes.
const BURN_PROFILE = `BURN Manufacturing — company profile for grant-fit assessment:
- Products: manufactures and distributes clean cookstoves across every major fuel type — LPG gas, biomass/wood, electric induction (IoT-enabled), ethanol, charcoal, and institutional-scale stoves — plus cookware.
- Manufacturing & scale: owns factories in Kenya and Nigeria (plus Asia), 450K+ units/month capacity, ships orders from 3,000 to 1M+ units. This is an established, at-scale manufacturer — NOT an early-stage or pre-revenue startup.
- Track record: 7.4M+ stoves sold, 37.5M+ lives impacted, 56.7K+ jobs created since 2013, 81M+ tons of CO2 reduced.
- Geography: operates across 20+ African countries (home delivery in 9, B2B sales in 8, call centers in 10, carbon projects in 10).
- Carbon finance: a vertically integrated carbon project developer, 5M+ carbon credits issued, certified by Gold Standard and MMECD — strong fit for carbon finance, results-based financing, and climate-linked funding.
- Distribution: an established last-mile distribution network across its countries of operation.
- Gender: products and programs center women as primary household cooking-fuel decision-makers and beneficiaries.
- Funding BURN typically seeks: grants, catalytic/concessional funding, results-based financing, R&D funding, and scale-up/working capital. BURN is generally NOT a fit for micro-loans or funding explicitly reserved for small/early-stage/first-time operators.
- Strong-fit program patterns: results-based financing (RBF) programs for clean cooking, calls for proposals / "Call4Solutions" / tenders specifically for cookstove distribution or manufacturing, institutional and school-cooking programs, and higher-tier/modern eCooking scale-up programs. Funders and program types that recur in this space include (examples, not exhaustive): AECF, CLASP, MECS (Modern Energy Cooking Services), UNCDF, NEFCO, national Rural Electrification Agencies, multilateral development bank energy/climate windows (e.g. AIIB), and foundations such as Solar Impulse Foundation or Education Cannot Wait when their calls involve clean cooking. Treat opportunities structured this way as strong candidate matches.
- Agriculture is generally NOT a fit: BURN is a clean cookstove company, not an agriculture company. Funding primarily for on-farm equipment, agricultural inputs, crop or livestock production, agri-processing, or farm-level energy systems is a poor fit — even if it touches climate or energy — UNLESS it specifically funds clean cookstove manufacturing or distribution.`;

const EXTRACTION_SYSTEM_PROMPT = `You extract structured, OPEN funding opportunities from raw web text — programs a reader could still apply to today — and assess how well each one fits BURN Manufacturing, a specific company described below. You are NOT extracting news stories about who has already won or received money.

${BURN_PROFILE}

Respond with ONLY a JSON object — no markdown code fences, no explanation before or after — of the shape:
{ "grants": [ { ... }, ... ] }

Each item in "grants" must have exactly these fields (use null for anything not stated in the text — never guess or invent values):
{
  "title": string,
  "funder": string | null,
  "amount": number | null,
  "currency": string | null,
  "deadline": string | null,        // ISO date "YYYY-MM-DD" only if a specific date is stated
  "geography": string | null,
  "focus_areas": string[],          // choose from: clean energy, clean cooking, climate change, GHG reduction, energy transition, deforestation, manufacturing, women/gender, tech & innovation, engineering, AI/data
  "eligibility": string | null,
  "description": string | null,     // 1-2 sentence neutral summary of the opportunity itself
  "application_url": string | null,
  "fit_analysis": string | null     // 2-4 sentences assessing how well THIS opportunity fits BURN specifically — see rules below
}

Rules for "fit_analysis":
- Write it as an analyst briefing BURN's grants team, not marketing copy.
- Reference concrete matching points from the profile above where they apply: geography overlap, product/fuel-type match, carbon finance or gender-program fit, or distribution-network relevance.
- If something looks like a MISMATCH, say so plainly and specifically — e.g. the opportunity targets small/early-stage operators smaller than BURN's scale, the geography doesn't include BURN's countries, it's an equity investment rather than a grant/loan, or the funding amount is too small to be worth the application effort.
- If the text gives too little detail to judge fit, set this field to null rather than guessing.

Do NOT include an item in "grants" at all if the text is:
- News reporting that a specific named company or organization has ALREADY secured, raised, received, won, been awarded, or closed a round of funding (e.g. "EcoNomad Solutions Secures £230K for..."). That is reporting someone else's past outcome, not an open call for applications.
- A general venture capital / equity investment story, not a grant or donor program.
- A funding round, program, or deadline that has already closed, with no indication of a new or recurring open cycle.
- Primarily an agriculture opportunity — on-farm equipment, agricultural inputs, crop or livestock production, agri-processing, or farm-level energy systems — unless it specifically funds clean cookstove manufacturing or distribution. BURN is a clean cookstove company; general agriculture funding should be excluded entirely.

Only include an item if it describes a program, fund, or call that a reader could realistically apply to — i.e. it has (or clearly implies) open applications, eligibility criteria, or a way to apply.

If the text describes no open funding opportunity at all, respond with exactly: { "grants": [] }`;

// Pulls the first {...} block out of a string, in case the model adds stray
// text or markdown fences around the JSON despite instructions not to.
function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const braceMatch = candidate.match(/\{[\s\S]*\}/);
  return braceMatch ? braceMatch[0] : candidate;
}

// Backstop for headline-style "already funded" news the model occasionally
// still lets through, e.g. "EcoNomad Solutions Secures £230K for X" or
// "Acme Corp raises $2M to build Y". Matches: <Name> <past-tense verb> <amount>.
const AWARD_NEWS_PATTERN =
  /^[A-Z][\w.&' -]{2,60}\s+(secures?|raises?|lands?|wins?|receives?|bags?|scores?|closes)\s+(a\s+|its\s+)?[£$€]?[\d,.]+\s?(k|m|million|thousand)?\b/i;

function looksLikeAwardNews(title) {
  return AWARD_NEWS_PATTERN.test(title.trim());
}

async function extractGrants(rawText) {
  let text = "";
  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      reasoning_effort: "low", // this is a reasoning model; keep it light for a simple extraction task
      max_completion_tokens: 3072,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: rawText.slice(0, 15000) },
      ],
    });
    text = completion.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    // Network error, rate limit, or the model/provider itself erroring out —
    // log and skip this one page rather than crashing the whole scan run.
    console.error("  ! Groq request failed:", err.message);
    return [];
  }

  try {
    const parsed = JSON.parse(extractJsonObject(text));
    return Array.isArray(parsed.grants) ? parsed.grants : [];
  } catch {
    console.error("  ! Failed to parse Groq output as JSON:", text.slice(0, 300));
    return [];
  }
}

// --- Fetchers ----------------------------------------------------------------
const rssParser = new Parser();

async function fetchRssCandidates(source) {
  const feed = await rssParser.parseURL(source.url);
  return feed.items.slice(0, 30).map((item) => ({
    rawText: [item.title, item.contentSnippet || item.content, item.link].filter(Boolean).join("\n\n"),
    fallbackUrl: item.link,
  }));
}

async function fetchPageText(url) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    return text.slice(0, 20000);
  } finally {
    await browser.close();
  }
}

async function fetchHtmlCandidates(source) {
  const text = await fetchPageText(source.url);
  return [{ rawText: text, fallbackUrl: source.url }];
}

// --- Dedup + upsert ------------------------------------------------------------
function hashOf(title, url) {
  return crypto.createHash("sha256").update(`${title}::${url || ""}`.toLowerCase()).digest("hex");
}

async function upsertGrant(fields, source, fallbackUrl) {
  if (!fields.title) return;

  if (looksLikeAwardNews(fields.title)) {
    console.log(`  - Skipped (reads like "already funded" news, not an open opportunity): ${fields.title}`);
    return;
  }

  const application_url = fields.application_url || fallbackUrl || null;
  const content_hash = hashOf(fields.title, application_url);

  const { error } = await supabase.from("grants").upsert(
    {
      source_id: source?.id ?? null,
      title: fields.title,
      funder: fields.funder,
      amount: fields.amount,
      currency: fields.currency,
      deadline: fields.deadline,
      geography: fields.geography,
      focus_areas: fields.focus_areas || [],
      eligibility: fields.eligibility,
      description: fields.description,
      application_url,
      fit_analysis: fields.fit_analysis ?? null,
      content_hash,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "content_hash", ignoreDuplicates: false }
  );

  if (error) console.error(`  ! Supabase upsert failed for "${fields.title}":`, error.message);
  else console.log(`  + Upserted: ${fields.title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Fixed-source scanning ----------------------------------------------------
async function scanSource(sourceRow) {
  console.log(`Scanning: ${sourceRow.name} (${sourceRow.type})`);
  let candidates = [];
  try {
    candidates =
      sourceRow.type === "rss" ? await fetchRssCandidates(sourceRow) : await fetchHtmlCandidates(sourceRow);
  } catch (err) {
    console.error(`  ! Fetch failed for ${sourceRow.name}:`, err.message);
    await supabase
      .from("sources")
      .update({
        last_scanned_at: new Date().toISOString(),
        consecutive_errors: (sourceRow.consecutive_errors || 0) + 1,
      })
      .eq("id", sourceRow.id);
    return;
  }

  for (const candidate of candidates) {
    const extracted = await extractGrants(candidate.rawText);
    for (const fields of extracted) {
      await upsertGrant(fields, sourceRow, candidate.fallbackUrl);
    }
    await sleep(1500); // stay comfortably under Groq's free-tier rate limit
  }

  await supabase
    .from("sources")
    .update({
      last_scanned_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      consecutive_errors: 0,
    })
    .eq("id", sourceRow.id);
}

// --- Google Search discovery ---------------------------------------------------
// Runs once a day (see the hour check in main()) to stay comfortably within
// Google's free 100-searches/day quota. Finds candidate pages beyond the
// fixed `sources` list, then runs them through the same extraction pipeline.

const SEARCH_QUERIES = [
  "results-based financing clean cooking Africa call for proposals",
  "cookstove tender request for proposals Africa {YEAR}",
  "clean cooking Call4Solutions OR RFP Africa",
  "institutional cooking schools Africa funding program",
  "higher tier cooking results based financing Africa",
  "AECF Energy Transition Challenge Fund {YEAR}",
  "modern cooking facility Africa Nefco financing",
  "clean cooking scale-up grant Africa {YEAR}",
];

const MAX_QUERIES_PER_RUN = 8;
const RESULTS_PER_QUERY = 5;
const RECHECK_AFTER_DAYS = 30;

async function googleSearch(query) {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_SEARCH_API_KEY,
    cx: process.env.GOOGLE_SEARCH_CX,
    q: query,
    num: String(RESULTS_PER_QUERY),
  });
  try {
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    if (!res.ok) {
      console.error(`  ! Google Search failed for "${query}": ${res.status} ${res.statusText}`);
      return [];
    }
    const data = await res.json();
    return (data.items || []).map((item) => ({ url: item.link, title: item.title }));
  } catch (err) {
    console.error(`  ! Google Search request failed for "${query}":`, err.message);
    return [];
  }
}

async function discoverCandidateUrls() {
  if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_CX) {
    console.log("Google Search not configured (missing GOOGLE_SEARCH_API_KEY/GOOGLE_SEARCH_CX) — skipping discovery.");
    return [];
  }

  const year = new Date().getFullYear();
  const queries = SEARCH_QUERIES.slice(0, MAX_QUERIES_PER_RUN).map((q) => q.replace("{YEAR}", String(year)));

  const seenUrls = new Set();
  const candidates = [];
  for (const query of queries) {
    const results = await googleSearch(query);
    for (const r of results) {
      if (!r.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      candidates.push(r);
    }
    await sleep(500);
  }

  // Skip anything we've checked recently, so we don't burn Groq calls and
  // search quota re-processing the same page every day.
  const fresh = [];
  for (const candidate of candidates) {
    const { data } = await supabase
      .from("discovered_urls")
      .select("last_checked_at")
      .eq("url", candidate.url)
      .maybeSingle();
    const staleEnough =
      !data ||
      Date.now() - new Date(data.last_checked_at).getTime() > RECHECK_AFTER_DAYS * 24 * 60 * 60 * 1000;
    if (staleEnough) fresh.push(candidate);
  }

  return fresh;
}

async function scanDiscoveredUrl(candidate) {
  console.log(`Discovered: ${candidate.url}`);
  let rawText = "";
  try {
    rawText = await fetchPageText(candidate.url);
  } catch (err) {
    console.error(`  ! Fetch failed for discovered URL ${candidate.url}:`, err.message);
    return;
  }

  const extracted = await extractGrants(rawText);
  for (const fields of extracted) {
    await upsertGrant(fields, null, candidate.url);
  }

  await supabase
    .from("discovered_urls")
    .upsert({ url: candidate.url, last_checked_at: new Date().toISOString() }, { onConflict: "url" });

  await sleep(1500);
}

// --- Main loop -------------------------------------------------------------------
async function main() {
  const { data: sources, error } = await supabase.from("sources").select("*").eq("active", true);
  if (error) throw error;

  if (sources && sources.length) {
    for (const source of sources) {
      await scanSource(source);
    }
  } else {
    console.log("No active sources configured. Add rows to the `sources` table in Supabase.");
  }

  // Only run Google Search discovery once a day (at the midnight UTC run),
  // to stay comfortably within Google's free 100-searches/day quota.
  const shouldDiscover = true;
  if (shouldDiscover) {
    console.log("Running Google Search discovery (once-daily window)...");
    const discovered = await discoverCandidateUrls();
    console.log(`Found ${discovered.length} new candidate page(s) to check.`);
    for (const candidate of discovered) {
      await scanDiscoveredUrl(candidate);
    }
  } else {
    console.log("Skipping Google Search discovery this run (only runs once/day to stay within the free quota).");
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
