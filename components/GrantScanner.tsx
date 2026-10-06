"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabaseClient";
import { FOCUS_AREAS, Grant } from "@/lib/types";
import { AWARD_TAG, KIND_BADGE, isAward, kindOf, normalizeTag } from "@/lib/opportunityType";
import { compareTitles } from "@/lib/titleSimilarity";
import {
  SECTIONS,
  type SectionKey,
  amountInUsd,
  isBigTicket,
  matchesSearch,
  searchRank,
  searchWords,
  sectionOf,
  serverSearchTerm,
} from "@/lib/opportunitySection";

const MIN_VALUE_OPTIONS = [
  { label: "Any amount", value: 0 },
  { label: "USD 50K+", value: 50_000 },
  { label: "USD 100K+", value: 100_000 },
  { label: "USD 250K+", value: 250_000 },
  { label: "USD 500K+", value: 500_000 },
  { label: "USD 1M+", value: 1_000_000 },
];

const GEOGRAPHY_OPTIONS = ["Any geography", "Africa-focused", "Global", "East Africa", "Kenya"];

// Awards & prizes vs grants: see lib/opportunityType.ts.
// Keep in step with AWARD_GRACE_DAYS in scripts/gemini_discover.py: an award
// whose entry deadline passed within this many days stays visible, flagged,
// because award deadlines are often extended.
const AWARD_GRACE_DAYS = 7;
// "Show": everything (in sections), one section, or all grants & calls.
// Sections: lib/opportunitySection.ts.
const TYPE_OPTIONS = [
  { label: "All opportunities", value: "all" },
  { label: "🔥 Clean cooking calls", value: "clean_cooking" },
  { label: "💼 Large-ticket, catalytic & RBF", value: "large_ticket" },
  { label: "📣 Other open calls", value: "other_calls" },
  { label: "💰 All grants & calls", value: "grants" },
  { label: "🏆 Awards & prizes", value: "awards" },
] as const;
type TypeFilter = (typeof TYPE_OPTIONS)[number]["value"];

const SECTION_LABEL = Object.fromEntries(SECTIONS.map((s) => [s.key, `${s.icon} ${s.label}`])) as Record<SectionKey, string>;

const SEARCH_LIMIT = 60; // extra rows fetched from the database per search

// Who is already tracking an opportunity (one tracker item per opportunity).
type TrackedInfo = { owner: string | null; status: string };

