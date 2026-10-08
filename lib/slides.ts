// The "Grant Writing PPT": one slide per opportunity the team is working on,
// built from live data (the tracker and the key priorities) with anything a
// person typed on the slide laid over it. Pure helpers, no database, so
// test/slides.test.ts covers them. Screens: components/Slides.tsx,
// components/GrantWritingDeck.tsx. Table: opportunity_slides
// (supabase/management_tools_migration_2026-10-08.sql).

import { canonicalLead, effectiveFields, fmtDate, money } from "./pipeline";
import { columnOf } from "./drafting";
import { findSimilarTitle } from "./titleSimilarity";
import type { KeyPriority, OpportunitySlideRow, TrackerItem } from "./types";

export const SLIDE_FIELDS = [
  "title",
  "organization",
  "deadline",
  "start",
  "end",
  "amount",
  "funding",
  "lead",
  "stage",
  "description",
  "countries",
  "products",
  "source",
  "link",
] as const;
export type SlideField = (typeof SLIDE_FIELDS)[number];
export type SlideFields = Record<SlideField, string>;

export const SLIDE_LABELS: Record<SlideField, string> = {
  title: "Title",
  organization: "Organization",
  deadline: "Submission deadline",
  start: "Project start date",
  end: "Project end date",
  amount: "Amount",
  funding: "Type of funding",
  lead: "BURN lead",
  stage: "Stage",
  description: "Description",
  countries: "Countries",
  products: "Product type",
  source: "Source",
  link: "Link",
};

/** Which record a slide belongs to. */
export type SlideTarget = { kind: "tracker"; id: string } | { kind: "priority"; id: string };
export const targetKey = (t: SlideTarget) => `${t.kind}:${t.id}`;

export const TBD = "TBD";
const orTbd = (v: string | null | undefined) => (v && v.trim() ? v.trim() : TBD);

