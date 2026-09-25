"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TrackerItem } from "@/lib/types";

// Your BURN Grant Applications project on claude.ai.
const CLAUDE_PROJECT_URL = "https://claude.ai/project/019f120f-e2b8-7021-9988-715495c38989";

// BURN's headline track record, quoted verbatim in every drafting prompt.
// These mirror the BURN_PROFILE block in scripts/scan.mjs,
// scripts/social_discover.py and scripts/gemini_discover.py — deliberately
// duplicated, same as those three do between themselves. If BURN's numbers
// are updated, update them in all four places.
const BURN_KEY_METRICS =
  "7.4M+ clean cookstoves sold, 37.5M+ lives impacted, 56.7K+ jobs created since 2013, 81M+ tonnes of CO2 reduced, 5M+ carbon credits issued";

export default function DraftApplication() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    // Only opportunities the Eligibility Tracker has marked "Fit" progress
    // here by default — everything else (unreviewed or "Not fit") stays out
    // until someone reviews it there, or forces it in with the "Draft
    // anyway" override (see EligibilityTracker.tsx's updateDraftOverride).
    // This is a gate on fit_status/draft_override alone: it deliberately
    // does NOT also flip an item's tracker `status` — that stays a fully
    // separate, manually-set field in the Application Tracker, per the
    // 2026-09-25 design decision to keep pipeline-stage and
    // eligibility-judgment independent.
    const { data, error: fetchError } = await supabase
      .from("tracker_items")
      .select("*, grant:grants(*)")
      .in("status", ["tracking", "researching", "drafting"])
      .or("fit_status.eq.fit,draft_override.eq.true")
      .order("updated_at", { ascending: false });
    if (fetchError) setError(fetchError.message);
    setItems((data as unknown as TrackerItem[]) ?? []);
    setLoading(false);
  }

  async function handleDraftClick(item: TrackerItem) {
    const prompt = buildPrompt(item);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId((current) => (current === item.id ? null : current)), 2500);
    } catch {
      // Clipboard access can fail in some browser contexts — still open the project either way.
    }
    window.open(CLAUDE_PROJECT_URL, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="mb-1 text-lg font-semibold text-[var(--ink)]">Draft an application</h2>
        <p className="text-sm text-[var(--ink-muted)]">
          Click "Draft application" on a tracked opportunity — it copies a ready-made prompt to
          your clipboard and opens your BURN Grant Applications project in a new tab. Just paste
          (Ctrl/Cmd+V) into the message box and hit send. If there's a TOR or RFP document, attach
          it directly in that Claude chat too.
        </p>
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-10 text-center text-[var(--ink-muted)]">
          Nothing to draft yet — track an opportunity from the Grant Scanner, then mark it
          &ldquo;Fit&rdquo; in the Eligibility Tracker (or use its &ldquo;Draft anyway&rdquo;
          override to bring in an unreviewed one).
        </div>
      )}

      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div>
              {item.grant?.funder && (
                <p className="text-xs text-[var(--ink-muted)]">{item.grant.funder}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-[var(--ink)]">
                  {item.grant?.title ?? "(untitled grant)"}
                </p>
                {/* Every item here is fit_status === "fit" OR draft_override === true (see
                    loadData's query) — so anything that isn't actually "fit" only got here via
                    the manual override, and should say so plainly rather than looking like a
                    normal fit-approved item. */}
                {item.fit_status !== "fit" && (
                  <span
                    title={
                      item.fit_status === "not_fit"
                        ? "Marked Not Fit in the Eligibility Tracker — shown here only via manual override"
                        : "Not yet reviewed in the Eligibility Tracker — shown here only via manual override"
                    }
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      item.fit_status === "not_fit"
                        ? "bg-red-100 text-red-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {item.fit_status === "not_fit" ? "⚠ Not fit (override)" : "⚠ Unreviewed (override)"}
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--ink-muted)]">Status: {item.status}</p>
            </div>
            <button
              onClick={() => handleDraftClick(item)}
              className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            >
              {copiedId === item.id ? "Copied ✓ — opening Claude…" : "Draft application"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// The funder's own domain, so the prompt can tell Claude where to go and
// re-check the call's current stage. Deadlines and stages drift (rolling
// calls, EoI windows), and whatever the scanner captured may be weeks old by
// the time anyone drafts against it.
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Gemini's google_search grounding tool (used by scripts/gemini_discover.py's
// discovery step) often hands back a citation redirect on this domain
// instead of the funder's actual page — e.g.
// "https://vertexaisearch.cloud.google.com/grounding-api-redirect/...". It's
// not the donor's site, and telling Claude to "check vertexaisearch.cloud.google.com
// for the current stage" (a real thing this prompt used to say) is useless —
// that's Google's redirect infrastructure, not a funder. Detect it so the
// prompt gives Claude a real instruction (search for the actual page) instead.
function isGeminiGroundingRedirect(url: string | null | undefined): boolean {
  return !!url && url.includes("vertexaisearch.cloud.google.com");
}

function buildPrompt(item: TrackerItem): string {
  const g = item.grant;
  const title = g?.title ?? "(untitled grant)";
  const funder = g?.funder ?? "an unnamed funder";
  const amount = g?.amount ? `${g.currency ?? "USD"} ${g.amount.toLocaleString()}` : "Not stated";
  const deadline = g?.deadline ?? "Not stated";
  const applicationUrl = g?.application_url ?? null;
  const host = hostOf(applicationUrl);
  const isRedirect = isGeminiGroundingRedirect(applicationUrl);

  const sourcingInstruction = isRedirect
    ? `The source link below (${applicationUrl}) is a Google search-grounding redirect, not the funder's own page, so don't rely on it directly — search the web for "${title}" by "${funder}" to find the actual, current call page on the funder's own domain, and use that as your real source.`
    : host
    ? `Before drafting, fetch and read the actual call page at ${host} (the source link below) — this may have moved on since it was captured, so confirm the current stage and requirements directly from it rather than relying only on the summary below.`
    : `No usable source URL was captured for this opportunity — before drafting, search the web for "${title}" by "${funder}" to find the actual, current call page.`;

  const opening =
    `Draft a compelling high-level one-pager concept note for a grant application for ` +
    `BURN Manufacturing applying to "${title}" by ${funder}. ` +
    `Grant value: ${amount}. Deadline: ${deadline}. ` +
    sourcingInstruction;

  return [
    opening,
    "",
    "Once you've found the funder's own call page, look for and open any application materials it links to — guidelines, an application form or template, and especially the Terms of Reference (ToR) / Request for Proposals (RFP). Base the concept note on what those documents actually require, not just the scanner's summary below, which can be incomplete or stale.",
    "",
    "Include:",
    "1) Executive summary",
    "2) Problem statement",
    "3) BURN solution and impact",
    `4) Key metrics (${BURN_KEY_METRICS})`,
    "5) Budget outline",
    "6) Why BURN is uniquely qualified",
    "7) Terms of Reference (ToR), as published by the funder — reproduce its actual requirements/structure if you can access the document. If you cannot access it (paywalled, requires login, a broken link, or you cannot confirm you found the correct page), say so plainly here and give the direct link(s) you found instead of guessing at what it requires.",
    "",
    "Follow the rules in this project's instructions, and draw on the past applications in its knowledge. Mark anything you cannot source with [NEEDS INPUT], and list those markers as a checklist at the end.",
    "",
    "--- SUPPORTING CONTEXT (captured by the Grant Intelligence scanner — verify against the funder's own page above; this may be incomplete or stale) ---",
    `Geography: ${g?.geography ?? "Not stated"}`,
    `Focus areas: ${g?.focus_areas?.length ? g.focus_areas.join(", ") : "Not stated"}`,
    `Source: ${applicationUrl ?? "Not stated"}` +
      (isRedirect ? " (a Google search-grounding redirect, not the funder's own page — see instructions above)" : ""),
    "",
    "Eligibility (as published):",
    g?.eligibility?.trim() || "Not specified",
    "",
    "Summary of the opportunity:",
    g?.description?.trim() || "Not provided",
    "",
    "Our internal fit assessment:",
    g?.fit_analysis?.trim() || "Not yet analyzed",
    "",
    "TOR / RFP:",
    item.tor_text?.trim()
      ? item.tor_text.trim()
      : "[No TOR text pasted - attach the TOR/RFP document to this conversation instead, or find and read it per the instructions above.]",
  ].join("\n");
}
