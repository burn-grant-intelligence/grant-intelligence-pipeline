// "Paste the call text" fallback for the eligibility check: when a page can't
// be opened automatically (login wall, bot protection, JavaScript-only site,
// LinkedIn post), a person can paste the call's text and the check reads that
// instead. Pure — covered by test/callLink.test.ts.

import type { GatheredSources } from "./fetchSources";

export const MIN_PASTED_CHARS = 150;
export const MAX_PASTED_CHARS = 60_000;

export function pastedSources(raw: unknown): GatheredSources | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_PASTED_CHARS);
  if (text.length < MIN_PASTED_CHARS) return null;
  return {
    parts: [{ text: `--- SOURCE: text pasted by the user ---\n${text}` }],
    used: ["pasted text"],
    notes: ["The call text was pasted by a person rather than fetched from the web."],
    rfpUrl: null,
    textChars: text.length,
    pdfCount: 0,
    coverageHint:
      "The text of the call was pasted in by a person and follows this message. Treat it as the call document. If it looks like only part of the call, say so in source_coverage.",
  };
}
