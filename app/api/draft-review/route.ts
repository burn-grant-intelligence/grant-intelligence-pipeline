// Draft Application workspace → Gemini. Two actions, both POST JSON:
//
//   { action: "decode", trackerItemId, pastedText? }
//     Reads the call (pasted text, else the TOR text saved on the opportunity,
//     else the call link — the team's own link first) and fills the Brief:
//     objectives, scoring criteria, donor keywords, must-haves, and the
//     questions with their word / character limits. Merged into the existing
//     Brief: anything the team typed is kept (lib/drafting.ts mergeBrief).
//
//   { action: "review", trackerItemId, stage }
//     Reviews that stage's saved draft against the stage checklist, the Brief,
//     management's guidance, the meeting notes at that stage, the stage notes and borrowed learnings,
//     and saves the result on draft_stage_work.review.
//
// Same environment variables as the eligibility check (GEMINI_API_KEY,
// SUPABASE_SERVICE_ROLE_KEY, optional GEMINI_MODEL). Writes use the service role.

import { GoogleGenAI, ApiError, type Part, type Tool } from "@google/genai";
import { createClient } from "@supabase/supabase-js";
import { gatherSources, type GatheredSources } from "@/lib/eligibility/fetchSources";
import { assessLink } from "@/lib/eligibility/linkCheck";
import { pastedSources } from "@/lib/eligibility/pastedText";
import {
  buildDecodePrompt, buildReviewPrompt, callLink, extractJson, hasDraft, isDraftStage, mergeBrief, normalizeBrief, normalizeReview,
  pickLearnings, prevStage, stageMeta,
} from "@/lib/drafting";
import { effectiveFields } from "@/lib/pipeline";
import type { ActionItem, DraftGuidance, DraftLearning, DraftStageWork, OpportunityNote, TrackerItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const CALL_DEADLINE_MS = 55_000;

const MIGRATION_HINT =
  "The Draft Application tables are missing — run supabase/draft_stages_migration_2026-10-02.sql in the Supabase SQL editor, then try again.";
const looksMissing = (m: string) => /draft_stage|draft_brief|draft_learnings|draft_guidance|clickup_url|schema cache|does not exist/i.test(m);

interface Ask {
  text: string | null;
  reason: string | null;
}

async function askGemini(ai: GoogleGenAI, prompt: string, parts: Part[], started: number, tools?: Tool[], capMs?: number): Promise<Ask> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const abortSignal = AbortSignal.timeout(Math.max(5_000, Math.min(capMs ?? Infinity, CALL_DEADLINE_MS - (Date.now() - started))));
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }, ...parts] }],
        // Gemini 2.5 can't combine JSON mode with tools, so tool calls ask for
        // JSON in the prompt and the reply is parsed leniently.
        config: tools ? { tools, temperature: 0.2, abortSignal } : { responseMimeType: "application/json", temperature: 0.2, abortSignal },
      });
      if (!response.text) {
        const finish = response.candidates?.[0]?.finishReason;
        const blocked = response.promptFeedback?.blockReason;
        console.warn(`Draft review: Gemini returned no text (${tools ? "tools" : "json"}), finishReason=${finish ?? "unknown"}${blocked ? `, blockReason=${blocked}` : ""}`);
        return { text: null, reason: blocked ? `Gemini blocked the request (${blocked}).` : `Gemini returned an empty answer${finish ? ` (finish reason: ${finish})` : ""}.` };
      }
      return { text: response.text, reason: null };
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const retryable = status === 429 || status >= 500;
      if (retryable && attempt === 0 && Date.now() - started < 25_000) {
        await new Promise((r) => setTimeout(r, status === 429 ? 8_000 : 2_000));
        continue;
      }
      console.error("Draft review: Gemini request failed:", err);
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        text: null,
        reason: timedOut ? "Gemini took too long (timed out)." : status === 429 ? "Gemini is rate-limited right now (too many requests)." : status ? `Gemini returned an error (HTTP ${status}).` : "The request to Gemini failed.",
      };
    }
  }
  return { text: null, reason: "The request to Gemini failed." };
}

