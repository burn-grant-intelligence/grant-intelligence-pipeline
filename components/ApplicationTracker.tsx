"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { ActionItem, Grant, OpportunityNote, TRACKER_STATUSES, TrackerItem, TrackerStatus } from "@/lib/types";
import OpportunityBreakdown from "@/components/OpportunityBreakdown";
import TeamInbox from "@/components/TeamInbox";
import { LEADS, canonicalLead, categoryLabel, fmtDate, statusLabel } from "@/lib/pipeline";
import { isLive, removeOpportunity, restoreOpportunity, sendBackToScanner } from "@/lib/collab";
import { setViewer, useViewer } from "@/lib/viewer";
import { KIND_BADGE, kindOf } from "@/lib/opportunityType";
import { findSimilarTitle } from "@/lib/titleSimilarity";
import { applyReviewPlan, planReviewSync } from "@/lib/eligibilityReview";

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

// "removed": opportunities taken out with "Delete" (they can be restored).
type StatusFilter = TrackerStatus | "all" | "in_progress" | "removed";

// "Viewing as" is remembered per browser (no logins in this app): lib/viewer.ts.

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
  // Breakdown panel, meeting notes and action points (Opportunity Pipeline, 2026-10-01).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<OpportunityNote[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [notesError, setNotesError] = useState<string | null>(null);
  const viewer = useViewer();
  // "Delete": the card being removed, and the reason typed.
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  // Where a removed opportunity goes: back to the Grant Scanner (default) or discarded there too.
  const [removeDiscard, setRemoveDiscard] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // Then make sure every opportunity the eligibility check flagged "Needs
    // further review" has a 👀 review action point with its lead.
    Promise.all([loadData(), loadNotesAndActions()]).then(async ([loaded, acts]) => {
      if (!loaded || !acts) return;
      const res = await applyReviewPlan(supabase, planReviewSync(loaded, acts));
      if (res.created.length || res.closed.length) reloadActions();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadActions = useCallback(async () => {
    const { data, error: e } = await supabase.from("action_items").select("*").order("created_at", { ascending: true });
    if (!e) setActions((data as ActionItem[]) ?? []);
  }, []);

  async function loadNotesAndActions() {
    const [n, a] = await Promise.all([
      supabase.from("opportunity_notes").select("*").order("meeting_date", { ascending: false }),
      supabase.from("action_items").select("*").order("created_at", { ascending: true }),
    ]);
    const err = n.error ?? a.error;
    setNotesError(
      err
        ? "Meeting notes and action points aren't available yet — run supabase/opportunity_pipeline_migration_2026-10-01.sql in Supabase."
        : null
    );
    setNotes((n.data as OpportunityNote[]) ?? []);
    setActions((a.data as ActionItem[]) ?? []);
    return a.error ? null : ((a.data as ActionItem[]) ?? []);
  }

  const chooseViewer = (name: string) => setViewer(name || null);

  async function toggleActionDone(a: ActionItem) {
    const patch = { done: !a.done, done_at: !a.done ? new Date().toISOString() : null };
    const { error: e } = await supabase.from("action_items").update(patch).eq("id", a.id);
    if (e) return setNotesError(e.message);
    setActions((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...patch } : x)));
  }

  function openOpportunity(trackerItemId: string, anchorId?: string) {
    setStatusFilter("all");
    setExpandedId(trackerItemId);
    setTimeout(() => {
      const target = (anchorId && document.getElementById(anchorId)) || document.getElementById(`opp-${trackerItemId}`);
      target?.scrollIntoView({ behavior: "smooth", block: anchorId ? "center" : "start" });
      if (anchorId && target) {
        target.classList.add("ring-2", "ring-[var(--accent)]");
        setTimeout(() => target.classList.remove("ring-2", "ring-[var(--accent)]"), 2500);
      }
    }, 150);
  }

  // Remove from tracker: hidden in every tab (Tracker, Eligibility, Draft
  // Application, Management Dashboard). The grant goes back to the Grant
  // Scanner, or is discarded there too if chosen. Nothing is deleted —
  // "Removed" lists it with a Restore button.
  async function confirmRemove(item: TrackerItem) {
    setBusyId(item.id);
    setNotice(null);
    const title = item.grant?.title ?? "this opportunity";
    const discard = removeDiscard;
    const err = await removeOpportunity(item, viewer, removeReason.trim() || null, title, discard);
    setBusyId(null);
    if (err && !/team_notifications/i.test(err)) return setError(err);
    const now = new Date().toISOString();
    setItems((prev) =>
      prev.map((i) =>
        i.id === item.id
          ? { ...i, removed_at: now, removed_by: viewer, removed_reason: removeReason.trim() || null, grant: i.grant ? ({ ...i.grant, discarded: discard } as Grant) : i.grant }
          : i
      )
    );
    setRemovingId(null);
    setRemoveReason("");
    setRemoveDiscard(false);
    if (expandedId === item.id) setExpandedId(null);
    setNotice(
      discard
        ? `Deleted "${title}" — it is gone from every tab and the Grant Scanner, but kept in the database. Find it under “Removed” to bring it back.`
        : `Removed "${title}" from the tracker. It is back in the Grant Scanner, ready to track again — its notes are kept.`
    );
  }

  async function restore(item: TrackerItem) {
    setBusyId(item.id);
    const err = await restoreOpportunity(item);
    setBusyId(null);
    if (err) return setError(err);
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, removed_at: null, removed_by: null, removed_reason: null } : i)));
    setNotice(`Restored "${item.grant?.title ?? "the opportunity"}" — it is back in every tab.`);
  }

  // Discarded opportunities only: put it back in the Grant Scanner without
  // bringing it back into the tracker.
  async function sendBack(item: TrackerItem) {
    if (!item.grant_id) return;
    setBusyId(item.id);
    const err = await sendBackToScanner(item.grant_id);
    setBusyId(null);
    if (err) return setError(err);
    setItems((prev) => prev.map((i) => (i.id === item.id && i.grant ? { ...i, grant: { ...i.grant, discarded: false } as Grant } : i)));
    setNotice(`"${item.grant?.title ?? "The opportunity"}" is back in the Grant Scanner, ready to track again.`);
  }

  const patchItem = (id: string, patch: Partial<TrackerItem>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const patchGrant = (id: string, patch: Partial<Grant>) =>
    setItems((prev) => prev.map((i) => (i.id === id && i.grant ? { ...i, grant: { ...i.grant, ...patch } } : i)));

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
    return fetchError ? null : ((data as unknown as TrackerItem[]) ?? []);
  }

  const liveItems = useMemo(() => items.filter(isLive), [items]);
  const removedItems = useMemo(() => items.filter((i) => !isLive(i)), [items]);

  const counts = useMemo(() => {
    const base = {
      total: liveItems.length,
      in_progress: 0,
      submitted: 0,
      won: 0,
      wonValue: 0,
      implementation: 0,
      implementationValue: 0,
    };
    for (const item of liveItems) {
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
  }, [liveItems]);

  const filteredItems = useMemo(() => {
    if (statusFilter === "removed") return removedItems;
    if (statusFilter === "all") return liveItems;
    if (statusFilter === "in_progress") {
      return liveItems.filter((i) => IN_PROGRESS_STATUSES.includes(i.status));
    }
    return liveItems.filter((i) => i.status === statusFilter);
  }, [liveItems, removedItems, statusFilter]);

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

    // Not the exact title? Look for the same opportunity worded differently
    // (~75% of the title the same — lib/titleSimilarity.ts), so "EU 2027 Call
    // for Solutions" attaches to "Call for Solutions Horizon Europe EU 2027".
    if (!grantId) {
      const { data: all } = await supabase.from("grants").select("id, title").order("first_seen_at", { ascending: false }).limit(2000);
      const similar = findSimilarTitle(title, (all ?? []) as { id: string; title: string | null }[]);
      if (similar) grantId = similar.match.id;
    }

    // Each opportunity is tracked once: if it is already in the tracker, say so.
    // If it was removed, bring it back instead.
    if (grantId) {
      const already = items.find((i) => i.grant_id === grantId);
      if (already && !isLive(already)) {
        await restore(already);
        resetManualForm();
        setExpandedId(already.id);
        return;
      }
      const { data: trackedRows } = already ? { data: [already] } : await supabase.from("tracker_items").select("id").eq("grant_id", grantId).limit(1);
      if (trackedRows && trackedRows.length) {
        const name = already?.grant?.title ?? "this opportunity";
        setError(`Already tracked: "${name}" is in the tracker${already?.owner ? ` (lead: ${already.owner})` : ""}. Each opportunity is tracked once — add your notes to it instead.`);
        if (already) setExpandedId(already.id);
        return;
      }
    }

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
      // What the user types here is the opportunity's description (the
      // Description box in its Breakdown), not a tracker note.
      pipeline_description: manualNotes.trim() || null,
    });
    if (trackerError) {
      setError(trackerError.code === "23505" ? "Already tracked — each opportunity is tracked once. Refresh to see it." : trackerError.message);
      return;
    }
    resetManualForm();
    loadData();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3">
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          Viewing as
          <select value={viewer ?? ""} onChange={(e) => chooseViewer(e.target.value)} className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-800">
            <option value="">Choose your name…</option>
            {LEADS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-neutral-400">Tag teammates by typing their name in notes, action points and replies.</p>
      </div>

      <TeamInbox
        viewer={viewer}
        items={items}
        actions={actions}
        onToggleAction={toggleActionDone}
        onOpen={openOpportunity}
        onRefresh={reloadActions}
      />

      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
          <button onClick={() => setNotice(null)} className="text-emerald-700 hover:text-emerald-900" aria-label="Dismiss">✕</button>
        </div>
      )}

      {notesError && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{notesError}</div>
      )}

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
          {removedItems.length > 0 && (
            <FilterPill active={statusFilter === "removed"} onClick={() => setStatusFilter("removed")}>
              🗑️ Removed ({removedItems.length})
            </FilterPill>
          )}
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
              placeholder="Description (what it funds, who can apply, key dates). It is saved in the opportunity's Breakdown."
              aria-label="Description"
              rows={3}
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

      {!loading && !error && filteredItems.length === 0 && statusFilter !== "removed" && (
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

          const expanded = expandedId === item.id;
          const removed = !isLive(item);
          const chips = [categoryLabel(item.pipeline_category), statusLabel(item.pipeline_status), canonicalLead(item.owner)].filter(Boolean);
          const openCount = actions.filter((a) => a.tracker_item_id === item.id && !a.done).length;

          return (
            <div key={item.id} id={`opp-${item.id}`} className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                {item.pipeline_link?.trim() || item.grant?.application_url ? (
                  <a
                    href={item.pipeline_link?.trim() || item.grant?.application_url || undefined}
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
                <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${KIND_BADGE[kindOf(item.grant)].className}`}>
                  {KIND_BADGE[kindOf(item.grant)].label}
                </span>
                {details && <p className="text-sm text-neutral-500">{details}</p>}
                {(chips.length > 0 || openCount > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {chips.map((c) => (
                      <span key={c} className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                        {c}
                      </span>
                    ))}
                    {openCount > 0 && (
                      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
                        {openCount} open action point{openCount > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {removed ? (
                <div className="flex items-center gap-3">
                  <p className="text-xs text-neutral-500">
                    {(item.grant as (Grant & { discarded?: boolean }) | null | undefined)?.discarded ? "Deleted — kept in the database" : "Sent back to the Grant Scanner"}
                    {item.removed_by ? ` by ${canonicalLead(item.removed_by)}` : ""}
                    {item.removed_at ? ` on ${fmtDate(item.removed_at.slice(0, 10))}` : ""}
                    {item.removed_reason ? ` — ${item.removed_reason}` : ""}
                  </p>
                  {(item.grant as (Grant & { discarded?: boolean }) | null | undefined)?.discarded && (
                    <button
                      onClick={() => sendBack(item)}
                      disabled={busyId === item.id}
                      title="Show it in the Grant Scanner again, without putting it back in the tracker"
                      className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-40"
                    >
                      ↩ Send back to Scanner
                    </button>
                  )}
                  <button
                    onClick={() => restore(item)}
                    disabled={busyId === item.id}
                    title="Back into the tracker (and the Scanner)"
                    className="rounded-md border border-emerald-600 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
                  >
                    ↩ Restore to tracker
                  </button>
                </div>
              ) : (
              <div className="flex items-center gap-2">
                {item.clickup_url && (
                  <a
                    href={item.clickup_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open this opportunity in ClickUp"
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                  >
                    ClickUp ↗
                  </a>
                )}
                <button
                  onClick={() => setExpandedId(expanded ? null : item.id)}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                    expanded ? "border-[var(--accent)] bg-orange-50 text-[var(--accent)]" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                  }`}
                >
                  Breakdown {expanded ? "▴" : "▾"}
                </button>
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
                <button
                  onClick={() => {
                    setRemovingId(removingId === item.id && !removeDiscard ? null : item.id);
                    setRemoveReason("");
                    setRemoveDiscard(false);
                  }}
                  title="Remove from tracker — takes it out of every tab and sends it back to the Grant Scanner (nothing is deleted)"
                  aria-label="Remove this opportunity from the tracker"
                  className="rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-500 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                >
                  🗑️ Remove
                </button>
                <button
                  onClick={() => {
                    setRemovingId(removingId === item.id && removeDiscard ? null : item.id);
                    setRemoveReason("");
                    setRemoveDiscard(true);
                  }}
                  title="Delete — takes it out of the tracker AND the Grant Scanner. It stays saved in the database."
                  aria-label="Delete this opportunity from the app (kept in the database)"
                  className="rounded-md border border-red-300 px-2.5 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  ✕ Delete
                </button>
              </div>
              )}
            </div>
            {removingId === item.id && !removed && (
              <div className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3">
                <p className="text-sm font-medium text-red-800">
                  {removeDiscard ? "Delete" : "Remove"} “{item.grant?.title ?? "this opportunity"}” {removeDiscard ? "from the app?" : "from the tracker?"}
                </p>
                <p className="text-xs text-red-700">
                  {removeDiscard
                    ? "It disappears from the Application Tracker, Eligibility Tracker, Draft Application, Management Dashboard and the Grant Scanner. It is not erased: it stays saved in the database, with its notes, drafts and action points, and can be brought back from 🗑️ Removed."
                    : "It leaves the Application Tracker, Eligibility Tracker, Draft Application and Management Dashboard and goes back to the Grant Scanner, ready to track again. Notes, drafts and action points are kept."}
                  {canonicalLead(item.owner) && canonicalLead(item.owner) !== viewer ? ` ${canonicalLead(item.owner)} (the lead) will be told.` : ""}
                </p>
                <input
                  value={removeReason}
                  onChange={(e) => setRemoveReason(e.target.value)}
                  placeholder="Why? (optional) e.g. not working on it now, not eligible, duplicate"
                  className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm"
                  onKeyDown={(e) => e.key === "Enter" && confirmRemove(item)}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setRemovingId(null)} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50">
                    Cancel
                  </button>
                  <button
                    onClick={() => confirmRemove(item)}
                    disabled={busyId === item.id}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
                  >
                    {busyId === item.id ? (removeDiscard ? "Deleting…" : "Removing…") : removeDiscard ? "Delete" : "Remove from tracker"}
                  </button>
                </div>
              </div>
            )}
            {expanded && !removed && (
              <OpportunityBreakdown
                item={item}
                viewer={viewer}
                notes={notes.filter((n) => n.tracker_item_id === item.id)}
                actions={actions.filter((a) => a.tracker_item_id === item.id)}
                onItemChange={(patch) => patchItem(item.id, patch)}
                onGrantChange={(patch) => patchGrant(item.id, patch)}
                onNotesChange={setNotes}
                onActionsChange={setActions}
              />
            )}
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
