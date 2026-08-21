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

    // Strips casing, spaces, and punctuation so "AI / data" (button label) matches
  // "ai/data" or "AI-Data" (whatever variant the scraper happened to store).
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

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold text-neutral-700">Focus areas</h2>
        <div className="flex flex-wrap gap-2">
          {FOCUS_AREAS.map((area) => {
            const active = activeFocusAreas.includes(area);
            return (
              <button
                key={area}
                onClick={() => toggleFocusArea(area)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-orange-600 text-white"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                }`}
              >
                {area}
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-wrap items-end justify-between gap-4 rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap gap-6">
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
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
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
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
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700"
        >
          Refresh
        </button>
      </section>

      <div className="flex items-center justify-between text-sm text-neutral-500">
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
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center text-neutral-500">
          No grants yet. Once the daily scan runs (or you add sources), matching opportunities will
          show up here.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {filteredGrants.map((grant) => (
          <article
            key={grant.id}
            className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-base font-semibold leading-snug">{grant.title}</h3>
              {grant.relevance_score != null && (
                <span className="shrink-0 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700">
                  {Math.round(grant.relevance_score)}% match
                </span>
              )}
            </div>
            {grant.funder && <p className="text-sm text-neutral-500">{grant.funder}</p>}
            <div className="flex flex-wrap gap-2 text-xs text-neutral-500">
              {grant.amount && (
                <span>
                  {grant.currency ?? "USD"} {grant.amount.toLocaleString()}
                </span>
              )}
              {grant.deadline && <span>Due {grant.deadline}</span>}
              {grant.geography && <span>{grant.geography}</span>}
            </div>
            {grant.description && (
              <p className="line-clamp-3 text-sm text-neutral-600">{grant.description}</p>
            )}
            <div className="mt-2 flex items-center justify-between">
              {grant.application_url ? (
                <a
                  href={grant.application_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-orange-600 hover:underline"
                >
                  View source →
                </a>
              ) : (
                <span />
              )}
              <button
                onClick={() => trackGrant(grant)}
                disabled={trackedIds.has(grant.id)}
                className="rounded-md border border-orange-600 px-3 py-1.5 text-sm font-medium text-orange-600 hover:bg-orange-50 disabled:border-neutral-300 disabled:text-neutral-400"
              >
                {trackedIds.has(grant.id) ? "Tracked ✓" : "+ Track this grant"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
