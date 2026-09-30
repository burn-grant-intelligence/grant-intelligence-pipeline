// Checks that the link we read for a grant really shows the call, and helps
// find the right one when it doesn't. Four situations are caught:
//   • gated      — the page is a login / "create an account" wall
//   • mismatch   — the page is about something else (a listing page, a news
//                  post, a LinkedIn post, a different call)
//   • thin       — only a short page was readable; the real RFP is probably
//                  behind a download, another page or an account
//   • unreadable — nothing could be opened at all
// When the link is not "ok", the route asks Gemini (with Google Search) for the
// official call page and reads that instead (findLinkPrompt / parseFoundLink).
// Everything here is pure (no network), so test/linkCheck.test.ts covers it.

import type { GatheredSources } from "./fetchSources";

export type LinkStatus = "ok" | "gated" | "mismatch" | "thin" | "unreadable";
export interface LinkAssessment {
  status: LinkStatus;
  note: string | null; // plain-language explanation, shown to the user
}

const STOP = new Set([
  "call", "calls", "for", "the", "and", "with", "from", "into", "that", "this", "their", "your", "our",
  "grant", "grants", "funding", "fund", "programme", "program", "application", "applications", "apply",
  "proposal", "proposals", "opportunity", "opportunities", "request", "requests", "round", "window", "facility",
  "2024", "2025", "2026", "2027", "2028", "new", "open", "now",
]);

const tokens = (s: string | null | undefined): string[] =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP.has(t));

// Login / registration walls. Only trusted on SHORT pages — a long page that
// merely has a "Log in" menu item is fine.
const GATE_RE =
  /\b(sign in|log ?in|create (an )?account|register (to|in order to) (view|access|see|apply)|you (must|need to) (be )?(logged|signed|log|sign|register)|members? only|access denied|403 forbidden|401 unauthori[sz]ed|please (log|sign) in|enable javascript|javascript is (required|disabled)|verify you are (a )?human|are you a robot|captcha)\b/i;

export const looksGated = (text: string): boolean => text.length < 4000 && GATE_RE.test(text);

// The readable text we gave the model (PDFs are inline binary, so they aren't here).
export function textOf(g: GatheredSources): string {
  return g.parts
    .map((p) => ("text" in p ? p.text : ""))
    .filter((t) => t && !t.startsWith("--- SOURCE: tracker record"))
    .map((t) => t.replace(/^--- SOURCE:[^\n]*\n?/, ""))
    .join("\n");
}

// Share of the grant title's meaningful words that appear in the page text.
export function titleOverlap(title: string | null, text: string): { total: number; matched: number } {
  const words = [...new Set(tokens(title))];
  const hay = text.toLowerCase();
  return { total: words.length, matched: words.filter((w) => hay.includes(w)).length };
}

export function assessLink(
  g: GatheredSources | null,
  grant: { title: string | null; funder: string | null }
): LinkAssessment {
  if (!g || g.used.length === 0)
    return {
      status: "unreadable",
      note: "We couldn't open the link on file (the site may block automated access, or the link may be broken)",
    };

  // A real document was read: trust it (PDFs can't be text-matched here).
  if (g.pdfCount > 0) return { status: "ok", note: null };

  const text = textOf(g);
  const { total, matched } = titleOverlap(grant.title, text);
  const funderHit = tokens(grant.funder).some((w) => text.toLowerCase().includes(w));
  const titleMiss = total >= 2 && matched / total < 0.4 && !funderHit;

  if (g.textChars > 8000) {
    return titleMiss
      ? { status: "mismatch", note: "The page we read doesn't appear to be about this opportunity (the link on file may point to a listing or a different page)" }
      : { status: "ok", note: null };
  }

  // Short page: explain why it is short.
  if (looksGated(text))
    return {
      status: "gated",
      note: "The page looks like it needs an account or login to show the full call details",
    };
  if (titleMiss)
    return { status: "mismatch", note: "The page we read doesn't appear to be about this opportunity (the link on file may point to a post, a listing or a different page)" };
  if (g.textChars <= 2500)
    return { status: "thin", note: "Only a short page could be read; the full call is probably on another page, in a download, or behind an account" };
  return { status: "ok", note: null };
}

// ── asking Gemini for the official page ──

export function findLinkPrompt(grant: { title: string | null; funder: string | null; application_url: string }): string {
  return `Find the OFFICIAL call page for this funding opportunity. The link on file may be a social-media post (for example LinkedIn), a news item, a listing, a login page, or a different call.

Opportunity: "${grant.title ?? "(untitled)"}"
Funder: ${grant.funder ?? "unknown"}
Link on file: ${grant.application_url}

Use Google Search and the url_context tool. Prefer, in this order: the funder's own call/RFP/guidelines page or PDF; the funder's programme page; a reputable funding database entry. Do NOT return a login page, a social-media post, or a generic listing of many calls. If you cannot find a page you are confident is this exact opportunity, return null.

Return ONLY a JSON object (no prose, no code fences): {"url": "https://..." or null, "reason": "one short sentence on why this is the right page"}`;
}

export function parseFoundLink(text: string): { url: string | null; reason: string } | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const o = JSON.parse(text.slice(start, end + 1)) as { url?: unknown; reason?: unknown };
    const url = typeof o.url === "string" && /^https?:\/\//i.test(o.url.trim()) ? o.url.trim() : null;
    return { url, reason: typeof o.reason === "string" ? o.reason : "" };
  } catch {
    return null;
  }
}

// Google's grounding redirects are not the real page.
export const isGroundingRedirect = (url: string): boolean => /vertexaisearch\.cloud\.google\.com|google\.com\/url\?/i.test(url);
