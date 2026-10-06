// Eligibility Tracker's "Check eligibility" button (components/
// EligibilityTracker.tsx) POSTs a grant id here. This is the first
// server-side code in the Next.js app that calls Gemini — every other
// Gemini call in this project lives in scripts/gemini_discover.py, run by
// GitHub Actions. It needed its own route (rather than calling Gemini
// straight from the browser) for two reasons: GEMINI_API_KEY must never
// reach client-side JS, and writing the result back onto `grants` uses the
// Supabase service-role key (bypassing RLS) rather than depending on the
// "Public update access to grants" policy the browser's anon-key writes rely
// on elsewhere in this app.
//
// Requires two environment variables on Vercel that previously only existed
// as GitHub Actions secrets for the Python scrapers — see .env.example:
//   GEMINI_API_KEY            (server-side only, no NEXT_PUBLIC_ prefix)
//   SUPABASE_SERVICE_ROLE_KEY (server-side only, same key the scrapers use)
//
// Two stages (lib/eligibility/):
//   1. Gemini only EXTRACTS facts about the call (extract.ts) — it never
//      decides fit.
//   2. rules.ts compares those facts to BURN's profile (burnProfile.ts) and
//      returns fit / not_fit / needs_review with the reasons.
//
// Stage 1 has two ways of getting the call text to Gemini:
//   A. "sources" (preferred): fetchSources.ts downloads the call page and its
//      most RFP-like linked PDFs/pages itself (SSRF-guarded) and hands them to
//      Gemini directly, so we KNOW how much was read and can cap the coverage
//      the model claims. No tools, JSON mode.
//   B. "tools" (fallback): the app's original approach — Gemini's own
//      url_context + google_search tools, same pattern as
//      scripts/gemini_discover.py. Used when A reads too little (a thin
//      landing page, a JS-only page, a blocked site, a Google grounding
//      redirect) or fails. Gemini 2.5 can't force a JSON schema and use tools
//      in the same request, so in both modes the shape is printed into the
//      prompt, JSON mode is used where possible, and normalizeFacts() cleans
//      up whatever comes back.
// The old columns (eligible_countries, applicant_type, supporting_docs,
// rfp_url) are still filled, now derived from the extracted facts.

import { GoogleGenAI, ApiError, UrlRetrievalStatus, type Part, type Tool } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import type { SupportingDoc } from "@/lib/types";
import { FACTS_SCHEMA, SYSTEM_PROMPT, buildUserPrompt, normalizeFacts, schemaToTemplate } from "@/lib/eligibility/extract";
import { gatherSources, isSafeUrl, maxCoverage, type GatheredSources } from "@/lib/eligibility/fetchSources";
import { assessLink, findLinkPrompt, isGroundingRedirect, parseFoundLink } from "@/lib/eligibility/linkCheck";
import { chooseCallLink, pinnedLinkFrom, type CallLinkChoice } from "@/lib/eligibility/callLink";
import { pastedSources } from "@/lib/eligibility/pastedText";
import { buildReport } from "@/lib/eligibility/rules";
import { loadProfile, type ProfileDb } from "@/lib/eligibility/profileStore";
import { planTrackerUpdate, type TrackerFitRow } from "@/lib/eligibility/applyVerdict";
import { REVIEW_ORIGIN, applyReviewPlan, planReviewSync, type ReviewAction, type ReviewItem } from "@/lib/eligibilityReview";
import { applyDeadlineFallback, eligibleCountriesFrom } from "@/lib/eligibility/postprocess";
import type { CallFacts, EligibilityReport } from "@/lib/eligibility/types";

export const runtime = "nodejs";
// Fetching + reading a call and its PDFs can take a while. 60s is the ceiling
// on every Vercel plan; raise it only if your plan allows more (the fallback
// to the tools path is skipped when there isn't time left for it).
export const maxDuration = 60;
const MIN_MS_FOR_FALLBACK = 32_000;
// Tool fallback: each attempt but the last is capped, and no further attempt starts after the limit.
const TOOL_ATTEMPT_CAP_MS = 22_000;
const TOOL_RETRY_LIMIT_MS = 44_000;

