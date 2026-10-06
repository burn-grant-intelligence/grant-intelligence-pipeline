import type { Grant } from "./types";
import { isAward, normalizeTag } from "./opportunityType";

// The Grant Scanner's sections, in BURN's order of priority:
//   1. Clean cooking calls — the core business
//   2. Large-ticket, catalytic & RBF — big grants (USD 1M+), results-based,
//      catalytic / concessional / blended funding, and the priority funders
//      (FID, DIV, DGBP, …), whatever the sector
//   3. Other open calls — energy, climate, manufacturing, gender, innovation …
//   4. Awards & prizes
// Mirrors the order scripts/gemini_discover.py searches in
// (config/grant_search.yaml). A clean-cooking call that is also large-ticket
// stays in section 1 and gets a "Large ticket" badge.

export type SectionKey = "clean_cooking" | "large_ticket" | "other_calls" | "awards";

export const SECTIONS: { key: SectionKey; icon: string; label: string; hint: string; empty: string }[] = [
  {
    key: "clean_cooking",
    icon: "🔥",
    label: "Clean cooking calls",
    hint: "Core business: cookstoves, eCooking, LPG, ethanol, institutional cooking, clean-cooking RBF and carbon",
    empty: "No open clean-cooking calls right now. Each Gemini run searches these first, and searches harder when it finds few.",
  },
  {
    key: "large_ticket",
    icon: "💼",
    label: "Large-ticket, catalytic & RBF",
    hint: "USD 1M+ grants, results-based, catalytic and concessional funding, and priority funders (FID, DIV, DGBP …)",
    empty: "No large-ticket or catalytic calls open right now.",
  },
  {
    key: "other_calls",
    icon: "📣",
    label: "Other open calls",
    hint: "Energy, climate, manufacturing, gender and innovation calls",
    empty: "No other open calls right now.",
  },
  {
    key: "awards",
    icon: "🏆",
    label: "Awards & prizes",
    hint: "From the twice-weekly awards run",
    empty: "No open awards or prizes right now.",
  },
];

export const LARGE_TICKET_USD = 1_000_000;

// Rough USD rates, only for sorting calls into "large ticket" and for the
// Min value filter — not for budgets. Update now and then.
const USD_PER_UNIT: Record<string, number> = {
  USD: 1, EUR: 1.1, GBP: 1.3, CHF: 1.15, DKK: 0.15, SEK: 0.095, NOK: 0.095, CAD: 0.73, AUD: 0.66, JPY: 0.0068,
  CNY: 0.14, INR: 0.012, ZAR: 0.055, KES: 0.0077, TZS: 0.0004, UGX: 0.00027, RWF: 0.0007, NGN: 0.00065,
  GHS: 0.08, ZMW: 0.04, MWK: 0.00058, ETB: 0.008, XOF: 0.0017, XAF: 0.0017, MZN: 0.016,
};
const CURRENCY_ALIASES: Record<string, string> = { "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP", EURO: "EUR", EUROS: "EUR", DOLLARS: "USD" };

/** The amount in USD (roughly), or null when there is no amount or the currency is unknown. */
export function amountInUsd(amount: number | null | undefined, currency: string | null | undefined): number | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  const code = (currency ?? "USD").trim().toUpperCase();
  const rate = USD_PER_UNIT[CURRENCY_ALIASES[code] ?? code];
  return rate == null ? null : amount * rate;
}

type Classifiable = Pick<Grant, "title" | "funder" | "description" | "focus_areas" | "amount" | "currency" | "type_of_funding">;

const textOf = (g: Classifiable) => [g.title, g.funder, g.description].filter(Boolean).join(" ");

// Same rule as is_clean_cooking() in scripts/gemini_discover.py.
const CLEAN_COOKING_TEXT =
  /clean[\s-]*cook|cook[\s-]*stoves?|\be[\s-]?cook|electric (pressure )?cook|induction cook|cooking (fuel|energy|solution|appliance|technolog)|\blpg\b|bio[\s-]?ethanol|improved (biomass )?stoves?/i;

export function isCleanCooking(g: Classifiable): boolean {
  if ((g.focus_areas ?? []).some((t) => normalizeTag(t) === "cleancooking")) return true;
  return CLEAN_COOKING_TEXT.test(textOf(g));
}

const CATALYTIC_TEXT =
  /results[\s-]*based financ|\brbf\b|catalytic|concessional|blended financ|first[\s-]*loss|viability gap|challenge fund|advance (market|purchase) commitment/i;

// Large funders whose calls belong here whatever their size (the priority
// funders in config/grant_search.yaml, by name or acronym).
const PRIORITY_FUNDER_TEXT =
  /fund for innovation in development|\bfid\b|development innovation ventures|\bdiv\b|danida|\bdgbp\b|developpp|\baecf\b|africa enterprise challenge|eep africa|energy and environment partnership|transforming energy access|\bp4g\b|global innovation fund|beyond the grid|\bbgfa\b|modern cooking facility|\bmcfa\b|clean cooking fund|\besmap\b/i;

export function isLargeTicket(g: Classifiable): boolean {
  const usd = amountInUsd(g.amount, g.currency);
  if (usd != null && usd >= LARGE_TICKET_USD) return true;
  return CATALYTIC_TEXT.test(textOf(g)) || PRIORITY_FUNDER_TEXT.test(g.funder ?? "") || PRIORITY_FUNDER_TEXT.test(g.title ?? "");
}

/** USD 1M+ on its own (for the badge). */
export function isBigTicket(g: Classifiable): boolean {
  const usd = amountInUsd(g.amount, g.currency);
  return usd != null && usd >= LARGE_TICKET_USD;
}

export function sectionOf(g: Classifiable): SectionKey {
  if (isAward(g)) return "awards";
  if (isCleanCooking(g)) return "clean_cooking";
  if (isLargeTicket(g)) return "large_ticket";
  return "other_calls";
}

// ── Search ──
// Every word typed must appear somewhere in the title, funder, summary,
// eligibility, geography or tags (any order, any case).
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}&-]/gu, ""))
    .filter((w) => w.length > 0);
}

export function matchesSearch(
  g: Pick<Grant, "title" | "funder" | "description" | "eligibility" | "geography" | "focus_areas">,
  words: string[],
): boolean {
  if (!words.length) return true;
  const hay = [g.title, g.funder, g.description, g.eligibility, g.geography, ...(g.focus_areas ?? [])].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Title matches first, then funder matches, then the rest (stable). */
export function searchRank(g: Pick<Grant, "title" | "funder">, words: string[]): number {
  const title = (g.title ?? "").toLowerCase();
  const funder = (g.funder ?? "").toLowerCase();
  if (words.every((w) => title.includes(w))) return 0;
  if (words.every((w) => title.includes(w) || funder.includes(w))) return 1;
  return 2;
}

/** The longest word, safe to put in a PostgREST ilike filter (letters, digits, - only). */
export function serverSearchTerm(words: string[]): string | null {
  const safe = words.map((w) => w.replace(/[^\p{L}\p{N}-]/gu, "")).filter((w) => w.length >= 2);
  if (!safe.length) return null;
  return safe.reduce((a, b) => (b.length > a.length ? b : a));
}
