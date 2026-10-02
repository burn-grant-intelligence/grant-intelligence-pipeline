import type { Grant } from "./types";

// Awards & prizes are saved by `scripts/gemini_discover.py --awards` into the
// same grants table, tagged with this focus area (and type_of_funding
// "Cash prize award" when there is a cash prize). Everything else is a grant
// (calls for proposals, RFPs, tenders, funding rounds).
export const AWARD_TAG = "awards & prizes";

export const normalizeTag = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function isAward(grant: Pick<Grant, "type_of_funding" | "focus_areas"> | null | undefined): boolean {
  if (!grant) return false;
  return grant.type_of_funding === "Cash prize award" || (grant.focus_areas ?? []).some((tag) => normalizeTag(tag) === normalizeTag(AWARD_TAG));
}

export type OpportunityKind = "award" | "grant";
export const kindOf = (grant: Pick<Grant, "type_of_funding" | "focus_areas"> | null | undefined): OpportunityKind => (isAward(grant) ? "award" : "grant");

// The label and colours of the type badge, the same everywhere.
export const KIND_BADGE: Record<OpportunityKind, { label: string; className: string }> = {
  award: { label: "🏆 Award", className: "bg-amber-50 text-amber-700" },
  grant: { label: "💰 Grant", className: "bg-blue-50 text-blue-700" },
};