/** "Hussein Kiarie" → "HK"; anything that isn't a name is kept as typed. */
export function initialsOf(name: string | null | undefined): string {
  const full = canonicalLead(name);
  if (!full) return "";
  if (full.toUpperCase() === TBD) return TBD;
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return full;
  return parts
    .slice(0, 3)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

const isIsoDate = (v: string | null | undefined) => /^\d{4}-\d{2}-\d{2}/.test(v ?? "");
const showDate = (v: string | null | undefined) => (isIsoDate(v) ? fmtDate(v) : orTbd(v));

/** The header bar on an opportunity's slide: "Application - Concept note", … */
export function stageLabel(item: Pick<TrackerItem, "status" | "draft_stage"> | null): string {
  if (!item) return "Application - Prospecting";
  if (item.status === "won" || item.status === "implementation") return "Awarded - Implementation";
  if (item.status === "lost") return "Closed - Not awarded";
  const col = columnOf(item);
  if (col === "submitted") return "Application - Submitted";
  if (col === "first_draft") return "Application - First draft";
  return "Application - Concept note";
}

/** The live values for a tracked opportunity's slide. */
export function trackerSlideDefaults(item: TrackerItem): SlideFields {
  const e = effectiveFields(item);
  const g = item.grant;
  const amount =
    typeof item.requested_amount_usd === "number"
      ? money(item.requested_amount_usd)
      : g?.amount
        ? money(g.amount, g.currency ?? "USD")
        : e.ticketSize;
  const title =
    e.funder && e.programName && !e.programName.toLowerCase().includes(e.funder.toLowerCase())
      ? `${e.funder} / ${e.programName}`
      : e.programName || e.funder || "(untitled opportunity)";
  return {
    title,
    organization: orTbd(e.funder),
    deadline: showDate(e.deadline),
    start: showDate(g?.project_start_date),
    end: showDate(g?.project_end_date),
    amount: orTbd(amount),
    funding: orTbd(e.fundingType),
    lead: initialsOf(e.lead) || TBD,
    stage: stageLabel(item),
    description: e.description.trim(),
    countries: e.countries.join(", "),
    products: (item.product_types ?? []).join(", "),
    source: g?.source_note?.trim() || "Grant Scanner",
    link: e.link,
  };
}

/** The live values for a key priority that is not (yet) in the tracker. */
export function prioritySlideDefaults(p: KeyPriority): SlideFields {
  return {
    title: p.opportunity?.trim() || "(untitled opportunity)",
    organization: TBD,
    deadline: showDate(p.deadline),
    start: TBD,
    end: TBD,
    amount: TBD,
    funding: TBD,
    lead: initialsOf(p.lead) || TBD,
    stage: "Application - Prospecting",
    description: "",
    countries: "",
    products: "",
    source: "Key priorities",
    link: "",
  };
}

/** Live values with the typed ones laid over them. */
export function mergeSlide(defaults: SlideFields, overrides: Record<string, string> | null | undefined): SlideFields {
  const out = { ...defaults };
  for (const k of SLIDE_FIELDS) {
    const v = overrides?.[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * The overrides to store after someone edits one field: a value equal to the
 * live one is dropped (so the slide keeps following the live data), anything
 * else is kept.
 */
export function nextOverrides(
  current: Record<string, string> | null | undefined,
  defaults: SlideFields,
  field: SlideField,
  value: string
): Record<string, string> {
  const out = { ...(current ?? {}) };
  const v = value.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").trim();
  if (v === defaults[field].trim()) delete out[field];
  else out[field] = v;
  return out;
}

/** "Chris\nWebsite" → ["Chris", "Website"]; bullets and blank lines dropped. */
export function bulletLines(text: string): string[] {
  return text
    .split(/\n|•/)
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

// ── The deck ──

/** In the deck: what Draft Application shows (Fit or "draft anyway") from Concept onwards, plus won ones. */
export function inDeck(item: TrackerItem): boolean {
  if (item.removed_at) return false;
  if (item.status === "won" || item.status === "implementation") return true;
  if (item.status === "lost") return false;
  return item.fit_status === "fit" || !!item.draft_override;
}

export type DeckSlide = {
  key: string;
  target: SlideTarget;
  /** The tracker item, when the slide is about a tracked opportunity. */
  item: TrackerItem | null;
  /** The key priority it came from, if any. */
  priority: KeyPriority | null;
  defaults: SlideFields;
  fields: SlideFields;
  overridden: SlideField[];
  hidden: boolean;
  sortDate: string;
};

/** The tracker item a key priority is about (same opportunity, worded differently is fine). */
export function matchPriority(p: KeyPriority, items: TrackerItem[]): TrackerItem | null {
  const live = items.filter((i) => !i.removed_at);
  const rows = live.map((i) => ({ title: effectiveFields(i).programName || i.grant?.title || null, item: i }));
  const hit = findSimilarTitle(p.opportunity ?? "", rows);
  return hit ? hit.match.item : null;
}

export function slideRowFor(rows: OpportunitySlideRow[], t: SlideTarget): OpportunitySlideRow | null {
  return rows.find((r) => (t.kind === "tracker" ? r.tracker_item_id === t.id : r.key_priority_id === t.id)) ?? null;
}

function makeSlide(target: SlideTarget, item: TrackerItem | null, priority: KeyPriority | null, rows: OpportunitySlideRow[]): DeckSlide {
  const defaults = item ? trackerSlideDefaults(item) : prioritySlideDefaults(priority as KeyPriority);
  // A priority that is also tracked: the priority's deadline and lead fill gaps.
  if (item && priority) {
    if (defaults.deadline === TBD && priority.deadline?.trim()) defaults.deadline = showDate(priority.deadline);
    if (defaults.lead === TBD && priority.lead?.trim()) defaults.lead = initialsOf(priority.lead) || TBD;
  }
  const row = slideRowFor(rows, target);
  const overrides = row?.fields ?? {};
  const deadlineIso = item ? effectiveFields(item).deadline : priority?.deadline ?? "";
  return {
    key: targetKey(target),
    target,
    item,
    priority,
    defaults,
    fields: mergeSlide(defaults, overrides),
    overridden: SLIDE_FIELDS.filter((k) => typeof overrides[k] === "string"),
    hidden: !!row?.hidden,
    sortDate: isIsoDate(deadlineIso) ? deadlineIso.slice(0, 10) : "9999-12-31",
  };
}

/** The slide for one tracked opportunity or key priority (used by the pop-ups). */
export function slideFor(target: SlideTarget, items: TrackerItem[], priorities: KeyPriority[], rows: OpportunitySlideRow[]): DeckSlide | null {
  if (target.kind === "tracker") {
    const item = items.find((i) => i.id === target.id);
    if (!item) return null;
    const priority = priorities.find((p) => matchPriority(p, [item])) ?? null;
    return makeSlide(target, item, priority, rows);
  }
  const p = priorities.find((x) => x.id === target.id);
  if (!p) return null;
  const item = matchPriority(p, items);
  return item ? makeSlide({ kind: "tracker", id: item.id }, item, p, rows) : makeSlide(target, null, p, rows);
}

/**
 * Every opportunity the team is working on, one slide each: the key
 * priorities first, in their order (a priority that is also tracked uses the
 * tracked opportunity's slide), then the other tracked opportunities in the
 * deck by deadline. Nothing appears twice.
 */
export function buildDeck(items: TrackerItem[], priorities: KeyPriority[], rows: OpportunitySlideRow[]): DeckSlide[] {
  const out: DeckSlide[] = [];
  const used = new Set<string>();
  const sorted = [...priorities].sort((a, b) => a.sort_order - b.sort_order);
  for (const p of sorted) {
    if (!p.opportunity?.trim()) continue;
    const item = matchPriority(p, items);
    if (item) {
      if (used.has(item.id)) continue;
      used.add(item.id);
      out.push(makeSlide({ kind: "tracker", id: item.id }, item, p, rows));
    } else {
      out.push(makeSlide({ kind: "priority", id: p.id }, null, p, rows));
    }
  }
  const rest = items
    .filter((i) => inDeck(i) && !used.has(i.id))
    .map((i) => makeSlide({ kind: "tracker", id: i.id }, i, null, rows))
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate) || a.fields.title.localeCompare(b.fields.title));
  return [...out, ...rest];
}
