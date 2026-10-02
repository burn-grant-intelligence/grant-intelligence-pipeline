""""Is this the same opportunity we already have?" — the 75% title rule.

Two titles count as the same opportunity when about 75% of their meaningful
words match, in any order:
    "Call for Solutions Horizon Europe EU 2027"  ~  "EU 2027 Call for Solutions"
unless they clearly point at different things:
    - different numbers ("Energy Catalyst Round 10" vs "Round 11", "SDG Award 2026" vs "2027")
    - different places  ("... RBF Kenya" vs "... RBF Tanzania", "East Africa" vs "West Africa")

The SAME rules live in lib/titleSimilarity.ts (the app) and
scripts/titleSimilarity.mjs (the daily scan). All three are checked against one
shared list of examples, test/title_similarity_cases.json, so change the
examples and all three files together.
"""

from __future__ import annotations

import re
import unicodedata

DUPLICATE_THRESHOLD = 0.75

STOPWORDS = {
    "the", "and", "of", "for", "in", "on", "at", "to", "a", "an", "by", "with", "from", "under", "its", "our", "your",
    "call", "open", "now", "new", "apply", "application", "invitation", "announcement", "announcing",
}

PLACES = {
    "kenya", "tanzania", "uganda", "rwanda", "burundi", "ethiopia", "ghana", "nigeria", "zambia", "malawi", "mozambique",
    "senegal", "cameroon", "benin", "togo", "mali", "niger", "chad", "sudan", "somalia", "zimbabwe", "botswana", "namibia",
    "madagascar", "drc", "congo", "liberia", "guinea", "egypt", "morocco", "tunisia", "algeria", "ivoire", "ivory", "lesotho",
    "eswatini", "angola", "gambia", "india", "bangladesh", "nepal", "pakistan", "indonesia", "vietnam", "philippines",
    "cambodia", "myanmar", "haiti", "peru", "colombia", "brazil", "mexico",
    "east", "west", "north", "south", "southern", "central", "sahel",
}


def _stem(w: str) -> str:
    if w == "programme":
        return "program"
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def title_tokens(title: str | None) -> tuple[set[str], set[str], set[str]]:
    """(words, numbers, places) — see lib/titleSimilarity.ts titleTokens."""
    text = unicodedata.normalize("NFKD", title or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower().replace("&", " and ")
    words: set[str] = set()
    numbers: set[str] = set()
    places: set[str] = set()
    for raw in re.findall(r"[a-z0-9]+", text):
        ordinal = re.fullmatch(r"(\d+)(st|nd|rd|th)", raw)
        w = ordinal.group(1) if ordinal else _stem(raw)
        if raw in STOPWORDS or w in STOPWORDS:
            continue
        words.add(w)
        if w.isdigit():
            numbers.add(str(int(w)))
        if w in PLACES:
            places.add(w)
    return words, numbers, places


def _disjoint(a: set[str], b: set[str]) -> bool:
    return bool(a) and bool(b) and not (a & b)


def compare_titles(a: str | None, b: str | None) -> tuple[bool, float, str]:
    """(same, score 0-1, reason)."""
    wa, na, pa = title_tokens(a)
    wb, nb, pb = title_tokens(b)
    if not wa or not wb:
        return False, 0.0, "empty title"
    shared = len(wa & wb)
    score = 2 * shared / (len(wa) + len(wb))
    rounded = round(score, 2)
    if _disjoint(na, nb):
        return False, rounded, "different numbers (year / round)"
    if _disjoint(pa, pb):
        return False, rounded, "different places"
    if score >= DUPLICATE_THRESHOLD:
        return True, rounded, f"{round(score * 100)}% of the wording matches"
    smaller = min(len(wa), len(wb))
    if smaller >= 3 and shared / smaller >= 0.9 and score >= 0.5:
        return True, rounded, "one title contains the other"
    return False, rounded, f"{round(score * 100)}% of the wording matches"


def is_same_opportunity(a: str | None, b: str | None) -> bool:
    return compare_titles(a, b)[0]


def find_similar_title(title: str, existing: list[dict]) -> tuple[dict, float, str] | None:
    """The closest row in `existing` (dicts with a "title") that counts as the
    same opportunity, as (row, score, reason) — or None."""
    best = None
    for row in existing:
        same, score, reason = compare_titles(title, row.get("title"))
        if same and (best is None or score > best[1]):
            best = (row, score, reason)
    return best