// Default matches scripts/gemini_discover.py's GEMINI_MODEL — never
// live-verified against a real API call in this build sandbox (no API key
// available here); if this 404s in production, check
// ai.google.dev/gemini-api/docs/models. Setting a GEMINI_MODEL environment
// variable on Vercel overrides it without a code change.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_MAX_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 20_000;
const SERVER_ERROR_BACKOFF_MS = 2_000;
const RETRYABLE_SERVER_ERRORS = [500, 502, 503, 504];
// Retries stop being worth it once this much of the route's 60s is gone.
const RETRY_CUTOFF_MS = 40_000;
const CALL_DEADLINE_MS = 55_000;

type Mode = "sources" | "tools";
type GrantRow = {
  title: string | null;
  funder: string | null;
  application_url: string;
  deadline?: string | null;
  geography?: string | null;
  focus_areas?: string[] | null;
  eligibility?: string | null;
  description?: string | null;
  type_of_funding?: string | null;
};

// Awards, prizes and competitions (found by the awards discovery run) are
// saved in `grants` too, tagged like this — they get an award-aware prompt.
const isAward = (g: GrantRow) =>
  g.type_of_funding === "Cash prize award" || (g.focus_areas ?? []).some((t) => t.toLowerCase().replace(/[^a-z]/g, "") === "awardsprizes");

// What we already store about the opportunity, given to the model as
// UNVERIFIED context (the prompt tells it the sources win).
function trackerContextFor(grant: GrantRow) {
  const lines = [
    grant.deadline ? `Deadline on file: ${grant.deadline}` : null,
    grant.geography ? `Geography on file: ${grant.geography}` : null,
    grant.focus_areas?.length ? `Focus areas on file: ${grant.focus_areas.join(", ")}` : null,
    grant.eligibility ? `Eligibility text on file: ${grant.eligibility.slice(0, 1200)}` : null,
    grant.description ? `Description on file: ${grant.description.slice(0, 1200)}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

const SHAPE = `Return ONLY a JSON object (no prose, no markdown code fences) with exactly this shape. Pipes separate the allowed values of a field; "string|null" means a string or null:
${JSON.stringify(schemaToTemplate(FACTS_SCHEMA), null, 1)}`;

function buildPrompt(mode: Mode, grant: GrantRow, gathered: GatheredSources | null, choice: CallLinkChoice) {
  const head = buildUserPrompt({
    today: new Date().toISOString().slice(0, 10),
    trackerContext: trackerContextFor(grant),
    coverageHint:
      mode === "sources" && gathered
        ? gathered.coverageHint
        : "Read the page below with your url_context tool, and also open any call document, guidelines, annexes or PDFs it links to — the eligibility criteria are usually in those, not on the landing page.",
    sourceNotes: mode === "sources" && gathered ? gathered.notes : [],
    kind: isAward(grant) ? "award" : "grant",
  });
  const about = `Opportunity: "${grant.title ?? "(untitled grant)"}"
Funder: ${grant.funder ?? "an unnamed funder"}
URL: ${choice.primary ?? grant.application_url}`;
  if (mode === "sources") {
    return `${head}

${about}

The source documents follow this message, each introduced by a "--- SOURCE:" line.

${SHAPE}`;
  }
  return `${head}

${about}

${
    choice.pinned
      ? "The URL above was chosen and checked by a person: it IS the page for this opportunity. Do not replace it with another page. If you cannot open it, use Google Search only to find text ABOUT this exact opportunity (its call page, guidelines or announcements) and extract from that."
      : "You also have Google Search available. If url_context does not show you the specific opportunity itself (a list, an unrelated page, or something empty/broken instead), use Google Search to find the correct page for this opportunity by its name and funder, then read that page with url_context instead of giving up."
  }

${SHAPE}`;
}

// Same trick used in scripts/gemini_discover.py's extract_json_object() (and
// scan.mjs / social_discover.py before it) — pull the first {...} block out
// of the model's reply in case it wraps the JSON in prose or code fences
// despite instructions.
function extractJsonObject(text: string): string {
  let working = text;
  if (working.includes("```")) {
    for (const part of working.split("```")) {
      let cleaned = part.trimStart();
      if (cleaned.toLowerCase().startsWith("json")) cleaned = cleaned.slice(4);
      if (cleaned.includes("{")) {
        working = cleaned;
        break;
      }
    }
  }
  const start = working.indexOf("{");
  const end = working.lastIndexOf("}");
  return start !== -1 && end > start ? working.slice(start, end + 1) : working;
}