export default function GrantScanner() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeFocusAreas, setActiveFocusAreas] = useState<string[]>([]);
  const [minValue, setMinValue] = useState(0);
  const [geography, setGeography] = useState(GEOGRAPHY_OPTIONS[0]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [tracked, setTracked] = useState<Map<string, TrackedInfo>>(new Map());
  const [trackingId, setTrackingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());

  // Search: matches what is loaded straight away, and also asks the database
  // (debounced) so opportunities beyond the first 200 are found too.
  const [search, setSearch] = useState("");
  const [serverHits, setServerHits] = useState<{ term: string; rows: Grant[] } | null>(null);
  const words = useMemo(() => searchWords(search), [search]);
  const searchActive = words.length > 0;
  const term = serverSearchTerm(words);
  const searchExtra = useMemo(() => (term && serverHits?.term === term ? serverHits.rows : []), [term, serverHits]);
  const searching = !!term && serverHits?.term !== term;

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!term) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const like = `%${term}%`;
      const { data } = await supabase
        .from("grants")
        .select("*")
        .or(`title.ilike.${like},funder.ilike.${like},description.ilike.${like}`)
        .order("first_seen_at", { ascending: false })
        .limit(SEARCH_LIMIT);
      if (!cancelled) setServerHits({ term, rows: (data ?? []) as Grant[] });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [{ count }, { data, error: grantsError }, trackedRes] = await Promise.all([
        supabase.from("sources").select("id", { count: "exact", head: true }).eq("active", true),
        supabase
          .from("grants")
          .select("*")
          .order("relevance_score", { ascending: false, nullsFirst: false })
          .order("first_seen_at", { ascending: false })
          // Discarded and closed rows are counted in this limit too (they are
          // hidden on the page, not in the query), so keep it well above the
          // number of open opportunities. 1000 is Supabase's row cap.
          .limit(1000),
        supabase.from("tracker_items").select("grant_id, owner, status"),
      ]);
      if (grantsError) throw grantsError;
      // Tracked state comes from the database, so everyone sees "Tracked ✓"
      // on an opportunity someone else already tracked.
      setTracked(new Map(((trackedRes.data ?? []) as { grant_id: string | null; owner: string | null; status: string }[]).filter((t) => t.grant_id).map((t) => [t.grant_id as string, { owner: t.owner, status: t.status }])));
      setSourceCount(count ?? 0);
      setGrants(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load grants.");
    } finally {
      setLoading(false);
    }
  }

  function toggleFocusArea(area: string) {
    setActiveFocusAreas((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]
    );
  }

  // normalizeTag (top of file) strips casing, spaces, and punctuation so
  // button labels like "AI / data" match however the scraper happened to
  // store the tag (e.g. "ai/data").

  // Reads the `discarded` column without requiring it in the Grant type, so
  // this still compiles (and the page still loads) whether or not the column
  // has been added in Supabase yet.
  function isDiscarded(grant: Grant) {
    return (grant as Grant & { discarded?: boolean }).discarded === true;
  }

  // Deadlines already in the past are never useful in a tracker of OPEN
  // opportunities, so they're hidden the same way a discarded grant is —
  // automatically, and without waiting for a rescan. This is a display-side
  // filter, not a deletion: the row still exists (in case a bad date was
  // extracted), it just won't show. Compared by calendar day rather than the
  // exact moment `now` is evaluated, so a grant doesn't vanish mid-way
  // through its own deadline day.
  function isExpired(grant: Grant) {
    if (!grant.deadline) return false;
    const deadline = new Date(grant.deadline);
    if (Number.isNaN(deadline.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (isAward(grant)) today.setDate(today.getDate() - AWARD_GRACE_DAYS);
    return deadline < today;
  }

  // An award inside its grace window: the deadline has passed, the page may
  // still show it open — the card says "check for an extension".
  function deadlineJustPassed(grant: Grant) {
    if (!grant.deadline || !isAward(grant)) return false;
    const deadline = new Date(grant.deadline);
    if (Number.isNaN(deadline.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return deadline < today;
  }

  // LinkedIn-sourced opportunities sort to the top. Done here rather than in
  // the database query on purpose: ordering by a column that doesn't exist yet
  // would make the whole query fail, and this way the page works with or
  // without the `priority` column.
  function priorityOf(grant: Grant) {
    return (grant as Grant & { priority?: number }).priority ?? 0;
  }

  const filteredGrants = useMemo(() => {
    const visible = grants.filter((g) => {
      if (isDiscarded(g)) return false;
      if (isExpired(g)) return false;
      if (typeFilter === "awards" && !isAward(g)) return false;
      if (typeFilter === "grants" && isAward(g)) return false;
      if ((typeFilter === "clean_cooking" || typeFilter === "large_ticket" || typeFilter === "other_calls") && sectionOf(g) !== typeFilter) return false;
      if (activeFocusAreas.length > 0) {
        const overlap = g.focus_areas?.some((a) =>
          activeFocusAreas.some((active) => normalizeTag(a) === normalizeTag(active))
        );
        if (!overlap) return false;
      }
      if (minValue > 0) {
        // In USD where the currency is known (EUR 1M counts as USD 1M+).
        const value = amountInUsd(g.amount, g.currency) ?? g.amount;
        if (!value || value < minValue) return false;
      }
      if (geography !== GEOGRAPHY_OPTIONS[0] && g.geography) {
        if (!g.geography.toLowerCase().includes(geography.toLowerCase().replace("-focused", "")))
          return false;
      }
      return true;
    });

    // Stable sort: priority first, then keep the order the query already gave
    // us (relevance score, then most recently seen).
    const sorted = visible
      .map((grant, index) => ({ grant, index }))
      .sort((a, b) =>
        priorityOf(b.grant) - priorityOf(a.grant) || a.index - b.index
      )
      .map((entry) => entry.grant);

    // Near-duplicates saved before the 75% title rule existed: show one card
    // per opportunity (the tracked copy if there is one). The "Merge duplicate
    // opportunities" action in GitHub hides the extra rows for good.
    const kept: Grant[] = [];
    let hidden = 0;
    for (const g of sorted) {
      const twin = kept.findIndex((k) => compareTitles(k.title, g.title).same);
      if (twin === -1) kept.push(g);
      else {
        hidden++;
        if (tracked.has(g.id) && !tracked.has(kept[twin].id)) kept[twin] = g;
      }
    }
    return { list: kept, hidden };
  }, [grants, activeFocusAreas, minValue, geography, typeFilter, tracked]);

  // Search results: every opportunity (loaded or found in the database) that
  // has all the words typed, whatever the filters above say. Discarded ones
  // stay hidden; closed ones are shown, marked, so you know what happened.
  const searchResults = useMemo(() => {
    if (!searchActive) return [];
    const byId = new Map<string, Grant>();
    for (const g of [...grants, ...searchExtra]) if (!byId.has(g.id)) byId.set(g.id, g);
    return [...byId.values()]
      .filter((g) => !isDiscarded(g) && matchesSearch(g, words))
      .map((grant, index) => ({ grant, index }))
      .sort((a, b) => searchRank(a.grant, words) - searchRank(b.grant, words) || a.index - b.index)
      .map((e) => e.grant);
  }, [grants, searchExtra, words, searchActive]);

  // The filtered list split into sections, in priority order.
  const sections = useMemo(() => {
    const groups = new Map<SectionKey, Grant[]>(SECTIONS.map((s) => [s.key, []]));
    for (const g of filteredGrants.list) groups.get(sectionOf(g))?.push(g);
    return SECTIONS.map((s) => ({ ...s, items: groups.get(s.key) ?? [] }));
  }, [filteredGrants]);

  function toggleSection(key: SectionKey) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // One tracker item per opportunity: check first (someone else may have
  // tracked it since this page loaded), and the database also refuses a
  // second one (supabase/track_once_migration_2026-10-02.sql).
  async function trackGrant(grant: Grant) {
    setTrackingId(grant.id);
    setError(null);
    const { data: existing } = await supabase.from("tracker_items").select("grant_id, owner, status").eq("grant_id", grant.id).limit(1);
    if (existing && existing.length) {
      setTracked((prev) => new Map(prev).set(grant.id, { owner: existing[0].owner, status: existing[0].status }));
      setTrackingId(null);
      return;
    }
    const { error: insertError } = await supabase.from("tracker_items").insert({
      grant_id: grant.id,
      status: "tracking",
    });
    if (!insertError || insertError.code === "23505") {
      setTracked((prev) => new Map(prev).set(grant.id, { owner: null, status: "tracking" }));
    } else {
      setError(insertError.message);
    }
    setTrackingId(null);
  }

  async function discardGrant(grant: Grant) {
    if (!window.confirm(`Discard "${grant.title}"? It will stop showing up in this list.`)) return;

    setDiscardingId(grant.id);
    const previous = grants;
    // Hide it straight away, then put it back if the save fails.
    setGrants((prev) => prev.filter((g) => g.id !== grant.id));

    const { error: discardError } = await supabase
      .from("grants")
      .update({ discarded: true, discarded_at: new Date().toISOString() })
      .eq("id", grant.id);

    if (discardError) {
      setGrants(previous);
      setError(discardError.message);
    }
    setDiscardingId(null);
  }

  // Reads `source_type` without requiring it in the Grant type, same trick as
  // isDiscarded above — works whether or not the column exists yet.
  function isFromLinkedIn(grant: Grant) {
    return (grant as Grant & { source_type?: string }).source_type === "linkedin";
  }

  // Gemini-sourced opportunities show a green pill (a distinct shade from the
  // "New" tag's emerald, so the two read separately when both appear on the
  // same card) but otherwise sort and filter exactly like everything else —
  // unlike LinkedIn, they don't get top-of-list priority.
  function isFromGemini(grant: Grant) {
    return (grant as Grant & { source_type?: string }).source_type === "gemini";
  }

  function isNew(grant: Grant) {
    if (!grant.first_seen_at) return false;
    const seenAt = new Date(grant.first_seen_at).getTime();
    if (isNaN(seenAt)) return false;
    const ageDays = (Date.now() - seenAt) / (1000 * 60 * 60 * 24);
    return ageDays <= 3;
  }

  // One opportunity card. In search results it also says which section it
  // sits in, and marks a closed one.
  function renderCard(grant: Grant, inSearch = false): ReactNode {
    const open = expandedId === grant.id;
    const award = isAward(grant);
    return (
      <article
        key={grant.id}
        onClick={() => setExpandedId(open ? null : grant.id)}
        className={`cursor-pointer rounded-lg border bg-[var(--surface)] p-5 transition-colors ${
          open ? "border-[var(--accent)]" : "border-[var(--border)] hover:border-neutral-300"
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {grant.funder && <p className="text-xs text-[var(--ink-muted)]">{grant.funder}</p>}
            <h3 className="font-serif-display text-lg leading-snug text-[var(--ink)]">
              {grant.title}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${KIND_BADGE[kindOf(grant)].className}`}>
              {KIND_BADGE[kindOf(grant)].label}
            </span>
            {inSearch && (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
                {SECTION_LABEL[sectionOf(grant)]}
              </span>
            )}
            {inSearch && isExpired(grant) && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">
                Deadline passed
              </span>
            )}
            {!award && isBigTicket(grant) && (
              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700">
                💼 Large ticket
              </span>
            )}
            {deadlineJustPassed(grant) && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">
                Deadline passed · check for extension
              </span>
            )}
            {isFromLinkedIn(grant) && (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700">
                LinkedIn
              </span>
            )}
            {isFromGemini(grant) && (
              <span className="rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700">
                Gemini
              </span>
            )}
            {isNew(grant) && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                New
              </span>
            )}
            {grant.relevance_score != null && (
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--accent-dark)]">
                {Math.round(grant.relevance_score)}% match
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                discardGrant(grant);
              }}
              disabled={discardingId === grant.id}
              title="Discard this opportunity"
              aria-label="Discard this opportunity"
              className="flex h-6 w-6 items-center justify-center rounded-full text-base leading-none text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40"
            >
              ×
            </button>
          </div>
        </div>

        {grant.focus_areas && grant.focus_areas.some((tag) => normalizeTag(tag) !== normalizeTag(AWARD_TAG)) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {grant.focus_areas.filter((tag) => normalizeTag(tag) !== normalizeTag(AWARD_TAG)).map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ink-muted)]">
          {grant.amount && (
            <span className="font-medium text-[var(--accent-dark)]">
              {award ? "Prize " : ""}{grant.currency ?? "USD"} {grant.amount.toLocaleString()}
            </span>
          )}
          {grant.deadline && <span>{award ? (deadlineJustPassed(grant) ? "Entries closed" : "Entries close") : "Closes"} {grant.deadline}</span>}
          {grant.geography && <span>{grant.geography}</span>}
        </div>

        {!open && (grant.fit_analysis || grant.description) && (
          <p className="mt-3 line-clamp-2 text-sm text-neutral-600">
            {grant.fit_analysis || grant.description}
          </p>
        )}

        {open && (
          <div className="mt-4 space-y-4 border-t border-[var(--border)] pt-4">
            {grant.fit_analysis && (
              <div className="rounded-md border-l-4 border-[var(--accent)] bg-[var(--accent-soft)] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--accent-dark)]">
                  Fit for BURN
                </p>
                <p className="mt-1 text-sm text-neutral-700">{grant.fit_analysis}</p>
              </div>
            )}

            {grant.description && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                  Summary
                </p>
                <p className="mt-1 text-sm text-neutral-600">{grant.description}</p>
              </div>
            )}

            {grant.eligibility && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                  {award ? "Prize & how to enter" : "Eligibility"}
                </p>
                <p className="mt-1 text-sm text-neutral-600">{grant.eligibility}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              {grant.application_url ? (
               <a
                  href={grant.application_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-sm font-medium text-[var(--accent)] hover:underline"
                >
                  {award ? "View award →" : "View opportunity →"}
                </a>
              ) : (
                <span />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  trackGrant(grant);
                }}
                disabled={tracked.has(grant.id) || trackingId === grant.id}
                title={tracked.has(grant.id) ? "Already in the Application Tracker — each opportunity is tracked once" : undefined}
                className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:border-neutral-300 disabled:text-neutral-400"
              >
                {tracked.has(grant.id)
                  ? `Tracked ✓${tracked.get(grant.id)?.owner ? ` · ${tracked.get(grant.id)?.owner}` : ""}`
                  : trackingId === grant.id
                    ? "Tracking…"
                    : award ? "+ Track this award" : "+ Track this grant"}
              </button>
            </div>
          </div>
        )}

        <p className="mt-3 text-[11px] font-medium text-[var(--accent)]">
          {open ? "Click to collapse ↑" : "Click for details ↓"}
        </p>
      </article>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="mb-3 text-sm font-semibold text-[var(--ink)]">Focus areas</h2>
          <div className="flex flex-wrap gap-2">
            <button
             onClick={() => setActiveFocusAreas([])}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
               activeFocusAreas.length === 0
                ? "bg-orange-600 text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
            }`}
          >
            All
          </button>
          {FOCUS_AREAS.map((area) => {
            const active = activeFocusAreas.includes(area);
            return (
              <button
                key={area}
                onClick={() => toggleFocusArea(area)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-[var(--accent)] text-white"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}
              >
                {area}
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-wrap items-end justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex flex-1 flex-wrap items-end gap-6">
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
            Show
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
            Min value
            <select
              value={minValue}
              onChange={(e) => setMinValue(Number(e.target.value))}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
            >
              {MIN_VALUE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
            Geography
            <select
              value={geography}
              onChange={(e) => setGeography(e.target.value)}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800"
            >
              {GEOGRAPHY_OPTIONS.map((opt) => (
                <option key={opt}>{opt}</option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
            Search
            <span className="relative">
              <input
                type="text"
                enterKeyHint="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setSearch("")}
                placeholder="Title, funder or keyword, e.g. FID, Danida, eCooking"
                aria-label="Search opportunities"
                className="w-full rounded-md border border-neutral-300 py-2 pl-8 pr-8 text-sm normal-case tracking-normal text-neutral-800 placeholder:text-neutral-400"
              />
              <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-neutral-400">⌕</span>
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-1 text-base leading-none text-neutral-400 hover:text-neutral-700"
                >
                  ×
                </button>
              )}
            </span>
          </label>
        </div>
        <button
          onClick={loadData}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-dark)]"
        >
          Refresh
        </button>
      </section>

      {/* This row sits directly on the page's background photo rather than
          inside a white card, so --ink-muted (tuned for text on white) washes
          out against it. White + medium weight + a soft shadow keeps it
          legible over both the bright and dark parts of the image. */}
      <div className="flex items-center justify-between text-sm font-medium text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.45)]">
        <span>
          {sourceCount === null ? "…" : sourceCount} active source{sourceCount === 1 ? "" : "s"}
        </span>
        <span>
          {loading
            ? "Loading…"
            : searchActive
              ? `${searchResults.length} result${searchResults.length === 1 ? "" : "s"} for "${search.trim()}"${searching ? " · searching…" : ""}`
            : typeFilter === "awards"
              ? `${filteredGrants.list.length} open award${filteredGrants.list.length === 1 ? "" : "s"} & prize${filteredGrants.list.length === 1 ? "" : "s"}`
              : `${filteredGrants.list.length} matching opportunit${filteredGrants.list.length === 1 ? "y" : "ies"}`}
          {!loading && !searchActive && filteredGrants.hidden > 0 && ` · ${filteredGrants.hidden} duplicate${filteredGrants.hidden === 1 ? "" : "s"} hidden`}
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && !searchActive && filteredGrants.list.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-[var(--surface)] p-10 text-center text-[var(--ink-muted)]">
          {typeFilter === "awards"
            ? "No open awards or prizes yet. They appear here after the \"Awards discovery\" run (GitHub → Actions), which searches twice a week."
            : "No grants yet. Once the daily scan runs (or you add sources), matching opportunities will show up here."}
        </div>
      )}

      {searchActive ? (
        <div className="flex flex-col gap-4">
          {searchResults.length === 0 && !searching && (
            <div className="rounded-lg border border-dashed border-neutral-300 bg-[var(--surface)] p-8 text-center text-[var(--ink-muted)]">
              Nothing matches &ldquo;{search.trim()}&rdquo;. Try fewer or shorter words, e.g. a funder&apos;s acronym.
            </div>
          )}
          {searchResults.length > 0 && (
            <p className="text-xs font-medium text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.45)]">
              Searching every opportunity: the filters above are paused while you search.
            </p>
          )}
          {searchResults.map((grant) => renderCard(grant, true))}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {sections
            .filter((section) => typeFilter === "all" || section.items.length > 0)
            .map((section) => {
              const isCollapsed = collapsed.has(section.key);
              return (
                <section key={section.key} aria-label={section.label} className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => toggleSection(section.key)}
                    aria-expanded={!isCollapsed}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-3 text-left hover:border-neutral-300"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
                        <span aria-hidden>{section.icon}</span>
                        {section.label}
                        <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--accent-dark)]">
                          {section.items.length}
                        </span>
                      </span>
                      <span className="mt-0.5 text-xs text-[var(--ink-muted)]">{section.hint}</span>
                    </span>
                    <span aria-hidden className="shrink-0 text-xs font-medium text-[var(--accent)]">
                      {isCollapsed ? "Show ↓" : "Hide ↑"}
                    </span>
                  </button>
                  {!isCollapsed &&
                    (section.items.length === 0 ? (
                      !loading && (
                        <p className="rounded-lg border border-dashed border-neutral-300 bg-[var(--surface)] px-5 py-4 text-sm text-[var(--ink-muted)]">
                          {section.empty}
                        </p>
                      )
                    ) : (
                      <div className="flex flex-col gap-4">{section.items.map((grant) => renderCard(grant))}</div>
                    ))}
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}
