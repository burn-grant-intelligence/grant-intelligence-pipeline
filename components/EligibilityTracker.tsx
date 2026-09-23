"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabaseClient";
import { ApplicantType, FitStatus, Grant, TrackerItem } from "@/lib/types";

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

type FitFilter = FitStatus | "all";

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
    const base = { all: items.length, unreviewed: 0, fit: 0, not_fit: 0 };
    for (const item of items) {
      const status = item.fit_status ?? "unreviewed";
      base[status]++;
    }
    return base;
  }, [items]);

  const filteredItems = useMemo(
    () =>
      fitFilter === "all"
        ? items
        : items.filter((i) => (i.fit_status ?? "unreviewed") === fitFilter),
    [items, fitFilter]
  );

  async function updateFit(trackerItemId: string, fit_status: FitStatus) {
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ fit_status, updated_at: new Date().toISOString() })
      .eq("id", trackerItemId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === trackerItemId ? { ...i, fit_status } : i)));
  }

  async function updateFitNotes(trackerItemId: string, fit_notes: string) {
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ fit_notes: fit_notes || null })
      .eq("id", trackerItemId);
    if (updateError) setError(updateError.message);
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
      setItems((prev) =>
        prev.map((item) =>
          item.grant?.id === grantId ? { ...item, grant: { ...item.grant!, ...json } } : item
        )
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
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Eligibility Tracker");
    XLSX.writeFile(workbook, `eligibility-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="mb-1 text-lg font-semibold text-[var(--ink)]">Eligibility Tracker</h2>
        <p className="text-sm text-[var(--ink-muted)]">
          Check who&rsquo;s actually eligible for a tracked opportunity — countries of focus,
          sector, single applicant vs. consortium, and required documents — before anyone spends
          time drafting a proposal for it. Marking something &ldquo;Not fit&rdquo; here doesn&rsquo;t
          remove it from Draft Application, it just flags it there so nobody drafts one by
          accident.
        </p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <FilterPill active={fitFilter === "all"} onClick={() => setFitFilter("all")}>
            All ({counts.all})
          </FilterPill>
          <FilterPill active={fitFilter === "unreviewed"} onClick={() => setFitFilter("unreviewed")}>
            Unreviewed ({counts.unreviewed})
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

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3">
                <div className="flex gap-2">
                  {(["unreviewed", "fit", "not_fit"] as FitStatus[]).map((status) => (
                    <FitPill
                      key={status}
                      status={status}
                      active={fitStatus === status}
                      onClick={() => updateFit(item.id, status)}
                    />
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