interface GeminiResult {
  text: string;
  // Tools mode only. null = Gemini didn't report url_context metadata at all
  // (unknown); [] = it reported metadata but no URL was read successfully.
  urlsRead: string[] | null;
}

// Why the last Gemini step failed — shown to the user, so "try again shortly"
// isn't the only thing they learn.
interface Diag {
  reason: string | null;
}

async function callGemini(
  ai: GoogleGenAI,
  mode: Mode,
  prompt: string,
  sourceParts: Part[],
  started: number,
  diag?: Diag,
  toolsOverride?: Tool[],
  capMs?: number
): Promise<GeminiResult | null> {
  const tools: Tool[] = toolsOverride ?? [{ urlContext: {} }, { googleSearch: {} }];
  for (let attempt = 0; attempt < GEMINI_MAX_RETRIES; attempt++) {
    // Every attempt is bounded by what's left of the route's time, so one hung
    // request can't run past Vercel's limit and lose the whole check.
    const abortSignal = AbortSignal.timeout(Math.max(5_000, Math.min(capMs ?? Infinity, CALL_DEADLINE_MS - (Date.now() - started))));
    const config =
      mode === "tools"
        ? { tools, systemInstruction: SYSTEM_PROMPT, temperature: 0, abortSignal }
        : { systemInstruction: SYSTEM_PROMPT, temperature: 0, responseMimeType: "application/json", abortSignal };
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }, ...sourceParts] }],
        config,
      });
      if (!response.text) {
        // Blocked / empty answers: say why in the logs instead of a bare failure.
        console.warn(
          `Gemini returned no text (${mode} mode): finishReason=${response.candidates?.[0]?.finishReason ?? "unknown"}` +
            (response.promptFeedback?.blockReason ? `, blockReason=${response.promptFeedback.blockReason}` : "")
        );
        const finish = response.candidates?.[0]?.finishReason;
        if (diag)
          diag.reason = response.promptFeedback?.blockReason
            ? `Gemini blocked the request (${response.promptFeedback.blockReason}).`
            : `Gemini returned an empty answer${finish ? ` (finish reason: ${finish})` : ""}.`;
        return null;
      }
      const meta = response.candidates?.[0]?.urlContextMetadata?.urlMetadata;
      const urlsRead = meta
        ? meta
            .filter((m) => m.urlRetrievalStatus === UrlRetrievalStatus.URL_RETRIEVAL_STATUS_SUCCESS && m.retrievedUrl)
            .map((m) => m.retrievedUrl as string)
        : null;
      return { text: response.text, urlsRead };
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const backoff = status === 429 ? RATE_LIMIT_BACKOFF_MS : RETRYABLE_SERVER_ERRORS.includes(status) ? SERVER_ERROR_BACKOFF_MS * (attempt + 1) : 0;
      const timeLeftForRetry = Date.now() - started + backoff < RETRY_CUTOFF_MS;
      if (backoff > 0 && attempt < GEMINI_MAX_RETRIES - 1 && timeLeftForRetry) {
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      console.error(`Gemini eligibility request failed (${mode} mode):`, err);
      if (diag) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        diag.reason = timedOut
          ? "Gemini took too long to read this page (timed out)."
          : status === 429
            ? "Gemini is rate-limited right now (too many requests)."
            : status
              ? `Gemini returned an error (HTTP ${status}).`
              : "The request to Gemini failed.";
      }
      return null;
    }
  }
  return null;
}

