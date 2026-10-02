// "Is this the same opportunity we already have?" — the 75% title rule, for
// the daily scan (scripts/scan.mjs). The SAME rules live in
// lib/titleSimilarity.ts (the app) and scripts/title_similarity.py (Gemini and
// LinkedIn scrapers); all three are checked against
// test/title_similarity_cases.json — change all three together.

export const DUPLICATE_THRESHOLD = 0.75;

const STOPWORDS = new Set([
  "the", "and", "of", "for", "in", "on", "at", "to", "a", "an", "by", "with", "from", "under", "its", "our", "your",
  "call", "open", "now", "new", "apply", "application", "invitation", "announcement", "announcing",
]);

const PLACES = new Set([
  "kenya", "tanzania", "uganda", "rwanda", "burundi", "ethiopia", "ghana", "nigeria", "zambia", "malawi", "mozambique",
  "senegal", "cameroon", "benin", "togo", "mali", "niger", "chad", "sudan", "somalia", "zimbabwe", "botswana", "namibia",
  "madagascar", "drc", "congo", "liberia", "guinea", "egypt", "morocco", "tunisia", "algeria", "ivoire", "ivory", "lesotho",
  "eswatini", "angola", "gambia", "india", "bangladesh", "nepal", "pakistan", "indonesia", "vietnam", "philippines",
  "cambodia", "myanmar", "haiti", "peru", "colombia", "brazil", "mexico",
  "east", "west", "north", "south", "southern", "central", "sahel",
]);

function stem(w) {
  if (w === "programme") return "program";
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function titleTokens(title) {
  const text = String(title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ");
  const words = new Set();
  const numbers = new Set();
  const places = new Set();
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

const overlap = (a, b) => [...a].filter((x) => b.has(x)).length;
const disjoint = (a, b) => a.size > 0 && b.size > 0 && overlap(a, b) === 0;

export function compareTitles(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.words.size || !tb.words.size) return { same: false, score: 0, reason: "empty title" };
  const shared = overlap(ta.words, tb.words);
  const score = (2 * shared) / (ta.words.size + tb.words.size);
  const rounded = Math.round(score * 100) / 100;
  if (disjoint(ta.numbers, tb.numbers)) return { same: false, score: rounded, reason: "different numbers (year / round)" };
  if (disjoint(ta.places, tb.places)) return { same: false, score: rounded, reason: "different places" };
  if (score >= DUPLICATE_THRESHOLD) return { same: true, score: rounded, reason: `${Math.round(score * 100)}% of the wording matches` };
  const smaller = Math.min(ta.words.size, tb.words.size);
  if (smaller >= 3 && shared / smaller >= 0.9 && score >= 0.5) return { same: true, score: rounded, reason: "one title contains the other" };
  return { same: false, score: rounded, reason: `${Math.round(score * 100)}% of the wording matches` };
}

export function findSimilarTitle(title, existing) {
  let best = null;
  for (const row of existing) {
    const result = compareTitles(title, row.title);
    if (result.same && (!best || result.score > best.result.score)) best = { match: row, result };
  }
  return best;
}
