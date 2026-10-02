// Which link the eligibility check reads for an opportunity.
//
// The link a person types into the Application Tracker's Breakdown ("Link",
// tracker_items.pipeline_link) is the one they have opened and checked, so it
// is the de facto link: the check reads it, and never swaps it for one found
// by search. Without one, the check falls back to what an earlier check or the
// scraper saved (grants.rfp_url, then grants.application_url), as before.
// Pure functions — covered by test/callLink.test.ts.

import { isSafeUrl } from "./fetchSources";

// A usable web link, or null. Trims; rejects anything that isn't http(s) or
// that the fetcher would refuse (private hosts, credentials in the URL, …).
export function cleanLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  return isSafeUrl(t) ? t : null;
}

export interface CallLinkChoice {
  primary: string | null; // the page to read first
  pinned: boolean; // true = the person's own link: never replaced, no searching for another
  alternate: string | null; // a second page worth trying when the first reads too little (never set when pinned)
}

export function chooseCallLink(o: { pinned?: unknown; rfpUrl?: unknown; applicationUrl?: unknown }): CallLinkChoice {
  const pinned = cleanLink(o.pinned);
  if (pinned) return { primary: pinned, pinned: true, alternate: null };
  const rfp = typeof o.rfpUrl === "string" && o.rfpUrl.trim() ? o.rfpUrl.trim() : null;
  const app = typeof o.applicationUrl === "string" && o.applicationUrl.trim() ? o.applicationUrl.trim() : null;
  const primary = rfp ?? app;
  return { primary, pinned: false, alternate: primary && app && app !== primary ? app : null };
}

// From the tracker rows of one grant (most recently updated first), the first
// pipeline_link that is a usable link.
export function pinnedLinkFrom(rows: { pipeline_link?: unknown }[] | null | undefined): string | null {
  for (const row of rows ?? []) {
    const link = cleanLink(row.pipeline_link);
    if (link) return link;
  }
  return null;
}
