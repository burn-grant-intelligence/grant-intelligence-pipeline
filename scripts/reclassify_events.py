"""
Re-scores already-saved `events` rows against config/taxonomy.yaml's current
topic tiers, relevance_levels and exclusions. New events are already scored
as scripts/gemini_discover.py saves them — use this after retuning the
taxonomy, to
apply it to events already in the database instead of waiting for them to
resurface (or not) on the next scripts/gemini_discover.py run.

Classifies against each event's own stored `fit_analysis`/`description` text
(no page re-fetch — gemini_discover.py no longer does its own direct
fetching, relying on Gemini's own Google Search/url_context tools instead)
— one Gemini call per event, no extra storage or fetch machinery needed.

An event newly scored "not_relevant" is soft-excluded the same way the
Events tab's discard (X) button works: discarded = true, row kept for
audit, not deleted.

Run locally:  GEMINI_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/reclassify_events.py
"""

import sys
from datetime import datetime, timezone

import requests

from gemini_discover import SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, classify_event

HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}


def load_active_events() -> list[dict]:
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/events",
        headers=HEADERS,
        params={
            "select": "id,title,location,geography,description,fit_analysis",
            "discarded": "eq.false",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def update_classification(event_id: str, classification: dict, keep: bool) -> None:
    row = {
        "core_topics": classification["core_topics"],
        "primary_topics": classification["primary_topics"],
        "secondary_topics": classification["secondary_topics"],
        "relevance_level": classification["relevance_level"],
        "relevance_rationale": classification["relevance_rationale"],
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }
    if not keep:
        row["discarded"] = True
        row["discarded_at"] = datetime.now(timezone.utc).isoformat()
    response = requests.patch(
        f"{SUPABASE_URL}/rest/v1/events",
        headers=HEADERS,
        params={"id": f"eq.{event_id}"},
        json=row,
        timeout=30,
    )
    response.raise_for_status()


def main() -> None:
    events = load_active_events()
    print(f"Reclassifying {len(events)} active event(s)...\n")

    excluded = failed = updated = 0
    for event in events:
        raw_text = event.get("fit_analysis") or event.get("description") or ""
        if not raw_text:
            print(f"  - skipped (no stored text to classify against): {event['title']}")
            failed += 1
            continue

        classification = classify_event(event, raw_text)
        if not classification:
            print(f"  - skipped (classification failed): {event['title']}")
            failed += 1
            continue

        keep = classification["relevance_level"] != "not_relevant"
        update_classification(event["id"], classification, keep)
        if keep:
            print(f"  ~ {classification['relevance_level']}: {event['title']}")
            updated += 1
        else:
            print(
                f"  - excluded (now not_relevant: {classification.get('relevance_rationale')}): {event['title']}"
            )
            excluded += 1

    print(f"\nDone. {updated} updated, {excluded} newly excluded, {failed} skipped.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
