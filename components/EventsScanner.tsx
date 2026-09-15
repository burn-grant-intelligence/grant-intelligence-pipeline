"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { FOCUS_AREAS, EventItem } from "@/lib/types";

// Deliberately its own tab, separate from the Grant Scanner's opportunity
// list — these are calendar/networking items (conferences, summits,
// webinars), not funding calls to apply to, and this is a lighter side
// feature that shouldn't dilute the main opportunities view. See
// scripts/gemini_discover.py and supabase/events_schema.sql.
export default function EventsScanner() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeFocusAreas, setActiveFocusAreas] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const { data, error: eventsError } = await supabase
        .from("events")
        .select("*")
        .order("start_date", { ascending: true, nullsFirst: false })
        .limit(200);
      if (eventsError) throw eventsError;
      setEvents(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events.");
    } finally {
      setLoading(false);
    }
  }

  function toggleFocusArea(area: string) {
    setActiveFocusAreas((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]
    );
  }

  function normalizeTag(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isDiscarded(event: EventItem) {
    return (event as EventItem & { discarded?: boolean }).discarded === true;
  }

  // Same convention as GrantScanner's isExpired: hide events whose dates
  // have already passed, compared by calendar day, without deleting the row.
  function isPast(event: EventItem) {
    const dateStr = event.end_date || event.start_date;
    if (!dateStr) return false;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  }

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (isDiscarded(e)) return false;
      if (isPast(e)) return false;
      if (activeFocusAreas.length > 0) {
        const overlap = e.focus_areas?.some((a) =>
          activeFocusAreas.some((active) => normalizeTag(a) === normalizeTag(active))
        );
        if (!overlap) return false;
      }
      return true;
    });
  }, [events, activeFocusAreas]);

  async function discardEvent(event: EventItem) {
    if (!window.confirm(`Discard "${event.title}"? It will stop showing up in this list.`)) return;

    setDiscardingId(event.id);
    const previous = events;
    setEvents((prev) => prev.filter((e) => e.id !== event.id));

    const { error: discardError } = await supabase
      .from("events")
      .update({ discarded: true, discarded_at: new Date().toISOString() })
      .eq("id", event.id);

    if (discardError) {
      setEvents(previous);
      setError(discardError.message);
    }
    setDiscardingId(null);
  }

  function dateRange(event: EventItem) {
    if (!event.start_date) return null;
    if (event.end_date && event.end_date !== event.start_date) {
      return `${event.start_date} – ${event.end_date}`;
    }
    return event.start_date;
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

      {/* Same treatment as the Grant Scanner's count row — this sits on the
          background photo, not on a card, so muted ink is unreadable here. */}
      <div className="flex items-center justify-between text-sm font-medium text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.45)]">
        <span>Upcoming, discovered by Gemini</span>
        <div className="flex items-center gap-3">
          <span>
            {loading ? "Loading…" : `${filteredEvents.length} upcoming event${filteredEvents.length === 1 ? "" : "s"}`}
          </span>
          <button
            onClick={loadData}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--accent-dark)]"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && filteredEvents.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-[var(--surface)] p-10 text-center text-[var(--ink-muted)]">
          No upcoming events yet. Once scripts/gemini_discover.py runs, matching events will show up
          here.
        </div>
      )}

      <div className="flex flex-col gap-4">
        {filteredEvents.map((event) => {
          const open = expandedId === event.id;
          return (
            <article
              key={event.id}
              onClick={() => setExpandedId(open ? null : event.id)}
              className={`cursor-pointer rounded-lg border bg-[var(--surface)] p-5 transition-colors ${
                open ? "border-[var(--accent)]" : "border-[var(--border)] hover:border-neutral-300"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  {event.organizer && (
                    <p className="text-xs text-[var(--ink-muted)]">{event.organizer}</p>
                  )}
                  <h3 className="font-serif-display text-lg leading-snug text-[var(--ink)]">
                    {event.title}
                  </h3>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700">
                    Gemini
                  </span>
                  {event.event_type && (
                    <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--accent-dark)]">
                      {event.event_type}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      discardEvent(event);
                    }}
                    disabled={discardingId === event.id}
                    title="Discard this event"
                    aria-label="Discard this event"
                    className="flex h-6 w-6 items-center justify-center rounded-full text-base leading-none text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              </div>

              {event.focus_areas && event.focus_areas.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {event.focus_areas.map((tag) => (
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
                {dateRange(event) && <span className="font-medium text-[var(--accent-dark)]">{dateRange(event)}</span>}
                {event.format && <span>{event.format}</span>}
                {event.location && <span>{event.location}</span>}
                {event.geography && <span>{event.geography}</span>}
              </div>

              {!open && (event.fit_analysis || event.description) && (
                <p className="mt-3 line-clamp-2 text-sm text-neutral-600">
                  {event.fit_analysis || event.description}
                </p>
              )}

              {open && (
                <div className="mt-4 space-y-4 border-t border-[var(--border)] pt-4">
                  {event.fit_analysis && (
                    <div className="rounded-md border-l-4 border-[var(--accent)] bg-[var(--accent-soft)] p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--accent-dark)]">
                        Fit for BURN
                      </p>
                      <p className="mt-1 text-sm text-neutral-700">{event.fit_analysis}</p>
                    </div>
                  )}

                  {event.description && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                        Summary
                      </p>
                      <p className="mt-1 text-sm text-neutral-600">{event.description}</p>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    {event.url ? (
                      <a
                        href={event.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm font-medium text-[var(--accent)] hover:underline"
                      >
                        View event →
                      </a>
                    ) : (
                      <span />
                    )}
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
