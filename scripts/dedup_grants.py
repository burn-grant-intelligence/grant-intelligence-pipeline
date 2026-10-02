"""
One-off (and on-demand) clean-up of near-duplicate opportunities already in
the Grant Scanner — the ones saved before the 75% title rule existed.

Two opportunities are duplicates when ~75% of their title wording matches
(scripts/title_similarity.py — the same rule the scrapers now use before
saving), e.g. "Call for Solutions Horizon Europe EU 2027" and
"EU 2027 Call for Solutions". Different years/rounds or different countries
are never merged.

For each group of duplicates it keeps ONE row and discards (hides, keeps the
row, reversible) the others:
  - the row someone is tracking is kept; otherwise the one seen first;
  - if two copies are BOTH tracked, nothing is changed and they are listed
    so a person can decide (their notes and drafts live on the tracker items);
  - if any copy was discarded and the kept one is not tracked, the kept one is
    discarded too (someone already said "not for us").

Dry run by default — prints the groups. Pass --apply to discard.

Run locally:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/dedup_grants.py [--apply]
Runs in CI:   .github/workflows/dedup-grants.yml (Actions → "Merge duplicate opportunities")
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

import requests

from title_similarity import compare_titles

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}


def fetch_all(table: str, select: str, order: str) -> list[dict]:
    rows: list[dict] = []
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS,
            params={"select": select, "order": order, "limit": "1000", "offset": str(len(rows))},
            timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < 1000:
            return rows


def group_duplicates(grants: list[dict]) -> list[list[dict]]:
    """Groups of 2+ grants that are the same opportunity. A grant joins the
    first group whose EVERY member it matches (grants are in first-seen
    order), so a year-less title can't chain "X 2026" and "X 2027" together."""
    groups: list[list[dict]] = []
    for g in grants:
        if not g.get("title"):
            continue
        for group in groups:
            if all(compare_titles(g["title"], other["title"])[0] for other in group):
                group.append(g)
                break
        else:
            groups.append([g])
    return [grp for grp in groups if len(grp) > 1]


def plan(grants: list[dict], tracked: set[str]) -> tuple[list[tuple[dict, list[dict], bool]], list[list[dict]]]:
    """Returns ([(keep, discard_these, also_discard_keep)], [groups left alone])."""
    actions = []
    left_alone = []
    for group in group_duplicates(grants):
        tracked_rows = [g for g in group if g["id"] in tracked]
        if len(tracked_rows) > 1:
            left_alone.append(group)
            continue
        keep = tracked_rows[0] if tracked_rows else group[0]
        losers = [g for g in group if g is not keep and not g.get("discarded")]
        also_discard_keep = not tracked_rows and not keep.get("discarded") and any(g.get("discarded") for g in group)
        if losers or also_discard_keep:
            actions.append((keep, losers, also_discard_keep))
    return actions, left_alone


def main(argv: list[str]) -> None:
    apply = "--apply" in argv
    grants = fetch_all("grants", "id,title,funder,first_seen_at,discarded", "first_seen_at.asc")
    tracked = {t["grant_id"] for t in fetch_all("tracker_items", "grant_id", "created_at.asc") if t.get("grant_id")}
    actions, left_alone = plan(grants, tracked)

    print(f"{len(grants)} opportunities checked. {len(actions)} duplicate group(s) to tidy, {len(left_alone)} left for a person to decide.\n")
    to_discard: list[str] = []
    for keep, losers, also_keep in actions:
        print(f"KEEP     {keep['title']}" + ("  [tracked]" if keep["id"] in tracked else "") + ("  → also discarded (a copy was discarded)" if also_keep else ""))
        for g in losers:
            print(f"  hide   {g['title']}  ({compare_titles(keep['title'], g['title'])[2]})")
            to_discard.append(g["id"])
        if also_keep:
            to_discard.append(keep["id"])
    for group in left_alone:
        print("BOTH TRACKED — merge by hand in the Application Tracker:")
        for g in group:
            print(f"  · {g['title']}")

    if not apply:
        print(f"\nDry run: {len(to_discard)} opportunity/ies would be discarded. Run with --apply to do it.")
        return
    now = datetime.now(timezone.utc).isoformat()
    for i in range(0, len(to_discard), 100):
        chunk = to_discard[i : i + 100]
        r = requests.patch(
            f"{SUPABASE_URL}/rest/v1/grants",
            headers=HEADERS,
            params={"id": f"in.({','.join(chunk)})"},
            json={"discarded": True, "discarded_at": now},
            timeout=60,
        )
        r.raise_for_status()
    print(f"\nDone: {len(to_discard)} duplicate(s) discarded (hidden; the rows are kept).")


if __name__ == "__main__":
    main(sys.argv[1:])
