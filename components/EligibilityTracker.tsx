"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabaseClient";
import { ActionItem, ActionReply, ApplicantType, EligibilityVerdict, FitStatus, Grant, TrackerItem } from "@/lib/types";
import type { EligibilityReport, RuleResult } from "@/lib/eligibility/types";
import { LEADS, canonicalLead, effectiveFields, firstName, myOpenActions } from "@/lib/pipeline";
import { searchWords } from "@/lib/opportunitySection";
import { setViewer, useViewer } from "@/lib/viewer";
import {
  applyReviewPlan,
  finalResult,
  isReviewAction,
  nextStepFor,
  openReviewFor,
  outcomeBody,
  planReviewSync,
  type NextStep,
} from "@/lib/eligibilityReview";
import EligibilityReview, { PersonChip } from "@/components/EligibilityReview";
import { ActionRow } from "@/components/OpportunityBreakdown";

const FIT_LABELS: Record<FitStatus, string> = {
  unreviewed: "Unreviewed",
  fit: "Fit",
  not_fit: "Not fit",
};

const APPLICANT_TYPE_LABELS: Record<ApplicantType, string> = {
  single: "Single applicant",
  consortium: "Consortium",
  either: "Either",
  unclear: "Unclear",
};

// Quick-access button, same idea as QUICK_LINKS in ManagementDashboard.tsx.
// Paste the SharePoint grants-folder link between the quotes on the next line;
// the "Grants Folder" button only shows once a link is set.
const GRANTS_FOLDER_URL = "https://burn.sharepoint.com/sites/BurnMFG_Main_Site2/3GA_General_and_Admin/Shared%20Documents/Forms/AllItems.aspx?d=w0143488dc9a54b0b96b79d993d48667f&csf=1&web=1&e=kmJNOx&ovuser=5b303516%2Df2b1%2D4ff6%2D96ad%2D5945b63736b1%2Cbornventure%2Ekinoti%40burnmfg%2Ecom&TeamsCID=936d8908%2Da474%2D4641%2D93c2%2D1f2a2910bdbd&OR=Teams%2DHL&CT=1790777568310&clickparams=eyJBcHBOYW1lIjoiVGVhbXMtV2ViIiwiQXBwVmVyc2lvbiI6IjE0MTUvMjYwOTAzMTU4MjAiLCJIYXNGZWRlcmF0ZWRVc2VyIjpmYWxzZX0%3D&CID=604d40a2%2D20a8%2Dc000%2D24e3%2D84b8bf90e399&cidOR=SPO&FolderCTID=0x012000D3838D15058D3640BED1BFABA1194795&id=%2Fsites%2FBurnMFG%5FMain%5FSite2%2F3GA%5FGeneral%5Fand%5FAdmin%2FShared%20Documents%2F31GA%5FCEO%5FOffice%2F31GA%2D06%5FGrants";

// What the eligibility engine concluded about the opportunity (rules against
// BURN's profile). "Needs review" is a verdict, not a Fit status: it leaves
// the item Unreviewed until someone decides.
const VERDICT_LABELS: Record<EligibilityVerdict, string> = {
  fit: "Fit",
  not_fit: "Not a fit",
  needs_review: "Needs further review",
};

const VERDICT_STYLES: Record<EligibilityVerdict, string> = {
  fit: "border-emerald-200 bg-emerald-50 text-emerald-800",
  not_fit: "border-red-200 bg-red-50 text-red-800",
  needs_review: "border-amber-200 bg-amber-50 text-amber-800",
};

type FitFilter = FitStatus | "all" | "needs_review";

// Everything a row needs to show for "Supporting Docs" — a named list when
// Gemini could enumerate documents, or a single RFP/call-page link when it
// couldn't (per the "if it can't get the list, at least link the RFP"
// requirement this tab was built around). Never both blank if a source link
// exists on the grant at all.
function docsSummaryForExport(grant: Grant | null): string {
  if (!grant) return "";
  if (grant.supporting_docs && grant.supporting_docs.length > 0) {
    return grant.supporting_docs.map((d) => d.name).join(", ");
  }
  if (grant.rfp_url) return `RFP: ${grant.rfp_url}`;
  return grant.eligibility_checked_at ? "None listed" : "Not checked yet";
}

