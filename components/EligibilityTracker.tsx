"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabaseClient";
import { ApplicantType, EligibilityVerdict, FitStatus, Grant, TrackerItem } from "@/lib/types";
import type { EligibilityReport, RuleResult } from "@/lib/eligibility/types";

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

export default function EligibilityTracker() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fitFilter, setFitFilter] = useState<FitFilter>("all");
  const [checkingGrantId, setCheckingGrantId] = useState<string | null>(null);

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
    const base = { all: items.length, unreviewed: 0, fit: 0, not_fit: 0, needs_review: 0 };
    for (const item of items) {
      const status = item.fit_status ?? "unreviewed";
      base[status]++;
      if (status === "unreviewed" && item.grant?.eligibility_verdict === "needs_review") base.needs_review++;
    }
    return base;
  }, [items]);

  const filteredItems = useMemo(
    () =>
      fitFilter === "all"
        ? items
        : fitFilter === "needs_review"
        ? items.filter(
            (i) => (i.fit_status ?? "unreviewed") === "unreviewed" && i.grant?.eligibility_verdict === "needs_review"
          )
        : items.filter((i) => (i.fit_status ?? "unreviewed") === fitFilter),
    [items, fitFilter]
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

  async function checkEligibility(grantId: string) {
    setCheckingGrantId(grantId);
    setError(null);
    try {
      const res = await fetch("/api/check-eligibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Eligibility check failed.");
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
    } catch {
      setError("Could not reach the eligibility check endpoint. Is the app deployed with GEMINI_API_KEY set?");
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
      Fit: FIT_LABELS[item.fit_status ?? "unreviewed"],
      "Eligibility check": item.grant?.eligibility_verdict ? VERDICT_LABELS[item.grant.eligibility_verdict] : "",
      "Check summary": item.grant?.eligibility_report?.summary ?? "",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [
      { wch: 40 },
      { wch: 22 },
      { wch: 28 },
      { wch: 24 },
      { wch: 18 },
      { wch: 40 },
      { wch: 12 },
      { wch: 18 },
      { wch: 60 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Eligibility Tracker");
    XLSX.writeFile(workbook, `eligibility-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="text-lg font-semibold text-[var(--ink)]">Eligibility Tracker</h2>
      </section>

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

      {!loading && !error && filteredItems.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center text-neutral-500">
          <p className="mb-1 font-medium text-neutral-700">Nothing here yet</p>
          <p className="text-sm">Track an opportunity from the Grant Scanner or Application Tracker first.</p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {filteredItems.map((item) => {
          const grant = item.grant;
          const fitStatus = item.fit_status ?? "unreviewed";
          const isChecking = checkingGrantId === grant?.id;
          const hasBeenChecked = !!grant?.eligibility_checked_at;
          const docs = grant?.supporting_docs ?? [];

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
                </div>
                <button
                  onClick={() => grant?.id && checkEligibility(grant.id)}
                  disabled={isChecking || !grant?.application_url}
                  title={!grant?.application_url ? "No source link on file for this grant" : undefined}
                  className="shrink-0 rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isChecking ? "Checking…" : hasBeenChecked ? "Re-check eligibility" : "Check eligibility"}
                </button>
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

              {grant?.eligibility_report && <VerdictPanel report={grant.eligibility_report} />}

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
                  defaultValue={item.fit_notes ?? ""}
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
function VerdictPanel({ report }: { report: EligibilityReport }) {
  const docsNeedingAttention = report.docs.filter((d) => d.status === "needs_partner" || d.status === "unknown");
  return (
    <details className={`rounded-md border px-3 py-2 ${VERDICT_STYLES[report.verdict]}`}>
      <summary className="cursor-pointer text-sm font-medium">
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
