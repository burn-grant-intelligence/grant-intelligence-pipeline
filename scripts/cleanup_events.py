"""
Housekeeping for the `events` table — no Gemini calls, just database rules:

1. PAST events: deletes rows whose event ended more than PAST_GRACE_DAYS ago
   (end_date, or start_date for a single-day event). The Events tab already
   hides past events; this removes the dead rows so they stop cluttering the
   table and stop matching against next year's edition of the same event.
   A past event can never be re-added by discovery (save_event() skips
   anything already past), so deleting it loses nothing.
2. DUPLICATES: discards (hides, keeps the row) the later-saved copy of an
   active event that matches an earlier one — same rules save_event() uses
   for new events: similar title within a few days of each other, or same
   organizer with identical dates.
3. CONFERENCE MILLS: discards spam-listing titles like "International
   Conference on X (ICX)" that slipped in before the filter existed.

Irrelevant events are handled separately by scripts/reclassify_events.py.

Dry run by default — prints what it would do. Pass --apply to make changes.

Run locally:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... python scripts/cleanup_events.py [--apply]
Runs in CI:   after every discovery run (gemini-discover.yml), and on demand
              via .github/workflows/cleanup-events.yml
"""

import sys
from datetime import datetime, timedelta, timezone

import requests

import gemini_discover as g

PAST_GRACE_DAYS = 7

HEADERS = {
    "apikey": g.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {g.SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}


def load_events() -> list[dict]:
    response = requests.get(
        f"{g.SUPABASE_URL}/rest/v1/events",
        headers=HEADERS,
        params={
            "select": "id,title,organizer,start_date,end_date,discarded,first_seen_at",
            "order": "first_seen_at",
            "limit": "5000",
        },
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def find_past(events: list[dict]) -> list[dict]:
    cutoff = g.TODAY - timedelta(days=PAST_GRACE_DAYS)
    past = []
    for e in events:
        last_day = g._parse_date(e.get("end_date")) or g._parse_date(e.get("start_date"))
        if last_day and last_day < cutoff:
            past.append(e)
    return past


def find_duplicates_and_mills(events: list[dict]) -> tuple[list[tuple[dict, str]], list[dict]]:
    """Walks active events oldest-first; each one is compared with the ones
    kept before it, so the first-saved copy is always the one that stays."""
    kept: list[dict] = []
    duplicates: list[tuple[dict, str]] = []
    mills: list[dict] = []
    for e in events:
        if e.get("discarded"):
            continue
        if g.looks_like_conference_mill(e["title"]):
            mills.append(e)
            continue
        start = g._parse_date(e.get("start_date"))
        tokens = g._title_tokens(e["title"])
        org = g.normalize_organizer(e.get("organizer"))
        match = None
        for k in kept:
            k_start = g._parse_date(k.get("start_date"))
            if not start or not k_start:
                continue
            same_org_same_dates = (
                org
                and org == g.normalize_organizer(k.get("organizer"))
                and e.get("start_date") == k.get("start_date")
                and e.get("end_date") == k.get("end_date")
                and g._titles_match(
                    tokens, g._title_tokens(k["title"]), g.EVENT_DUPLICATE_SAME_ORGANIZER_OVERLAP
                )
            )
            similar_title_close_dates = (
                abs((start - k_start).days) <= g.EVENT_DUPLICATE_DATE_WINDOW_DAYS
                and g._titles_match(tokens, g._title_tokens(k["title"]))
            )
            if same_org_same_dates or similar_title_close_dates:
                match = k
                break
        if match:
            duplicates.append((e, match["title"]))
        else:
            kept.append(e)
    return duplicates, mills


def discard(ids: list[str]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    for event_id in ids:
        requests.patch(
            f"{g.SUPABASE_URL}/rest/v1/events",
            headers=HEADERS,
            params={"id": f"eq.{event_id}"},
            json={"discarded": True, "discarded_at": now},
            timeout=30,
        ).raise_for_status()


def delete(ids: list[str]) -> None:
    # Batched to keep the URL short.
    for i in range(0, len(ids), 50):
        batch = ids[i : i + 50]
        requests.delete(
            f"{g.SUPABASE_URL}/rest/v1/events",
            headers=HEADERS,
            params={"id": f"in.({','.join(batch)})"},
            timeout=30,
        ).raise_for_status()


def main() -> None:
    apply = "--apply" in sys.argv
    events = load_events()
    past = find_past(events)
    past_ids = {e["id"] for e in past}
    duplicates, mills = find_duplicates_and_mills([e for e in events if e["id"] not in past_ids])

    print(f"{len(events)} event row(s) in total ({'APPLYING' if apply else 'dry run'})\n")

    print(f"Past events (ended before {g.TODAY - timedelta(days=PAST_GRACE_DAYS)}) — delete: {len(past)}")
    for e in past:
        print(f"  - {e.get('end_date') or e.get('start_date')}  {e['title']}")

    print(f"\nDuplicates — discard the later copy: {len(duplicates)}")
    for e, kept_title in duplicates:
        print(f"  - {e['title']!r}  (same as {kept_title!r})")

    print(f"\nConference-mill titles — discard: {len(mills)}")
    for e in mills:
        print(f"  - {e['title']}")

    if not apply:
        print("\nDry run — nothing changed. Re-run with --apply to make these changes.")
        return

    delete([e["id"] for e in past])
    discard([e["id"] for e, _ in duplicates] + [e["id"] for e in mills])
    print(
        f"\nDone. Deleted {len(past)} past event(s); discarded {len(duplicates)} duplicate(s) "
        f"and {len(mills)} conference-mill listing(s)."
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(1)
