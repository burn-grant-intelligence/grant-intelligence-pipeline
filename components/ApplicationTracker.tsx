"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TRACKER_STATUSES, TrackerItem, TrackerStatus } from "@/lib/types";

const STATUS_LABELS: Record<TrackerStatus, string> = {
  tracking: "Tracking",
  researching: "Researching",
  drafting: "Drafting",
  submitted: "Submitted",
  won: "Won",
  lost: "Lost",
};

export default function ApplicationTracker() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TrackerStatus | "all">("all");
  const [addingManual, setAddingManual] = useState(false);
  const [manualTitle, setManualTitle] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    const { data, error: fetchError } = await supabase
      .from("tracker_items")
      .select("*, grant:grants(*)")
      .order("updated_at", { ascending: false });
    if (fetchError) setError(fetchError.message);
    setItems((data as unknown as TrackerItem[]) ?? []);
    setLoading(false);
  }

  const counts = useMemo(() => {
    const base: Record<string, number> = { total: items.length, in_progress: 0, submitted: 0, won: 0 };
    for (const item of items) {
      if (["tracking", "researching", "drafting"].includes(item.status)) base.in_progress++;
      if (item.status === "submitted") base.submitted++;
      if (item.status === "won") base.won++;
    }
    return base;
  }, [items]);

  const filteredItems = useMemo(
    () => (statusFilter === "all" ? items : items.filter((i) => i.status === statusFilter)),
    [items, statusFilter]
  );

  async function updateStatus(id: string, status: TrackerStatus) {
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (!updateError) {
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
    }
  }

  // Mirrors the SQL that generates grants.title_key in
  // supabase/dedup_migration.sql: lowercase, then drop everything that isn't
  // a letter or digit. Keep the two in sync — if the SQL normalisation ever
  // changes, this must change with it.
  function titleKeyOf(title: string) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  async function addManualGrant() {
    const title = manualTitle.trim();
    if (!title) return;
    setError(null);

    // grants.title_key now has a unique index, so a plain insert would throw
    // if this title already exists (e.g. the scanner already found it). Look
    // for that existing row first and just track it, rather than erroring or
    // creating the duplicate the index is there to prevent.
    const { data: existing, error: lookupError } = await supabase
      .from("grants")
      .select("id")
      .eq("title_key", titleKeyOf(title))
      .maybeSingle();
    if (lookupError) {
      setError(lookupError.message);
      return;
    }

    let grantId = existing?.id as string | undefined;

    if (!grantId) {
      const { data: grantRow, error: grantError } = await supabase
        .from("grants")
        .insert({
          title,
          content_hash: `manual-${Date.now()}-${title.toLowerCase()}`,
        })
        .select("id")
        .single();
      if (grantError || !grantRow) {
        setError(grantError?.message ?? "Could not add that grant.");
        return;
      }
      grantId = grantRow.id;
    }

    const { error: trackerError } = await supabase.from("tracker_items").insert({
      grant_id: grantId,
      status: "tracking",
    });
    if (trackerError) {
      setError(trackerError.message);
      return;
    }
    setManualTitle("");
    setAddingManual(false);
    loadData();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Total tracked" value={counts.total} color="text-neutral-800" />
        <StatTile label="In progress" value={counts.in_progress} color="text-neutral-800" />
        <StatTile label="Submitted" value={counts.submitted} color="text-neutral-800" />
        <StatTile label="Won 🎉" value={counts.won} color="text-emerald-600" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <FilterPill active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
            All statuses
          </FilterPill>
          {TRACKER_STATUSES.map((status) => (
            <FilterPill
              key={status}
              active={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {STATUS_LABELS[status]}
            </FilterPill>
          ))}
        </div>
        <button
          onClick={() => setAddingManual((v) => !v)}
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700"
        >
          + Add grant
        </button>
      </div>

      {addingManual && (
        <div className="flex gap-2 rounded-lg border border-neutral-200 bg-white p-4">
          <input
            value={manualTitle}
            onChange={(e) => setManualTitle(e.target.value)}
            placeholder="Grant / opportunity name"
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
          />
          <button
            onClick={addManualGrant}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
          >
            Save
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && filteredItems.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center text-neutral-500">
          <p className="mb-1 font-medium text-neutral-700">No grants tracked yet</p>
          <p className="text-sm">
            Add grants from the scanner, or manually track any opportunity your team is pursuing.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {filteredItems.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-4"
          >
            <div>
              <p className="font-medium text-neutral-800">{item.grant?.title ?? "(untitled grant)"}</p>
              {item.grant?.funder && <p className="text-sm text-neutral-500">{item.grant.funder}</p>}
            </div>
            <select
              value={item.status}
              onChange={(e) => updateStatus(item.id, e.target.value as TrackerStatus)}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            >
              {TRACKER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatTile({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 text-center">
      <p className={`text-3xl font-semibold ${color}`}>{value}</p>
      <p className="mt-1 text-xs uppercase tracking-wide text-neutral-500">{label}</p>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  // Solid-fill pills, matching the "Focus areas" filters in GrantScanner and
  // EventsScanner. The previous border-only style had no background, so an
  // inactive pill was thin grey text floating directly on the background
  // photo and was effectively invisible. An opaque pill reads clearly
  // whatever happens to be behind it.
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-[var(--accent)] text-white"
          : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}
