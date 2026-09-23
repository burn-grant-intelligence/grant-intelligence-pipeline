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
// Mirrors scripts/gemini_discover.py's extraction pattern (url_context +
// google_search tools together, JSON-in-prose parsing via
// extractJsonObject(), retry-on-429) rather than inventing a new approach —
// see that file's call_gemini()/extract_json_object() for the Python
// original this is deliberately kept in sync with.

import { GoogleGenAI, ApiError, type Tool } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { ApplicantType, SupportingDoc } from "@/lib/types";

export const runtime = "nodejs";

// Keep in sync with scripts/gemini_discover.py's GEMINI_MODEL — never
// live-verified against a real API call in this build sandbox (no API key
// available here); if this 404s in production, check
// ai.google.dev/gemini-api/docs/models.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_MAX_RETRIES = 3;
const GEMINI_RETRY_BACKOFF_SECONDS = 20;

const ELIGIBILITY_PROMPT_TEMPLATE = `Read the page at the URL below using your url_context tool, and extract the eligibility picture for this funding opportunity, so a grants team can judge whether they qualify to apply BEFORE investing time drafting a proposal.

You also have Google Search available. If url_context does not show you the specific opportunity itself (a list, an unrelated page, or something empty/broken instead), use Google Search to find the correct page for "{{title}}" by {{funder}} — search by its name and funder — then read that page with url_context instead of giving up.

Opportunity: "{{title}}"
Funder: {{funder}}
URL: {{url}}

Return ONLY a JSON object (no prose, no markdown code fences) with exactly this shape:
{
  "eligible_countries": string[],
  "applicant_type": "single" | "consortium" | "either" | "unclear",
  "supporting_docs": [{"name": string, "url": string | null}],
  "rfp_url": string | null
}

Field-by-field rules:
- eligible_countries: the countries or regions an applicant must be based in or operate in to qualify — e.g. ["Kenya", "Tanzania"], or ["Sub-Saharan Africa"], or ["Global"] if there's genuinely no geographic restriction. Use [] if the page truly doesn't say, rather than guessing.
- applicant_type: "single" if only individual/standalone organizations may apply, "consortium" if a partnership/consortium is required, "either" if both are explicitly allowed, "unclear" if the page doesn't say.
- supporting_docs: named application materials the page links to or lists by name — e.g. "Application Form", "Budget Template", "Concept Note Template", "Terms of Reference". Use [] if the page doesn't enumerate specific documents (don't invent generic ones like "proposal" just to fill the list).
- rfp_url: the single best link to the full call/RFP/ToR/guidelines document — the page URL above if nothing more specific is found, never null unless truly nothing is available.

Base every field only on what the page (or your search) actually shows. Use "unclear" / [] / null rather than fabricating specifics that aren't stated.`;

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

async function callGemini(ai: GoogleGenAI, prompt: string): Promise<string | null> {
  const tools: Tool[] = [{ urlContext: {} }, { googleSearch: {} }];
  for (let attempt = 0; attempt < GEMINI_MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: { tools },
      });
      return response.text ?? null;
    } catch (err) {
      const isRateLimited = err instanceof ApiError && err.status === 429;
      if (isRateLimited && attempt < GEMINI_MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, GEMINI_RETRY_BACKOFF_SECONDS * 1000));
        continue;
      }
      console.error("Gemini eligibility request failed:", err);
      return null;
    }
  }
  return null;
}

function asApplicantType(value: unknown): ApplicantType {
  const allowed: ApplicantType[] = ["single", "consortium", "either", "unclear"];
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as ApplicantType)
    : "unclear";
}

function asSupportingDocs(value: unknown): SupportingDoc[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((doc): doc is Record<string, unknown> => !!doc && typeof doc === "object")
    .filter((doc) => typeof doc.name === "string" && doc.name.trim())
    .map((doc) => ({
      name: (doc.name as string).trim(),
      url: typeof doc.url === "string" && doc.url.trim() ? doc.url.trim() : null,
    }));
}

export async function POST(request: Request) {
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

  let body: { grantId?: unknown };
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
    .select("id, title, funder, application_url")
    .eq("id", grantId)
    .maybeSingle();

  if (fetchError) {
    return Response.json({ error: fetchError.message }, { status: 500 });
  }
  if (!grant) {
    return Response.json({ error: "Grant not found." }, { status: 404 });
  }
  if (!grant.application_url) {
    return Response.json(
      {
        error:
          "This grant has no source link on file, so there's nothing for Gemini to read. Add a link to the opportunity first (Application Tracker's \"+ Add grant\" form, or the grants table directly), then try again.",
      },
      { status: 400 }
    );
  }

  const ai = new GoogleGenAI({ apiKey: geminiKey });
  const prompt = ELIGIBILITY_PROMPT_TEMPLATE.replace(/\{\{title\}\}/g, grant.title ?? "(untitled grant)")
    .replace(/\{\{funder\}\}/g, grant.funder ?? "an unnamed funder")
    .replace(/\{\{url\}\}/g, grant.application_url);

  const text = await callGemini(ai, prompt);
  if (!text) {
    return Response.json(
      { error: "Gemini did not return a usable response. Try again shortly." },
      { status: 502 }
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    return Response.json(
      { error: "Gemini's response could not be parsed as JSON." },
      { status: 502 }
    );
  }

  const eligibleCountries = Array.isArray(parsed.eligible_countries)
    ? parsed.eligible_countries.filter((c): c is string => typeof c === "string")
    : [];
  const applicantType = asApplicantType(parsed.applicant_type);
  const supportingDocs = asSupportingDocs(parsed.supporting_docs);
  const rfpUrl =
    typeof parsed.rfp_url === "string" && parsed.rfp_url.trim()
      ? parsed.rfp_url.trim()
      : grant.application_url;

  const update = {
    eligible_countries: eligibleCountries,
    applicant_type: applicantType,
    supporting_docs: supportingDocs,
    rfp_url: rfpUrl,
    eligibility_checked_at: new Date().toISOString(),
  };

  const { error: updateError } = await supabaseAdmin.from("grants").update(update).eq("id", grantId);
  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  return Response.json(update);
}
