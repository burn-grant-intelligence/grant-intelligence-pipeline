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
  implementation: "Implementation",
  lost: "Lost",
};

// The three "still in the pipeline" statuses that roll up into the
// "In progress" stat tile and filter.
const IN_PROGRESS_STATUSES: TrackerStatus[] = ["tracking", "researching", "drafting"];

type StatusFilter = TrackerStatus | "all" | "in_progress";

function formatMoney(amount: number, currency?: string | null) {
  return `${currency ?? "USD"} ${amount.toLocaleString()}`;
}

export default function ApplicationTracker() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [addingManual, setAddingManual] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualDeadline, setManualDeadline] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualSource, setManualSource] = useState("");
  const [manualNotes, setManualNotes] = useState("");

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
    const base = {
      total: items.length,
      in_progress: 0,
      submitted: 0,
      won: 0,
      wonValue: 0,
      implementation: 0,
      implementationValue: 0,
    };
    for (const item of items) {
      if (IN_PROGRESS_STATUSES.includes(item.status)) base.in_progress++;
      if (item.status === "submitted") base.submitted++;
      if (item.status === "won") {
        base.won++;
        base.wonValue += item.grant?.amount ?? 0;
      }
      if (item.status === "implementation") {
        base.implementation++;
        base.implementationValue += item.grant?.amount ?? 0;
      }
    }
    return base;
  }, [items]);

  const filteredItems = useMemo(() => {
    if (statusFilter === "all") return items;
    if (statusFilter === "in_progress") {
      return items.filter((i) => IN_PROGRESS_STATUSES.includes(i.status));
    }
    return items.filter((i) => i.status === statusFilter);
  }, [items, statusFilter]);

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

  function resetManualForm() {
    setManualTitle("");
    setManualUrl("");
    setManualDeadline("");
    setManualAmount("");
    setManualSource("");
    setManualNotes("");
    setAddingManual(false);
  }

  async function addManualGrant() {
    const title = manualTitle.trim();
    if (!title) return;
    setError(null);

    let amount: number | null = null;
    if (manualAmount.trim()) {
      amount = Number(manualAmount.trim());
      if (Number.isNaN(amount)) {
        setError("Grant size must be a number.");
        return;
      }
    }

    // Only the fields the user actually filled in — so enriching an
    // already-discovered grant (see below) never blanks out data the
    // scanner already captured.
    const grantFields: Record<string, unknown> = {};
    if (manualUrl.trim()) grantFields.application_url = manualUrl.trim();
    if (manualDeadline) grantFields.deadline = manualDeadline;
    if (amount !== null) {
      grantFields.amount = amount;
      grantFields.currency = "USD";
    }
    if (manualSource.trim()) grantFields.source_note = manualSource.trim();

    // grants.title_key has a unique index, so a plain insert would throw if
    // this title already exists (e.g. the scanner already found it). Look
    // for that existing row first and just track it (enriching it with
    // whatever this form captured), rather than erroring or creating the
    // duplicate the index is there to prevent.
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

    if (grantId) {
      if (Object.keys(grantFields).length > 0) {
        const { error: enrichError } = await supabase
          .from("grants")
          .update(grantFields)
          .eq("id", grantId);
        if (enrichError) {
          setError(enrichError.message);
          return;
        }
      }
    } else {
      const { data: grantRow, error: grantError } = await supabase
        .from("grants")
        .insert({
          title,
          content_hash: `manual-${Date.now()}-${title.toLowerCase()}`,
          ...grantFields,
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
      notes: manualNotes.trim() || null,
    });
    if (trackerError) {
      setError(trackerError.message);
      return;
    }
    resetManualForm();
    loadData();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Total tracked"
          value={counts.total}
          color="text-neutral-800"
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
        />
        <StatTile
          label="In progress"
          value={counts.in_progress}
          color="text-neutral-800"
          active={statusFilter === "in_progress"}
          onClick={() => setStatusFilter("in_progress")}
        />
        <StatTile
          label="Submitted"
          value={counts.submitted}
          color="text-neutral-800"
          active={statusFilter === "submitted"}
          onClick={() => setStatusFilter("submitted")}
        />
        <StatTile
          label="Won 🎉"
          value={counts.won}
          color="text-emerald-600"
          subtitle={counts.wonValue > 0 ? formatMoney(counts.wonValue) : undefined}
          active={statusFilter === "won"}
          onClick={() => setStatusFilter("won")}
        />
        <StatTile
          label="Implementation"
          value={counts.implementation}
          color="text-blue-600"
          subtitle={counts.implementationValue > 0 ? formatMoney(counts.implementationValue) : undefined}
          active={statusFilter === "implementation"}
          onClick={() => setStatusFilter("implementation")}
        />
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
          onClick={() => (addingManual ? resetManualForm() : setAddingManual(true))}
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700"
        >
          + Add grant
        </button>
      </div>

      {addingManual && (
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              value={manualTitle}
              onChange={(e) => setManualTitle(e.target.value)}
              placeholder="Grant / opportunity name *"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm sm:col-span-2"
            />
            <input
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              placeholder="Link to the opportunity"
              type="url"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
            <input
              value={manualDeadline}
              onChange={(e) => setManualDeadline(e.target.value)}
              type="date"
              aria-label="Deadline"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-600"
            />
            <input
              value={manualAmount}
              onChange={(e) => setManualAmount(e.target.value)}
              placeholder="Grant size (USD)"
              type="number"
              min="0"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
            <input
              value={manualSource}
              onChange={(e) => setManualSource(e.target.value)}
              placeholder="Source (how you found this)"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            />
            <textarea
              value={manualNotes}
              onChange={(e) => setManualNotes(e.target.value)}
              placeholder="Notes"
              rows={2}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm sm:col-span-2"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={resetManualForm}
              className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
            >
              Cancel
            </button>
            <button
              onClick={addManualGrant}
              disabled={!manualTitle.trim()}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
          </div>
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
        {filteredItems.map((item) => {
          const details = [
            item.grant?.funder,
            item.grant?.amount ? formatMoney(item.grant.amount, item.grant.currency) : null,
            item.grant?.deadline ? `Due ${item.grant.deadline}` : null,
            item.grant?.source_note,
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-4"
            >
              <div className="min-w-0 flex-1">
                {item.grant?.application_url ? (
                  <a
                    href={item.grant.application_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-neutral-800 underline decoration-neutral-300 underline-offset-2 hover:text-[var(--accent)]"
                  >
                    {item.grant?.title ?? "(untitled grant)"}
                  </a>
                ) : (
                  <p className="font-medium text-neutral-800">
                    {item.grant?.title ?? "(untitled grant)"}
                  </p>
                )}
                {details && <p className="text-sm text-neutral-500">{details}</p>}
                {item.notes && <p className="mt-1 text-sm italic text-neutral-500">{item.notes}</p>}
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
          );
        })}
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  color,
  subtitle,
  active,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  subtitle?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  // A real <button> (not a <div>) so this is keyboard/focus accessible —
  // every tile now doubles as a shortcut for the matching status filter.
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-4 text-center transition-colors ${
        active
          ? "border-[var(--accent)] bg-orange-50"
          : "border-neutral-200 bg-white hover:bg-neutral-50"
      }`}
    >
      <p className={`text-3xl font-semibold ${color}`}>{value}</p>
      <p className="mt-1 text-xs uppercase tracking-wide text-neutral-500">{label}</p>
      {subtitle && <p className="mt-1 text-xs font-medium text-neutral-600">{subtitle}</p>}
    </button>
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