// Asks Gemini (Google Search + url_context) for the official page of a call
// whose stored link is gated, a post, a listing or otherwise wrong. One attempt,
// short deadline: this is a nice-to-have and must not eat the route's budget.
async function findOfficialLink(
  ai: GoogleGenAI,
  grant: { title: string | null; funder: string | null; application_url: string },
  started: number
): Promise<{ url: string | null; reason: string } | null> {
  try {
    const abortSignal = AbortSignal.timeout(Math.min(12_000, Math.max(3_000, 30_000 - (Date.now() - started))));
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts: [{ text: findLinkPrompt(grant) }] }],
      config: { tools: [{ urlContext: {} }, { googleSearch: {} }], temperature: 0, abortSignal },
    });
    return response.text ? parseFoundLink(response.text) : null;
  } catch (err) {
    console.warn("findOfficialLink failed:", (err as Error).message);
    return null;
  }
}

function parseFacts(text: string): CallFacts | null {
  try {
    return normalizeFacts(JSON.parse(extractJsonObject(text)));
  } catch {
    console.warn(`Eligibility: Gemini's reply was not valid JSON (it started: ${JSON.stringify(text.slice(0, 200))})`);
    return null;
  }
}

// Gemini sometimes answers in prose instead of the JSON shape (most often when
// it has been searching, or when the page is an award rather than a grant). One
// cheap follow-up asks it to put what it said into the shape — no tools, JSON
// mode — if there is time left.
async function factsFromReply(ai: GoogleGenAI, text: string, started: number, diag: Diag): Promise<CallFacts | null> {
  const facts = parseFacts(text);
  if (facts) return facts;
  if (Date.now() - started > 42_000) {
    diag.reason = "Gemini replied, but not in a form that could be read, and there was no time left to retry.";
    return null;
  }
  const repair = `The text below is an analysis of a funding or award opportunity. Put what it says into ONE JSON object of exactly the shape below. Use only what the text states; use "unclear", null or [] for anything it does not say.

${SHAPE}

--- TEXT ---
${text.slice(0, 12_000)}`;
  const result = await callGemini(ai, "sources", repair, [], started, diag);
  const repaired = result ? parseFacts(result.text) : null;
  if (!repaired && !diag.reason) diag.reason = "Gemini replied, but its answer could not be read.";
  return repaired;
}

