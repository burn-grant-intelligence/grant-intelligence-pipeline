// "Is this the same opportunity we already have?" — the 75% title rule.
//
// Two titles count as the same opportunity when about 75% of their meaningful
// words match, in any order:
//   "Call for Solutions Horizon Europe EU 2027"  ≈  "EU 2027 Call for Solutions"
// unless they clearly point at different things:
//   • different numbers  ("Energy Catalyst Round 10" vs "Round 11", "SDG Award 2026" vs "2027")
//   • different places   ("… RBF Kenya" vs "… RBF Tanzania", "East Africa" vs "West Africa")
//
// The SAME rules live in scripts/title_similarity.py (Gemini and LinkedIn
// scrapers) and scripts/titleSimilarity.mjs (the daily scan). All three are
// checked against one shared list of examples, test/title_similarity_cases.json,
// so change the examples and all three files together.

export const DUPLICATE_THRESHOLD = 0.75;

// Words that carry no meaning for "which call is this".
const STOPWORDS = new Set([
  "the", "and", "of", "for", "in", "on", "at", "to", "a", "an", "by", "with", "from", "under", "its", "our", "your",
  "call", "open", "now", "new", "apply", "application", "invitation", "announcement", "announcing",
]);

// Places: two titles naming different places are different opportunities.
const PLACES = new Set([
  "kenya", "tanzania", "uganda", "rwanda", "burundi", "ethiopia", "ghana", "nigeria", "zambia", "malawi", "mozambique",
  "senegal", "cameroon", "benin", "togo", "mali", "niger", "chad", "sudan", "somalia", "zimbabwe", "botswana", "namibia",
  "madagascar", "drc", "congo", "liberia", "guinea", "egypt", "morocco", "tunisia", "algeria", "ivoire", "ivory", "lesotho",
  "eswatini", "angola", "gambia", "india", "bangladesh", "nepal", "pakistan", "indonesia", "vietnam", "philippines",
  "cambodia", "myanmar", "haiti", "peru", "colombia", "brazil", "mexico",
  "east", "west", "north", "south", "southern", "central", "sahel",
]);

export interface TitleTokens {
  words: Set<string>; // every meaningful word, numbers included
  numbers: Set<string>; // 2027, 10 (from "10th"), …
  places: Set<string>;
}

function stem(w: string): string {
  if (w === "programme") return "program";
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function titleTokens(title: string | null | undefined): TitleTokens {
  const text = (title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ");
  const words = new Set<string>();
  const numbers = new Set<string>();
  const places = new Set<string>();
  for (const raw of text.match(/[a-z0-9]+/g) ?? []) {
    const ordinal = /^(\d+)(st|nd|rd|th)$/.exec(raw);
    const w = ordinal ? ordinal[1] : stem(raw);
    if (STOPWORDS.has(raw) || STOPWORDS.has(w)) continue;
    words.add(w);
    if (/^\d+$/.test(w)) numbers.add(String(Number(w)));
    if (PLACES.has(w)) places.add(w);
  }
  return { words, numbers, places };
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
const disjoint = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && overlap(a, b) === 0;

export interface SimilarityResult {
  same: boolean;
  score: number; // 0–1: share of matching words (Dice coefficient)
  reason: string;
}

export function compareTitles(a: string | null | undefined, b: string | null | undefined): SimilarityResult {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.words.size || !tb.words.size) return { same: false, score: 0, reason: "empty title" };
  const shared = overlap(ta.words, tb.words);
  const score = (2 * shared) / (ta.words.size + tb.words.size);
  const rounded = Math.round(score * 100) / 100;
  if (disjoint(ta.numbers, tb.numbers)) return { same: false, score: rounded, reason: "different numbers (year / round)" };
  if (disjoint(ta.places, tb.places)) return { same: false, score: rounded, reason: "different places" };
  if (score >= DUPLICATE_THRESHOLD) return { same: true, score: rounded, reason: `${Math.round(score * 100)}% of the wording matches` };
  // A short title wholly inside a longer one ("EU 2027 Call for Solutions" inside the full name).
  const smaller = Math.min(ta.words.size, tb.words.size);
  if (smaller >= 3 && shared / smaller >= 0.9 && score >= 0.5) return { same: true, score: rounded, reason: "one title contains the other" };
  return { same: false, score: rounded, reason: `${Math.round(score * 100)}% of the wording matches` };
}

export const isSameOpportunity = (a: string | null | undefined, b: string | null | undefined) => compareTitles(a, b).same;

// The closest existing opportunity that counts as the same one, or null.
export function findSimilarTitle<T extends { title: string | null }>(title: string, existing: T[]): { match: T; result: SimilarityResult } | null {
  let best: { match: T; result: SimilarityResult } | null = null;
  for (const row of existing) {
    const result = compareTitles(title, row.title);
    if (result.same && (!best || result.score > best.result.score)) best = { match: row, result };
  }
  return best;
}
