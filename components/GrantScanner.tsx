"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { FOCUS_AREAS, Grant } from "@/lib/types";

const MIN_VALUE_OPTIONS = [
  { label: "Any amount", value: 0 },
  { label: "USD 50K+", value: 50_000 },
  { label: "USD 100K+", value: 100_000 },
  { label: "USD 250K+", value: 250_000 },
  { label: "USD 500K+", value: 500_000 },
  { label: "USD 1M+", value: 1_000_000 },
];

const GEOGRAPHY_OPTIONS = ["Any geography", "Africa-focused", "Global", "East Africa", "Kenya"];

export default function GrantScanner() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeFocusAreas, setActiveFocusAreas] = useState<string[]>([]);
  const [minValue, setMinValue] = useState(0);
  const [geography, setGeography] = useState(GEOGRAPHY_OPTIONS[0]);
  const [trackedIds, setTrackedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [{ count }, { data, error: grantsError }] = await Promise.all([
        supabase.from("sources").select("id", { count: "exact", head: true }).eq("active", true),
        supabase
          .from("grants")
          .select("*")
          .order("relevance_score", { ascending: false, nullsFirst: false })
          .order("first_seen_at", { ascending: false })
          .limit(200),
      ]);
      if (grantsError) throw grantsError;
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

  // Strips casing, spaces, and punctuation so button labels like "AI / data"
  // match however the scraper happened to store the tag (e.g. "ai/data").
  function normalizeTag(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  const filteredGrants = useMemo(() => {
    return grants.filter((g) => {
      if (activeFocusAreas.length > 0) {
        const overlap = g.focus_areas?.some((a) =>
          activeFocusAreas.some((active) => normalizeTag(a) === normalizeTag(active))
        );
        if (!overlap) return false;
      }
      if (minValue > 0 && (!g.amount || g.amount < minValue)) return false;
      if (geography !== GEOGRAPHY_OPTIONS[0] && g.geography) {
        if (!g.geography.toLowerCase().includes(geography.toLowerCase().replace("-focused", "")))
          return false;
      }
      return true;
    });
  }, [grants, activeFocusAreas, minValue, geography]);

  async function trackGrant(grant: Grant) {
    const { error: insertError } = await supabase.from("tracker_items").insert({
      grant_id: grant.id,
      status: "tracking",
    });
    if (!insertError) {
      setTrackedIds((prev) => new Set(prev).add(grant.id));
    }
  }

  function isNew(grant: Grant) {
    if (!grant.first_seen_at) return false;
    const seenAt = new Date(grant.first_seen_at).getTime();
    if (isNaN(seenAt)) return false;
    const ageDays = (Date.now() - seenAt) / (1000 * 60 * 60 * 24);
    return ageDays <= 3;
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="mb-3 text-sm font-semibold text-[var(--ink)]">Focus areas</h2>
        <div className="flex flex-wrap gap-2">
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
        <div className="flex flex-wrap gap-6">
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
        </div>
        <button
          onClick={loadData}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-dark)]"
        >
          Refresh
        </button>
      </section>

      <div className="flex items-center justify-between text-sm text-[var(--ink-muted)]">
        <span>
          {sourceCount === null ? "…" : sourceCount} active source{sourceCount === 1 ? "" : "s"}
        </span>
        <span>
          {loading ? "Loading…" : `${filteredGrants.length} matching opportunit${filteredGrants.length === 1 ? "y" : "ies"}`}
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && filteredGrants.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-[var(--surface)] p-10 text-center text-[var(--ink-muted)]">
          No grants yet. Once the daily scan runs (or you add sources), matching opportunities will
          show up here.
        </div>
      )}

      <div className="flex flex-col gap-4">
        {filteredGrants.map((grant) => {
          const open = expandedId === grant.id;
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
                </div>
              </div>

              {grant.focus_areas && grant.focus_areas.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {grant.focus_areas.map((tag) => (
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
                    {grant.currency ?? "USD"} {grant.amount.toLocaleString()}
                  </span>
                )}
                {grant.deadline && <span>Closes {grant.deadline}</span>}
                {grant.geography && <span>{grant.geography}</span>}
              </div>

              {grant.description && (
                <p className={`mt-3 text-sm text-neutral-600 ${open ? "" : "line-clamp-2"}`}>
                  {grant.description}
                </p>
              )}

              {open && (
                <div className="mt-4 space-y-3 border-t border-[var(--border)] pt-4">
                  {grant.eligibility && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                        Eligibility
                      </p>
                      <p className="mt-1 text-sm text-neutral-600">{grant.eligibility}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    {grant.application_url ? (
                      
                        href={grant.application_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm font-medium text-[var(--accent)] hover:underline"
                      >
                        View opportunity →
                      </a>
                    ) : (
                      <span />
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        trackGrant(grant);
                      }}
                      disabled={trackedIds.has(grant.id)}
                      className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:border-neutral-300 disabled:text-neutral-400"
                    >
                      {trackedIds.has(grant.id) ? "Tracked ✓" : "+ Track this grant"}
                    </button>
                  </div>
                </div>
              )}

              <p className="mt-3 text-[11px] font-medium text-[var(--accent)]">
                {open ? "Click to collapse ↑" : "Click for details ↓"}
              </p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