// Search: every word typed must appear in the title, funder, lead, countries,
// sector, description or eligibility text (any order, any case).
function matchesItem(item: TrackerItem, words: string[]): boolean {
  if (!words.length) return true;
  const g = item.grant;
  const eff = effectiveFields(item);
  const hay = [
    eff.programName, eff.funder, g?.title, g?.funder, eff.lead, eff.description, g?.eligibility, g?.geography,
    ...(g?.eligible_countries ?? []), ...(g?.focus_areas ?? []), ...(item.target_countries ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

const STEP_STYLES: Record<NextStep["key"], string> = {
  review: "bg-amber-100 text-amber-900 border-amber-300",
  check: "bg-blue-50 text-blue-800 border-blue-200",
  decide: "bg-violet-50 text-violet-800 border-violet-200",
  waiting: "bg-neutral-100 text-neutral-600 border-neutral-200",
};

export default function EligibilityTracker() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fitFilter, setFitFilter] = useState<FitFilter>("all");
  const [checkingGrantId, setCheckingGrantId] = useState<string | null>(null);
  // "Paste the call text" fallback: which cards have the box open, and what is typed in it.
  const [pasteOpen, setPasteOpen] = useState<Record<string, boolean>>({});
  const [pasteDrafts, setPasteDrafts] = useState<Record<string, string>>({});
  // Action points (for reviews and "your open action points") and the replies on reviews.
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [replies, setReplies] = useState<ActionReply[]>([]);
  // A problem with reviews that shouldn't hide the list (e.g. migration not run yet).
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // "View as" is the same choice as "Viewing as" in the Application Tracker (lib/viewer.ts).
  const viewer = useViewer();
  const me = canonicalLead(viewer);

  async function loadData() {
    setLoading(true);
    setError(null);
    const [{ data, error: fetchError }, acts] = await Promise.all([
      supabase.from("tracker_items").select("*, grant:grants(*)").order("updated_at", { ascending: false }),
      supabase.from("action_items").select("*").order("created_at", { ascending: true }),
    ]);
    if (fetchError) setError(fetchError.message);
    // "Remove & discard" in the Application Tracker hides an opportunity everywhere.
    const live = ((data as unknown as TrackerItem[]) ?? []).filter((i) => !i.removed_at);
    setItems(live);
    setLoading(false);
    if (acts.error) return;
    let actionRows = (acts.data as ActionItem[]) ?? [];

    // Every opportunity the check flagged "Needs further review" gets a review
    // with its lead; reviews no longer needed are closed (lib/eligibilityReview.ts).
    if (!fetchError) {
      const res = await applyReviewPlan(supabase, planReviewSync(live, actionRows));
      setNotice(res.error);
      if (res.created.length || res.closed.length) {
        const closed = new Set(res.closed.map((c) => c.id));
        const now = new Date().toISOString();
        actionRows = [...actionRows.map((a) => (closed.has(a.id) ? { ...a, done: true, done_at: now } : a)), ...res.created];
      }
    }
    setActions(actionRows);

    const reviewIds = actionRows.filter(isReviewAction).map((a) => a.id);
    if (reviewIds.length) {
      const { data: r } = await supabase.from("action_replies").select("*").in("action_id", reviewIds).order("created_at", { ascending: true });
      setReplies((r as ActionReply[]) ?? []);
    }
  }

  useEffect(() => {
    const t = setTimeout(loadData, 0);
    return () => clearTimeout(t);
  }, []);

  // What the person in "View as" has to do on each opportunity.
  const stepById = useMemo(() => new Map(items.map((i) => [i.id, nextStepFor(i, actions, viewer)])), [items, actions, viewer]);
  // Their other open action points (from the Application Tracker), per opportunity.
  const myActionsById = useMemo(() => {
    const map = new Map<string, ActionItem[]>();
    for (const a of myOpenActions(actions.filter((x) => !isReviewAction(x)), viewer)) {
      map.set(a.tracker_item_id, [...(map.get(a.tracker_item_id) ?? []), a]);
    }
    return map;
  }, [actions, viewer]);

  // Search, then "View as": the opportunities they lead, plus any with a
  // review or action point waiting for them.
  const visibleItems = useMemo(() => {
    const words = searchWords(search);
    const list = items.filter(
      (i) => matchesItem(i, words) && (!me || canonicalLead(i.owner) === me || !!stepById.get(i.id) || myActionsById.has(i.id))
    );
    if (!me) return list;
    const rank = (i: TrackerItem) => stepById.get(i.id)?.rank ?? (myActionsById.has(i.id) ? 4 : 9);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [items, search, me, stepById, myActionsById]);

  const mySummary = useMemo(() => {
    if (!me) return null;
    const steps = visibleItems.map((i) => stepById.get(i.id)?.key);
    return {
      leads: visibleItems.filter((i) => canonicalLead(i.owner) === me).length,
      reviews: steps.filter((k) => k === "review").length,
      notChecked: steps.filter((k) => k === "check").length,
      decide: steps.filter((k) => k === "decide").length,
      actions: visibleItems.reduce((n, i) => n + (myActionsById.get(i.id)?.length ?? 0), 0),
    };
  }, [me, visibleItems, stepById, myActionsById]);

  const counts = useMemo(() => {
    const base = { all: visibleItems.length, unreviewed: 0, fit: 0, not_fit: 0, needs_review: 0 };
    for (const item of visibleItems) {
      const status = item.fit_status ?? "unreviewed";
      base[status]++;
      if (status === "unreviewed" && item.grant?.eligibility_verdict === "needs_review") base.needs_review++;
    }
    return base;
  }, [visibleItems]);

  const filteredItems = useMemo(
    () =>
      fitFilter === "all"
        ? visibleItems
        : fitFilter === "needs_review"
        ? visibleItems.filter(
            (i) => (i.fit_status ?? "unreviewed") === "unreviewed" && i.grant?.eligibility_verdict === "needs_review"
          )
        : visibleItems.filter((i) => (i.fit_status ?? "unreviewed") === fitFilter),
    [visibleItems, fitFilter]
  );

  // A person's Fit / Not fit choice is marked fit_source "manual" so a later
  // "Re-check eligibility" never overwrites it; picking "Unreviewed" hands the
  // decision back to the eligibility check (fit_source cleared).
  async function updateFit(trackerItemId: string, fit_status: FitStatus) {
    const fit_source = fit_status === "unreviewed" ? null : "manual";
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ fit_status, fit_source, updated_at: new Date().toISOString() })
      .eq("id", trackerItemId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === trackerItemId ? { ...i, fit_status, fit_source } : i)));

    // Deciding by hand also closes the open review, noting who decided.
    const open = fit_status !== "unreviewed" ? openReviewFor(trackerItemId, actions) : null;
    if (open) {
      const now = new Date().toISOString();
      const { error: aErr } = await supabase.from("action_items").update({ done: true, done_at: now }).eq("id", open.id);
      if (aErr) return setError(aErr.message);
      setActions((prev) => prev.map((a) => (a.id === open.id ? { ...a, done: true, done_at: now } : a)));
      const { data: reply } = await supabase
        .from("action_replies")
        .insert({ action_id: open.id, tracker_item_id: trackerItemId, author: me, body: outcomeBody(fit_status === "fit" ? "fit" : "not_fit", "") })
        .select()
        .single();
      if (reply) setReplies((prev) => [...prev, reply as ActionReply]);
    }
  }

  async function toggleAction(a: ActionItem) {
    const patch = { done: !a.done, done_at: !a.done ? new Date().toISOString() : null };
    const { error: e } = await supabase.from("action_items").update(patch).eq("id", a.id);
    if (e) return setError(e.message);
    setActions((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...patch } : x)));
  }

  async function updateFitNotes(trackerItemId: string, fit_notes: string) {
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ fit_notes: fit_notes || null })
      .eq("id", trackerItemId);
    if (updateError) setError(updateError.message);
  }

  // Manual escape hatch (supabase/draft_override_migration_2026-09-25.sql):
  // Draft Application's query only shows fit_status === "fit" items by
  // default (see DraftApplication.tsx's loadData). This lets someone force
  // a specific unreviewed/not-fit item in there anyway, without touching
  // fit_status/fit_notes — the eligibility verdict itself stays intact and
  // visible, only where the item is allowed to show changes.
  async function updateDraftOverride(trackerItemId: string, draft_override: boolean) {
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ draft_override, updated_at: new Date().toISOString() })
      .eq("id", trackerItemId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setItems((prev) =>
      prev.map((i) => (i.id === trackerItemId ? { ...i, draft_override } : i))
    );
  }

  async function checkEligibility(grantId: string, itemId?: string, pastedText?: string) {
    setCheckingGrantId(grantId);
    setError(null);
    try {
      const res = await fetch("/api/check-eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pastedText ? { grantId, pastedText } : { grantId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Eligibility check failed.");
        // Offer the paste-the-text fallback on the card that failed.
        if (itemId) setPasteOpen((prev) => ({ ...prev, [itemId]: true }));
        return;
      }
      // The route returns { grant: <columns written onto the grant>, tracker:
      // <fit_status/fit_source/fit_notes it was allowed to set, per tracker item> }.
      const trackerById = new Map<string, { fit_status: FitStatus; fit_source: "auto" | null; fit_notes: string | null }>(
        (json.tracker ?? []).map((t: { id: string }) => [t.id, t])
      );
      setItems((prev) =>
        prev.map((item) => {
          const trackerChange = trackerById.get(item.id);
          if (item.grant?.id === grantId) {
            return { ...item, ...(trackerChange ?? {}), grant: { ...item.grant!, ...json.grant } };
          }
          return trackerChange ? { ...item, ...trackerChange } : item;
        })
      );
      // "Needs further review" → the lead was tagged with a review; a decided re-check closed it.
      const created: ActionItem[] = json.reviews_created ?? [];
      const closed: { id: string; reply: ActionReply | null }[] = json.reviews_closed ?? [];
      if (created.length || closed.length) {
        const ids = new Set(closed.map((c) => c.id));
        const now = new Date().toISOString();
        setActions((prev) => [...prev.map((a) => (ids.has(a.id) ? { ...a, done: true, done_at: now } : a)), ...created]);
        const closing = closed.map((c) => c.reply).filter((r): r is ActionReply => !!r);
        if (closing.length) setReplies((prev) => [...prev, ...closing]);
      }
      setNotice(json.review_error ?? null);
    } catch {
      setError("Could not reach the eligibility check endpoint. Is the app deployed with GEMINI_API_KEY set?");
      if (itemId) setPasteOpen((prev) => ({ ...prev, [itemId]: true }));
    } finally {
      setCheckingGrantId(null);
    }
  }

  function exportToExcel() {
    const rows = filteredItems.map((item) => ({
      Opportunity: item.grant?.title ?? "(untitled grant)",
      Donor: item.grant?.funder ?? "",
      "Countries of Focus": item.grant?.eligible_countries?.join(", ") ?? "",
      Sector: item.grant?.focus_areas?.join(", ") ?? "",
      "Single / Consortium": APPLICANT_TYPE_LABELS[item.grant?.applicant_type ?? "unclear"],
      "Supporting Docs": docsSummaryForExport(item.grant ?? null),
      Lead: canonicalLead(item.owner) ?? "",
      Fit: FIT_LABELS[item.fit_status ?? "unreviewed"],
      "Eligibility check": item.grant?.eligibility_verdict ? VERDICT_LABELS[item.grant.eligibility_verdict] : "",
      "Check summary": item.grant?.eligibility_report?.summary ?? "",
      "Review with": canonicalLead(openReviewFor(item.id, actions)?.assignee) ?? "",
      "Review notes": replies
        .filter((r) => actions.some((a) => a.id === r.action_id && a.tracker_item_id === item.id))
        .map((r) => `${canonicalLead(r.author) ?? "Someone"}: ${r.body}`)
        .join("\n"),
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [
      { wch: 40 },
      { wch: 22 },
      { wch: 28 },
      { wch: 24 },
      { wch: 18 },
      { wch: 40 },
      { wch: 20 },
      { wch: 12 },
      { wch: 18 },
      { wch: 60 },
      { wch: 20 },
      { wch: 60 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Eligibility Tracker");
    XLSX.writeFile(workbook, `eligibility-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="text-lg font-semibold text-[var(--ink)]">Eligibility Tracker</h2>
        {GRANTS_FOLDER_URL && (
          <a
            href={GRANTS_FOLDER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
          >
            📁 Grants Folder
          </a>
        )}
      </section>

      {/* View as + search */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">
          View as
          <select
            value={me ?? ""}
            onChange={(e) => setViewer(e.target.value || null)}
            aria-label="View as"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm normal-case tracking-normal text-neutral-800"
          >
            <option value="">Whole team</option>
            {LEADS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
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
              placeholder="Title, funder, lead, country or keyword, e.g. FID, Danida, Kenya"
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

      {mySummary && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-4 py-3 text-sm text-neutral-700">
          <PersonChip name={me} />
          <span>
            leads <strong>{mySummary.leads}</strong> opportunit{mySummary.leads === 1 ? "y" : "ies"} here
          </span>
          {mySummary.reviews > 0 && <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STEP_STYLES.review}`}>👀 {mySummary.reviews} review{mySummary.reviews > 1 ? "s" : ""} waiting for you</span>}
          {mySummary.notChecked > 0 && <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STEP_STYLES.check}`}>▶ {mySummary.notChecked} not checked yet</span>}
          {mySummary.decide > 0 && <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STEP_STYLES.decide}`}>{mySummary.decide} to decide</span>}
          {mySummary.actions > 0 && <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-700">✔︎ {mySummary.actions} open action point{mySummary.actions > 1 ? "s" : ""}</span>}
          {!mySummary.reviews && !mySummary.notChecked && !mySummary.decide && !mySummary.actions && <span className="text-xs text-emerald-700">Nothing waiting on you here 🎉</span>}
          <span className="text-xs text-neutral-400">· things needing you are listed first</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <FilterPill active={fitFilter === "all"} onClick={() => setFitFilter("all")}>
            All ({counts.all})
          </FilterPill>
          <FilterPill active={fitFilter === "unreviewed"} onClick={() => setFitFilter("unreviewed")}>
            Unreviewed ({counts.unreviewed})
          </FilterPill>
          <FilterPill active={fitFilter === "needs_review"} onClick={() => setFitFilter("needs_review")}>
            Needs review ({counts.needs_review})
          </FilterPill>
          <FilterPill active={fitFilter === "fit"} onClick={() => setFitFilter("fit")}>
            Fit ({counts.fit})
          </FilterPill>
          <FilterPill active={fitFilter === "not_fit"} onClick={() => setFitFilter("not_fit")}>
            Not fit ({counts.not_fit})
          </FilterPill>
        </div>
        <button
          onClick={exportToExcel}
          disabled={filteredItems.length === 0}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export to Excel
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{notice}</div>}

      {!loading && !error && filteredItems.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center text-neutral-500">
          {items.length === 0 ? (
            <>
              <p className="mb-1 font-medium text-neutral-700">Nothing here yet</p>
              <p className="text-sm">Track an opportunity from the Grant Scanner or Application Tracker first.</p>
            </>
          ) : (
            <>
              <p className="mb-1 font-medium text-neutral-700">No opportunities match</p>
              <p className="text-sm">
                {search ? `Nothing matches “${search}”. ` : ""}
                {me ? `${firstName(me)} isn't the lead on any${fitFilter === "all" ? "" : " of these"} and has nothing waiting. Choose “Whole team” to see everything.` : "Try another filter."}
              </p>
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {filteredItems.map((item) => {
          const grant = item.grant;
          const fitStatus = item.fit_status ?? "unreviewed";
          const isChecking = checkingGrantId === grant?.id;
          const hasBeenChecked = !!grant?.eligibility_checked_at;
          const docs = grant?.supporting_docs ?? [];
          // The link a check reads: the one a person saved in the Application Tracker
          // (Breakdown → Link) wins; otherwise the last link a check used, then the scraper's.
          const savedLink = item.pipeline_link?.trim() || null;
          const checkLink = savedLink || grant?.rfp_url || grant?.application_url || null;
          const pastedDraft = pasteDrafts[item.id] ?? "";
          const showPaste = !!pasteOpen[item.id];
          const step = stepById.get(item.id) ?? null;
          // A team member's review overrides the automatic check: their call is the
          // result, and the automatic one is kept below as the "initial check".
          const itemReviews = actions.filter((x) => x.tracker_item_id === item.id && isReviewAction(x));
          const final = finalResult(
            item,
            replies.filter((r) => itemReviews.some((x) => x.id === r.action_id))
          );
          // The "Why" box still holds the automatic text (FIT — …); show the team's call instead.
          const shownFitNotes =
            final && /^(FIT|NOT FIT|NEEDS FURTHER REVIEW)\b/.test(item.fit_notes ?? "")
              ? [final.statement, final.notes].filter(Boolean).join(" ")
              : item.fit_notes ?? "";
          const myActions = me ? myActionsById.get(item.id) ?? [] : [];

          return (
            <div
              key={item.id}
              className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-neutral-800">
                    {grant?.title ?? "(untitled grant)"}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {grant?.funder ?? "Unknown funder"}
                    {" · "}
                    <span className="uppercase tracking-wide text-xs">{item.status}</span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    {canonicalLead(item.owner) ? (
                      <PersonChip name={item.owner} prefix="Lead: " />
                    ) : (
                      <span title="Pick a lead in the Application Tracker (Breakdown → Lead)" className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                        No lead yet
                      </span>
                    )}
                    {step && <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STEP_STYLES[step.key]}`}>{step.label}</span>}
                  </p>
                </div>
                <button
                  onClick={() => grant?.id && checkEligibility(grant.id, item.id)}
                  disabled={isChecking || !checkLink}
                  title={!checkLink ? "No link on file — add one in the Application Tracker (Breakdown → Link) or paste the call text" : undefined}
                  className="shrink-0 rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isChecking ? "Checking…" : hasBeenChecked ? "Re-check eligibility" : "Check eligibility"}
                </button>
              </div>

              <div className="flex flex-col gap-2 text-xs text-neutral-500">
                <p className="break-all">
                  {checkLink ? (
                    <>
                      <span className="font-medium text-neutral-600">
                        {savedLink ? "Link used (yours, from the Application Tracker): " : "Link used: "}
                      </span>
                      <a
                        href={checkLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-neutral-300 hover:text-[var(--accent)]"
                      >
                        {checkLink}
                      </a>
                    </>
                  ) : (
                    "No link on file. Add one in the Application Tracker (open Breakdown → Link), or paste the call text below."
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => setPasteOpen((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                  className="self-start underline decoration-neutral-300 hover:text-[var(--accent)]"
                >
                  {showPaste ? "Hide paste box" : "Link not opening? Paste the call text instead"}
                </button>
                {showPaste && (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={pastedDraft}
                      onChange={(e) => setPasteDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      rows={6}
                      placeholder="Open the call page yourself, copy the whole text (eligibility, deadline, prize or funding, how to apply) and paste it here."
                      className="w-full rounded-md border border-neutral-300 p-2 text-sm text-neutral-800"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => grant?.id && checkEligibility(grant.id, item.id, pastedDraft)}
                        disabled={isChecking || pastedDraft.trim().length < 150}
                        className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isChecking ? "Checking…" : "Check this text"}
                      </button>
                      <span>
                        {pastedDraft.trim().length < 150
                          ? `${pastedDraft.trim().length}/150 characters needed`
                          : "Your link stays as it is; only this text is read."}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Countries of focus">
                  {grant?.eligible_countries?.length ? grant.eligible_countries.join(", ") : "—"}
                </Field>
                <Field label="Sector">
                  {grant?.focus_areas?.length ? grant.focus_areas.join(", ") : "—"}
                </Field>
                <Field label="Single / consortium">
                  {APPLICANT_TYPE_LABELS[grant?.applicant_type ?? "unclear"]}
                </Field>
                <Field label="Supporting docs">
                  {docs.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {docs.map((doc, idx) =>
                        doc.url ? (
                          <li key={idx}>
                            <a
                              href={doc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline decoration-neutral-300 hover:text-[var(--accent)]"
                            >
                              {doc.name}
                            </a>
                          </li>
                        ) : (
                          <li key={idx}>{doc.name}</li>
                        )
                      )}
                    </ul>
                  ) : grant?.rfp_url ? (
                    <a
                      href={grant.rfp_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-neutral-300 hover:text-[var(--accent)]"
                    >
                      RFP / call page link
                    </a>
                  ) : (
                    "—"
                  )}
                </Field>
              </div>

              {final && (
                <div
                  className={`rounded-md border px-3 py-2 ${
                    final.decision === "fit" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"
                  }`}
                >
                  <p className="text-sm font-medium">{final.statement}</p>
                  {final.notes && <p className="mt-1 whitespace-pre-wrap text-sm font-normal">{final.notes}</p>}
                </div>
              )}
              {grant?.eligibility_report && <VerdictPanel report={grant.eligibility_report} initial={!!final} />}

              <EligibilityReview
                item={item}
                reviews={actions.filter((a) => a.tracker_item_id === item.id && isReviewAction(a))}
                replies={replies}
                viewer={viewer}
                onActionsChange={setActions}
                onRepliesChange={setReplies}
                onItemPatch={(patch) => setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)))}
                onError={setError}
              />

              {myActions.length > 0 && (
                <div className="rounded-md border border-neutral-200 p-3">
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    {firstName(me)}&apos;s open action points · from the Application Tracker
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {myActions.map((a) => (
                      <ActionRow key={a.id} a={a} opportunity={grant?.title ?? ""} onToggle={toggleAction} viewer={viewer} />
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {(["unreviewed", "fit", "not_fit"] as FitStatus[]).map((status) => (
                    <FitPill
                      key={status}
                      status={status}
                      active={fitStatus === status}
                      onClick={() => updateFit(item.id, status)}
                    />
                  ))}
                  {item.fit_source === "auto" && (
                    <span
                      title="Set by the eligibility check. Pick Fit / Not fit yourself to override it — a re-check won't change your choice."
                      className="text-xs text-neutral-400"
                    >
                      set automatically
                    </span>
                  )}
                  {/* Only relevant when fit alone wouldn't already let this into Draft
                      Application — once something's marked Fit it gets there anyway. */}
                  {fitStatus !== "fit" &&
                    (item.draft_override ? (
                      <button
                        onClick={() => updateDraftOverride(item.id, false)}
                        title="Showing in Draft Application despite not being marked Fit — click to pull it back out"
                        className="rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200"
                      >
                        In Draft Application (override) ✕
                      </button>
                    ) : (
                      <button
                        onClick={() => updateDraftOverride(item.id, true)}
                        title="Skip the Fit requirement and let this show in Draft Application anyway"
                        className="rounded-full border border-dashed border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-500 hover:border-neutral-400 hover:text-neutral-700"
                      >
                        Draft anyway →
                      </button>
                    ))}
                </div>
                <input
                  key={`${item.id}-${shownFitNotes}`}
                  defaultValue={shownFitNotes}
                  onBlur={(e) => updateFitNotes(item.id, e.target.value)}
                  placeholder="Why (optional notes)…"
                  className="min-w-[200px] flex-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RULE_STATUS_MARK: Record<string, string> = { pass: "✓", fail: "✕", warn: "!", unclear: "?", na: "–" };

function RuleList({ title, rules, tone }: { title: string; rules: RuleResult[]; tone: string }) {
  if (rules.length === 0) return null;
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>{title}</p>
      <ul className="mt-1 flex flex-col gap-1.5">
        {rules.map((r) => (
          <li key={r.id} className="text-xs text-neutral-700">
            <span className="font-medium">
              {RULE_STATUS_MARK[r.status] ?? ""} {r.label}:
            </span>{" "}
            {r.detail}
            {r.evidence && <span className="block italic text-neutral-500">&ldquo;{r.evidence}&rdquo;</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The engine's reasoning for one opportunity: a one-line verdict, expandable
// into what blocked it, what to verify, watch-outs, and required-document
// readiness. The 0–100 score is stored on the grant but deliberately not shown.
function VerdictPanel({ report, initial = false }: { report: EligibilityReport; initial?: boolean }) {
  const docsNeedingAttention = report.docs.filter((d) => d.status === "needs_partner" || d.status === "unknown");
  return (
    <details className={`rounded-md border px-3 py-2 ${initial ? "border-neutral-200 bg-neutral-50 text-neutral-600" : VERDICT_STYLES[report.verdict]}`}>
      <summary className="cursor-pointer text-sm font-medium">
        {initial && <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">Initial check ·</span>}
        {VERDICT_LABELS[report.verdict]} — <span className="font-normal">{report.summary}</span>
      </summary>
      <div className="mt-3 flex flex-col gap-3 rounded bg-white/70 p-3 text-neutral-700">
        {report.link_note && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">About the link</p>
            <p className="mt-1 text-xs">{report.link_note}</p>
          </div>
        )}
        <RuleList title="Why not" rules={report.blocking} tone="text-red-700" />
        <RuleList title="To verify" rules={report.open_questions} tone="text-amber-700" />
        <RuleList title="Watch-outs" rules={report.warnings} tone="text-amber-700" />
        {report.manual_review.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Read manually</p>
            <ul className="mt-1 list-disc pl-4 text-xs">
              {report.manual_review.map((line, idx) => (
                <li key={idx}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        {docsNeedingAttention.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Documents needing attention</p>
            <ul className="mt-1 list-disc pl-4 text-xs">
              {docsNeedingAttention.map((d, idx) => (
                <li key={idx}>
                  {d.name} — {d.status === "needs_partner" ? "needs a third party's sign-off" : "not in BURN's document inventory, check manually"}
                </li>
              ))}
            </ul>
          </div>
        )}
        <RuleList title="Passed" rules={report.passed} tone="text-emerald-700" />
        <p className="text-xs text-neutral-400">
          Checked {new Date(report.checked_at).toLocaleDateString()} · {report.model} · {report.sources.length} source
          {report.sources.length === 1 ? "" : "s"} read
        </p>
      </div>
    </details>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-neutral-400">{label}</p>
      <div className="mt-0.5 text-neutral-700">{children}</div>
    </div>
  );
}

function FitPill({
  status,
  active,
  onClick,
}: {
  status: FitStatus;
  active: boolean;
  onClick: () => void;
}) {
  const activeColor =
    status === "fit"
      ? "bg-emerald-600 text-white"
      : status === "not_fit"
      ? "bg-red-600 text-white"
      : "bg-neutral-700 text-white";
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active ? activeColor : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      {FIT_LABELS[status]}
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