export async function POST(request: Request) {
  const started = Date.now();
  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!geminiKey) {
    return Response.json(
      { error: "GEMINI_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json(
      { error: "Supabase service-role credentials are not configured on the server." },
      { status: 500 }
    );
  }

  let body: { grantId?: unknown; pastedText?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const grantId = typeof body.grantId === "string" ? body.grantId : null;
  if (!grantId) {
    return Response.json({ error: "grantId is required." }, { status: 400 });
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

  const { data: grant, error: fetchError } = await supabaseAdmin
    .from("grants")
    .select("id, title, funder, application_url, rfp_url, deadline, geography, focus_areas, eligibility, description, type_of_funding, eligibility_report")
    .eq("id", grantId)
    .maybeSingle();

  if (fetchError) {
    return Response.json({ error: fetchError.message }, { status: 500 });
  }
  if (!grant) {
    return Response.json({ error: "Grant not found." }, { status: 404 });
  }
  // The link a person typed into the Application Tracker's Breakdown is the one
  // they opened and checked, so it is the link the check reads — and it is never
  // swapped for one found by search (lib/eligibility/callLink.ts).
  const pasted = pastedSources(body.pastedText);
  const { data: linkRows, error: linkError } = await supabaseAdmin
    .from("tracker_items")
    .select("pipeline_link, updated_at")
    .eq("grant_id", grantId)
    .order("updated_at", { ascending: false });
  if (linkError) console.warn("Could not read the saved link from tracker_items:", linkError.message);
  const choice = chooseCallLink({
    pinned: linkError ? null : pinnedLinkFrom(linkRows),
    rfpUrl: grant.rfp_url,
    applicationUrl: grant.application_url,
  });
  if (!choice.primary && !pasted) {
    return Response.json(
      {
        error:
          "This opportunity has no link to read. Add one in the Application Tracker (open Breakdown → Link), or paste the call text under the check button, then try again.",
      },
      { status: 400 }
    );
  }

  const ai = new GoogleGenAI({ apiKey: geminiKey });

  // ── Stage 1: get facts. Try A (own fetch) first, fall back to B (tools). ──
  // Start from the RFP link a previous check already found (usually the real
  // guidelines/PDF), else the source link. If that reads too little, also try
  // the source link and keep whichever read more.
  const tryGather = async (url: string, budgetMs?: number) => {
    try {
      return await gatherSources(url, "", { budgetMs });
    } catch (err) {
      console.warn("fetchSources failed for one source:", (err as Error).message);
      return null;
    }
  };
  const readScore = (g: GatheredSources | null) => (g ? g.pdfCount * 100_000 + g.textChars : -1);
  // Text pasted by a person is used as it is; otherwise read the chosen link.
  const primaryUrl: string = choice.primary ?? "";
  let gathered: GatheredSources | null = pasted ?? (await tryGather(primaryUrl));
  if (
    !pasted &&
    (!gathered || maxCoverage(gathered) === "landing_page_only") &&
    choice.alternate &&
    Date.now() - started < 15_000
  ) {
    const alt = await tryGather(choice.alternate);
    if (readScore(alt) > readScore(gathered)) gathered = alt;
  }

  // ── Does this link really show the call? ──
  // A login wall, a LinkedIn post or a listing page would otherwise be read as
  // if it were the RFP. When the link looks wrong, ask Gemini (with Google
  // Search) for the official page and read that instead, time permitting.
  let linkNote: string | null = null;
  let linkReplaced = false;
  const assessed = pasted ? null : assessLink(gathered, grant);
  if (assessed && assessed.status !== "ok") {
    // A person's own link is never replaced: just say it couldn't be read here.
    linkNote = choice.pinned
      ? `Your saved link couldn't be read automatically (${(assessed.note ?? "").toLowerCase()}). It was kept as it is.`
      : assessed.note;
    const tried = new Set([primaryUrl, grant.application_url, grant.rfp_url].filter(Boolean) as string[]);
    if (!choice.pinned && Date.now() - started < 22_000) {
      const found = await findOfficialLink(ai, grant, started);
      if (found?.url && !tried.has(found.url) && !isGroundingRedirect(found.url) && isSafeUrl(found.url)) {
        const left = 40_000 - (Date.now() - started);
        if (left >= 6_000) {
          const better = await tryGather(found.url, Math.min(15_000, left));
          const betterAssessment = assessLink(better, grant);
          if (better && betterAssessment.status === "ok") {
            gathered = better;
            linkReplaced = true;
            linkNote = `The link on file looked wrong (${(assessed.note ?? "").toLowerCase()}), so the official page was found through search and read instead: ${found.url}`;
          } else if (better && readScore(better) > readScore(gathered)) {
            gathered = better;
          }
        }
      }
    }
  }
  const rawCap = gathered ? maxCoverage(gathered) : "landing_page_only";
  // Pasted text is a person's own choice of what to read: never treat it as "just a landing page".
  const coverageCap = pasted && rawCap === "landing_page_only" ? "partial" : rawCap;

  let facts: CallFacts | null = null;
  let sources: string[] = [];
  const diag: Diag = { reason: null };

  if (gathered && coverageCap !== "landing_page_only") {
    const result = await callGemini(ai, "sources", buildPrompt("sources", grant, gathered, choice), gathered.parts as Part[], started, diag);
    facts = result ? await factsFromReply(ai, result.text, started, diag) : null;
    if (facts) {
      sources = gathered.used;
      // The model grades its own coverage and can overrate a summary page —
      // never let it claim more than what was actually fetched.
      if (coverageCap === "partial" && facts.source_coverage === "full_rfp") facts.source_coverage = "partial";
      // Only trust an RFP link that we actually read; otherwise use our best guess.
      facts.rfp_url = facts.rfp_url && gathered.used.includes(facts.rfp_url) ? facts.rfp_url : gathered.rfpUrl;
      // A person's own link stays the recorded call link unless a document on that page was actually read.
      if (choice.pinned && !facts.rfp_url) facts.rfp_url = choice.primary;
    }
  }

  // Fallback: let Gemini read the link itself. Combining url_context with Google
  // Search sometimes comes back empty, so step down to each tool on its own —
  // a short cap on every attempt but the last leaves time for the next one.
  if (!facts && Date.now() - started < MIN_MS_FOR_FALLBACK) {
    const variants: Tool[][] = [
      [{ urlContext: {} }, { googleSearch: {} }],
      [{ urlContext: {} }],
      [{ googleSearch: {} }],
    ];
    for (let i = 0; i < variants.length && !facts; i++) {
      if (i > 0 && Date.now() - started > TOOL_RETRY_LIMIT_MS) break;
      const toolSet = variants[i];
      diag.reason = null;
      const result = await callGemini(
        ai,
        "tools",
        buildPrompt("tools", grant, null, choice),
        [],
        started,
        diag,
        toolSet,
        i < variants.length - 1 ? TOOL_ATTEMPT_CAP_MS : undefined
      );
      facts = result ? await factsFromReply(ai, result.text, started, diag) : null;
      if (!facts) continue;
      const usedUrlContext = toolSet.some((t) => "urlContext" in t);
      sources = result?.urlsRead && result.urlsRead.length ? result.urlsRead : choice.primary ? [choice.primary] : [];
      // If Gemini reported url_context metadata and NOT ONE page was read
      // successfully, we can't have seen the real call text — cap coverage so
      // the verdict can't be "fit" without a human looking (a hard "not fit"
      // still stands). With no metadata at all we trust the model's own rating.
      // A search-only attempt never opened the page, so it is capped the same way.
      if (!usedUrlContext || (result && result.urlsRead !== null && result.urlsRead.length === 0)) {
        facts.source_coverage = "landing_page_only";
        facts.extraction_confidence = Math.min(facts.extraction_confidence, 0.4);
      }
      // A person's own link stays the recorded call link, not a model-guessed one.
      if (choice.pinned && choice.primary) facts.rfp_url = choice.primary;
    }
  }

  if (!facts) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    const why =
      diag.reason ??
      (Date.now() - started >= MIN_MS_FOR_FALLBACK
        ? `Reading the page and finding the official link used up the time available (${elapsed}s) before Gemini could be asked.`
        : "The page could not be read.");
    console.error(`Eligibility check gave up after ${elapsed}s: ${why}`);
    return Response.json(
      {
        error: `Gemini did not return a usable response. ${why} ${linkNote ? `(${linkNote}) ` : ""}${
          choice.pinned
            ? "Your saved link was used as it is and has not been changed. Try again in a minute, or paste the call text into the box under the check button."
            : "Try again in a minute. If it repeats, open the link and check it is the opportunity's own page, put the right link in the Application Tracker (Breakdown → Link), or paste the call text under the check button."
        }`,
      },
      { status: 502 }
    );
  }
  if (isAward(grant)) facts.is_award = true;
  if (!facts.rfp_url) facts.rfp_url = choice.primary ?? grant.application_url;
  // No deadline in the documents? Use the scraper's stored one (if still ahead).
  applyDeadlineFallback(facts, grant.deadline);

  // ── Stage 2: rules → verdict ──
  // Optional private facts live in the burn_profile table (the repo is public);
  // the public-safe defaults in burnProfile.ts are what the check runs on otherwise.
  const loaded = await loadProfile(supabaseAdmin as unknown as ProfileDb); // cast: the full client type makes tsc recurse
  if (loaded.ignored.length) console.warn("burn_profile: ignored invalid keys/entries:", loaded.ignored.join(", "));
  // The private profile is optional: without it the check runs on the public
  // defaults and the verdict is not held back (only logged for the admin).
  if (loaded.source === "default") console.info(`burn_profile not used (${loaded.reason}) — running on the public defaults.`);
  // Mention the link when it was swapped for a better one, or when the call
  // still couldn't be read in full (a stale warning would mislead otherwise).
  const linkForReport = linkNote && (linkReplaced || facts.source_coverage !== "full_rfp") ? linkNote : null;
  const report = buildReport(facts, { sources, model: GEMINI_MODEL, link: linkForReport }, loaded.profile);

  const supportingDocs: SupportingDoc[] = facts.documents_required.map((d) => ({ name: d.name, url: d.url }));
  const grantUpdate = {
    eligible_countries: eligibleCountriesFrom(facts),
    applicant_type: facts.applicant.structure,
    supporting_docs: supportingDocs,
    rfp_url: facts.rfp_url,
    eligibility_checked_at: new Date().toISOString(),
    eligibility_verdict: report.verdict,
    eligibility_score: report.score,
    eligibility_report: report,
  };

  const migrationHint =
    "The eligibility engine's columns are missing — run supabase/eligibility_engine_migration_2026-09-29.sql in the Supabase SQL editor, then try again.";
  const looksLikeMissingColumn = (message: string) =>
    /eligibility_(verdict|score|report)|fit_source|schema cache|does not exist/i.test(message);

  const { error: updateError } = await supabaseAdmin.from("grants").update(grantUpdate).eq("id", grantId);
  if (updateError) {
    return Response.json(
      { error: looksLikeMissingColumn(updateError.message) ? migrationHint : updateError.message },
      { status: 500 }
    );
  }

  // Apply the verdict to this grant's tracker item(s) — never over a person's
  // own Fit / Not fit call (see lib/eligibility/applyVerdict.ts).
  const previousNotes = (grant.eligibility_report as EligibilityReport | null)?.notes_text ?? null;
  const { data: trackerRows, error: trackerFetchError } = await supabaseAdmin
    .from("tracker_items")
    .select("id, fit_status, fit_source, fit_notes")
    .eq("grant_id", grantId);
  if (trackerFetchError) {
    return Response.json(
      { error: looksLikeMissingColumn(trackerFetchError.message) ? migrationHint : trackerFetchError.message },
      { status: 500 }
    );
  }

  const trackerUpdates: { id: string; fit_status: string; fit_source: "auto" | null; fit_notes: string | null }[] = [];
  for (const row of (trackerRows ?? []) as TrackerFitRow[]) {
    const plan = planTrackerUpdate(row, report, previousNotes);
    if (!plan) continue;
    const { error } = await supabaseAdmin
      .from("tracker_items")
      .update({ ...plan, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    trackerUpdates.push({ id: row.id, ...plan });
  }

  // "Needs further review" → the lead gets a 👀 review action point; a re-check
  // that decides it closes the open one (lib/eligibilityReview.ts). A failure
  // here never fails the check itself — it comes back as `review_error`.
  const reviews = await routeReviews(supabaseAdmin as unknown as ReviewDb, grantId, grantUpdate);

  return Response.json({ grant: grantUpdate, tracker: trackerUpdates, ...reviews });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReviewDb = { from: (table: string) => any };

async function routeReviews(
  db: ReviewDb,
  grantId: string,
  grantUpdate: NonNullable<ReviewItem["grant"]>
) {
  try {
    const { data: rows, error: rowsError } = await db
      .from("tracker_items")
      .select("id, owner, fit_status, fit_source, removed_at")
      .eq("grant_id", grantId);
    if (rowsError) return { review_error: rowsError.message as string };
    const items: ReviewItem[] = ((rows ?? []) as ReviewItem[]).map((r) => ({ ...r, grant: grantUpdate }));
    if (!items.length) return {};
    const { data: acts, error: actsError } = await db
      .from("action_items")
      .select("id, tracker_item_id, assignee, done, created_at, created_by, description, origin")
      .in("tracker_item_id", items.map((i) => i.id))
      .eq("origin", REVIEW_ORIGIN);
    if (actsError) return { review_error: actsError.message as string };
    const res = await applyReviewPlan(db, planReviewSync(items, (acts ?? []) as ReviewAction[]));
    return {
      reviews_created: res.created,
      reviews_closed: res.closed,
      ...(res.error ? { review_error: res.error } : {}),
    };
  } catch (e) {
    return { review_error: e instanceof Error ? e.message : String(e) };
  }
}