export async function POST(request: Request) {
  const started = Date.now();
  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!geminiKey) return Response.json({ error: "GEMINI_API_KEY is not configured on the server." }, { status: 500 });
  if (!supabaseUrl || !serviceRoleKey) return Response.json({ error: "Supabase service-role credentials are not configured on the server." }, { status: 500 });

  let body: { action?: unknown; trackerItemId?: unknown; stage?: unknown; pastedText?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const trackerItemId = typeof body.trackerItemId === "string" ? body.trackerItemId : null;
  if (!trackerItemId) return Response.json({ error: "trackerItemId is required." }, { status: 400 });
  if (body.action !== "decode" && body.action !== "review") return Response.json({ error: 'action must be "decode" or "review".' }, { status: 400 });

  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data: itemRow, error: itemError } = await db.from("tracker_items").select("*, grant:grants(*)").eq("id", trackerItemId).maybeSingle();
  if (itemError) return Response.json({ error: looksMissing(itemError.message) ? MIGRATION_HINT : itemError.message }, { status: 500 });
  if (!itemRow) return Response.json({ error: "Opportunity not found." }, { status: 404 });
  const item = itemRow as unknown as TrackerItem;
  const ai = new GoogleGenAI({ apiKey: geminiKey });

  // ───────────── decode the call into the Brief ─────────────
  if (body.action === "decode") {
    let gathered: GatheredSources | null = pastedSources(body.pastedText) ?? pastedSources(item.tor_text);
    let source = gathered ? (pastedSources(body.pastedText) ? "pasted text" : "TOR text saved on the opportunity") : null;
    const link = callLink(item);
    if (!gathered && link) {
      try {
        const g = await gatherSources(link, "", { budgetMs: 20_000 });
        if (assessLink(g, { title: effectiveFields(item).programName, funder: effectiveFields(item).funder }).status === "ok") {
          gathered = g;
          source = g.used.join(", ");
        }
      } catch (err) {
        console.warn("Draft decode: could not read the call link:", (err as Error).message);
      }
    }
    if (!gathered && !link) {
      return Response.json({ error: "There is no call link or TOR text to read. Add the link in the Application Tracker (Breakdown → Link), or paste the call text here." }, { status: 400 });
    }

    let ask: Ask;
    if (gathered) {
      ask = await askGemini(ai, buildDecodePrompt(item, true), gathered.parts as Part[], started);
    } else {
      // Our own fetch couldn't read the page: let Gemini open it (then search alone).
      ask = await askGemini(ai, buildDecodePrompt(item, false), [], started, [{ urlContext: {} }, { googleSearch: {} }], 30_000);
      if (!ask.text && Date.now() - started < 35_000) ask = await askGemini(ai, buildDecodePrompt(item, false), [], started, [{ googleSearch: {} }]);
      source = link ? `${link} (read by Gemini)` : "Google Search";
    }
    const decoded = ask.text ? normalizeBrief(extractJson(ask.text), item.draft_brief) : null;
    if (!decoded) {
      return Response.json(
        { error: `Gemini could not read the call's questions. ${ask.reason ?? "Its answer had no usable questions or criteria."} Paste the call text (or the application form) into the box and try again.` },
        { status: 502 }
      );
    }
    const brief = mergeBrief(item.draft_brief, { ...decoded, decoded_at: new Date().toISOString(), source });
    const { error } = await db.from("tracker_items").update({ draft_brief: brief, updated_at: new Date().toISOString() }).eq("id", trackerItemId);
    if (error) return Response.json({ error: looksMissing(error.message) ? MIGRATION_HINT : error.message }, { status: 500 });
    return Response.json({ brief, found: { questions: decoded.questions.length, criteria: decoded.criteria.length } });
  }

  // ───────────── review one stage ─────────────
  if (!isDraftStage(body.stage)) return Response.json({ error: "stage must be concept or first_draft." }, { status: 400 });
  const stage = body.stage;
  const before = prevStage(stage);
  const [workRes, notesRes, actionsRes, learnRes, guidanceRes] = await Promise.all([
    db.from("draft_stage_work").select("*").eq("tracker_item_id", trackerItemId).in("stage", before ? [stage, before] : [stage]),
    db.from("opportunity_notes").select("*").eq("tracker_item_id", trackerItemId),
    db.from("action_items").select("*").eq("tracker_item_id", trackerItemId),
    db.from("draft_learnings").select("*").order("created_at", { ascending: false }).limit(300),
    db.from("draft_guidance").select("*").eq("tracker_item_id", trackerItemId),
  ]);
  if (workRes.error) return Response.json({ error: looksMissing(workRes.error.message) ? MIGRATION_HINT : workRes.error.message }, { status: 500 });
  const rows = (workRes.data ?? []) as DraftStageWork[];
  const work = rows.find((r) => r.stage === stage) ?? null;
  const previous = before ? rows.find((r) => r.stage === before) ?? null : null;
  if (!hasDraft(item.draft_brief, work)) {
    return Response.json({ error: `Nothing is saved for the ${stageMeta(stage).label.toLowerCase()} yet. Paste or write the draft in the Draft tab first.` }, { status: 400 });
  }
  if (learnRes.error) console.warn("Draft review: learnings not loaded:", learnRes.error.message);
  const learnings = pickLearnings((learnRes.data ?? []) as DraftLearning[], { trackerItemId, funder: effectiveFields(item).funder, stage });

  if (guidanceRes.error) console.warn("Draft review: management guidance not loaded:", guidanceRes.error.message);
  const prompt = buildReviewPrompt({
    item,
    stage,
    work,
    previous,
    notes: (notesRes.data ?? []) as OpportunityNote[],
    actions: (actionsRes.data ?? []) as ActionItem[],
    learnings,
    guidance: (guidanceRes.data ?? []) as DraftGuidance[],
  });
  const ask = await askGemini(ai, prompt, [], started);
  const review = ask.text ? normalizeReview(extractJson(ask.text)) : null;
  if (!review) {
    return Response.json({ error: `Gemini did not return a usable review. ${ask.reason ?? "Its answer could not be read."} Try again in a minute, or use "Copy prompt → Claude" instead.` }, { status: 502 });
  }
  review.model = GEMINI_MODEL;
  const reviewed_at = new Date().toISOString();
  const { error } = await db.from("draft_stage_work").update({ review, reviewed_at }).eq("id", work!.id);
  if (error) return Response.json({ error: looksMissing(error.message) ? MIGRATION_HINT : error.message }, { status: 500 });
  return Response.json({ review, reviewed_at, learningsUsed: learnings.length });
}
