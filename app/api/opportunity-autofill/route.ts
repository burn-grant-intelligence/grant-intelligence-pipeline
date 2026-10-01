// "✨ Fill with Gemini" in the Application Tracker's Breakdown panel POSTs a
// tracker item id here. It reads the opportunity's link and fills the
// Breakdown fields that are still EMPTY (program name, funder, description,
// target countries, ticket size, deadline, type of funding) — anything a
// person typed is never overwritten. It also double-checks the link:
//   • if the saved link shows the opportunity → noted as checked;
//   • if it is a login wall, a LinkedIn post, a listing or the wrong page →
//     Gemini searches for the official page, we open that page ourselves, and
//     if it really is the call it becomes the link (when none was typed).
// Same environment variables as the eligibility check (GEMINI_API_KEY,
// SUPABASE_SERVICE_ROLE_KEY); writes use the service-role key.

import { GoogleGenAI, ApiError, type Part } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { gatherSources, isSafeUrl, type GatheredSources } from "@/lib/eligibility/fetchSources";
import { assessLink } from "@/lib/eligibility/linkCheck";
import { autofillPrompt, extractJsonObject, fieldsToFill, normalizeAutofill, type AutofillSuggestions } from "@/lib/opportunityAutofill";
import { todayIso } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CALL_DEADLINE_MS = 50_000;

async function askGemini(ai: GoogleGenAI, mode: "sources" | "tools", prompt: string, parts: Part[], started: number): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const abortSignal = AbortSignal.timeout(Math.max(5_000, CALL_DEADLINE_MS - (Date.now() - started)));
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
        config:
          mode === "tools"
            ? { tools: [{ urlContext: {} }, { googleSearch: {} }], temperature: 0.2, abortSignal }
            : { responseMimeType: "application/json", temperature: 0.2, abortSignal },
      });
      if (!response.text) console.warn(`Autofill: Gemini returned no text (${mode}), finishReason=${response.candidates?.[0]?.finishReason ?? "unknown"}`);
      return response.text ?? null;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const retryable = status === 429 || status >= 500;
      if (retryable && attempt === 0 && Date.now() - started < 25_000) {
        await new Promise((r) => setTimeout(r, status === 429 ? 8_000 : 2_000));
        continue;
      }
      console.error(`Autofill: Gemini request failed (${mode} mode):`, err);
      return null;
    }
  }
  return null;
}

export async function POST(request: Request) {
  const started = Date.now();
  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!geminiKey) return Response.json({ error: "GEMINI_API_KEY is not configured on the server." }, { status: 500 });
  if (!supabaseUrl || !serviceRoleKey) return Response.json({ error: "Supabase service-role credentials are not configured on the server." }, { status: 500 });

  let body: { trackerItemId?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const trackerItemId = typeof body.trackerItemId === "string" ? body.trackerItemId : null;
  if (!trackerItemId) return Response.json({ error: "trackerItemId is required." }, { status: 400 });

  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data: item, error: fetchError } = await db
    .from("tracker_items")
    .select("id, program_name, pipeline_funder, pipeline_description, target_countries, ticket_size, pipeline_deadline, pipeline_link, grant:grants(id, title, funder, application_url, rfp_url, type_of_funding)")
    .eq("id", trackerItemId)
    .maybeSingle();
  if (fetchError) {
    const hint = /pipeline_|program_name|ticket_size|target_countries|schema cache|does not exist/i.test(fetchError.message)
      ? "The Opportunity Pipeline columns are missing — run supabase/opportunity_pipeline_migration_2026-10-01.sql in the Supabase SQL editor, then try again."
      : fetchError.message;
    return Response.json({ error: hint }, { status: 500 });
  }
  if (!item) return Response.json({ error: "Opportunity not found." }, { status: 404 });
  const grant = (Array.isArray(item.grant) ? item.grant[0] : item.grant) as
    | { id: string; title: string | null; funder: string | null; application_url: string | null; rfp_url: string | null; type_of_funding: string | null }
    | null;
  const link: string | null = item.pipeline_link || grant?.rfp_url || grant?.application_url || null;
  if (!link) return Response.json({ error: "There is no link for this opportunity yet. Add one in the Link field first." }, { status: 400 });

  const who = { title: item.program_name || grant?.title || null, funder: item.pipeline_funder || grant?.funder || null };
  const ai = new GoogleGenAI({ apiKey: geminiKey });

  // 1. Read the saved link ourselves and check it shows the opportunity.
  const tryGather = async (url: string, budgetMs: number): Promise<GatheredSources | null> => {
    try {
      return await gatherSources(url, "", { budgetMs });
    } catch (err) {
      console.warn("Autofill: could not read", url, (err as Error).message);
      return null;
    }
  };
  const gathered = await tryGather(link, 15_000);
  const assessed = assessLink(gathered, who);

  // 2. Ask Gemini: straight from what we read when the link is good,
  //    otherwise with Google Search so it can find the official page.
  const mode = assessed.status === "ok" && gathered ? "sources" : "tools";
  const text = await askGemini(ai, mode, autofillPrompt({ ...who, link, today: todayIso(), mode }), mode === "sources" ? (gathered!.parts as Part[]) : [], started);
  if (!text) return Response.json({ error: "Gemini did not return a usable answer. Try again shortly." }, { status: 502 });
  let s: AutofillSuggestions;
  try {
    s = normalizeAutofill(JSON.parse(extractJsonObject(text)));
  } catch {
    return Response.json({ error: "Gemini's answer could not be read. Try again shortly." }, { status: 502 });
  }

  // 3. Link double-check.
  let linkNote: string;
  let newLink: string | null = null;
  if (assessed.status === "ok") {
    linkNote = "Link checked: it shows this opportunity.";
  } else {
    const candidate = s.official_link && s.official_link !== link && isSafeUrl(s.official_link) ? s.official_link : null;
    const left = 45_000 - (Date.now() - started);
    const verified = candidate && left > 5_000 ? assessLink(await tryGather(candidate, Math.min(10_000, left)), who).status === "ok" : false;
    if (candidate && verified) {
      newLink = candidate;
      linkNote = `The saved link didn't show this opportunity (${assessed.note?.toLowerCase()}). Found and checked the official page instead.`;
    } else {
      linkNote = `${assessed.note}. ${candidate ? `Gemini suggested ${candidate}, but it couldn't be confirmed — check it manually.` : "Please check the link manually; some opportunities need an account or login to view."}`;
    }
  }

  // 4. Save: only empty fields; the link only when none was typed.
  const { tracker, grantTypeOfFunding } = fieldsToFill({ ...item, type_of_funding: grant?.type_of_funding ?? null }, s);
  const trackerUpdate: Record<string, unknown> = { ...tracker, link_check_note: linkNote, link_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (newLink && !item.pipeline_link) trackerUpdate.pipeline_link = newLink;
  const { error: updateError } = await db.from("tracker_items").update(trackerUpdate).eq("id", trackerItemId);
  if (updateError) return Response.json({ error: updateError.message }, { status: 500 });
  if (grantTypeOfFunding && grant) {
    const { error } = await db.from("grants").update({ type_of_funding: grantTypeOfFunding }).eq("id", grant.id);
    if (error) console.warn("Autofill: could not save type_of_funding:", error.message);
  }

  return Response.json({
    tracker: trackerUpdate,
    grant: grantTypeOfFunding ? { type_of_funding: grantTypeOfFunding } : {},
    filled: [...Object.keys(tracker), ...(grantTypeOfFunding ? ["type_of_funding"] : []), ...(trackerUpdate.pipeline_link ? ["pipeline_link"] : [])],
    linkNote,
  });
}
