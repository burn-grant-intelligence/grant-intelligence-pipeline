// scripts/scan.mjs
//
// Grant Intelligence scraper connector.
// Reads sources (RSS or plain HTML) from Supabase, extracts structured grant
// fields via Groq's free-tier LLM API, and upserts results back into Supabase
// with dedup by content hash.
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
// list of available free models and swap it here — everything else stays the same.
const GROQ_MODEL = "openai/gpt-oss-20b";

const EXTRACTION_SYSTEM_PROMPT = `You extract structured grant/funding opportunity data from raw web text.
Return ONLY a JSON object of the shape:
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
  "description": string | null,     // 1-2 sentence summary
  "application_url": string | null
}

If the text describes no funding opportunity at all, return { "grants": [] }.`;

async function extractGrants(rawText) {
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: rawText.slice(0, 15000) },
    ],
  });
  const text = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.grants) ? parsed.grants : [];
  } catch {
    console.error("Failed to parse Groq output as JSON:", text.slice(0, 300));
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

async function fetchHtmlCandidates(source) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(source.url, { waitUntil: "networkidle", timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    return [{ rawText: text.slice(0, 20000), fallbackUrl: source.url }];
  } finally {
    await browser.close();
  }
}

// --- Dedup + upsert ------------------------------------------------------------
function hashOf(title, url) {
  return crypto.createHash("sha256").update(`${title}::${url || ""}`.toLowerCase()).digest("hex");
}

async function upsertGrant(fields, source, fallbackUrl) {
  if (!fields.title) return;
  const application_url = fields.application_url || fallbackUrl || null;
  const content_hash = hashOf(fields.title, application_url);

  const { error } = await supabase.from("grants").upsert(
    {
      source_id: source.id,
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
      content_hash,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "content_hash", ignoreDuplicates: false }
  );

  if (error) console.error(`  ! Supabase upsert failed for "${fields.title}":`, error.message);
  else console.log(`  + Upserted: ${fields.title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Main loop -------------------------------------------------------------------
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

async function main() {
  const { data: sources, error } = await supabase.from("sources").select("*").eq("active", true);
  if (error) throw error;

  if (!sources || !sources.length) {
    console.log("No active sources configured. Add rows to the `sources` table in Supabase.");
    return;
  }

  for (const source of sources) {
    await scanSource(source);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
