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
    const { data, error: fetchError } = await supabase
      .from("tracker_items")
      .select("*, grant:grants(*)")
      .in("status", ["tracking", "researching", "drafting"])
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
          Nothing to draft yet — track an opportunity from the Grant Scanner first.
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
              <p className="font-medium text-[var(--ink)]">
                {item.grant?.title ?? "(untitled grant)"}
              </p>
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

function buildPrompt(item: TrackerItem): string {
  const g = item.grant;
  const title = g?.title ?? "(untitled grant)";
  const funder = g?.funder ?? "an unnamed funder";
  const amount = g?.amount ? `${g.currency ?? "USD"} ${g.amount.toLocaleString()}` : "Not stated";
  const deadline = g?.deadline ?? "Not stated";
  const host = hostOf(g?.application_url);

  const opening =
    `Draft a compelling high-level one-pager concept note for a grant application for ` +
    `BURN Manufacturing applying to "${title}" by ${funder}. ` +
    `Grant value: ${amount}. Deadline: ${deadline}.` +
    (host ? ` Check ${host} for the current stage before drafting — this may have moved on since it was captured.` : "");

  return [
    opening,
    "",
    "Include:",
    "1) Executive summary",
    "2) Problem statement",
    "3) BURN solution and impact",
    `4) Key metrics (${BURN_KEY_METRICS})`,
    "5) Budget outline",
    "6) Why BURN is uniquely qualified",
    "",
    "Follow the rules in this project's instructions, and draw on the past applications in its knowledge. Mark anything you cannot source with [NEEDS INPUT], and list those markers as a checklist at the end.",
    "",
    "--- SUPPORTING CONTEXT (captured by the Grant Intelligence scanner) ---",
    `Geography: ${g?.geography ?? "Not stated"}`,
    `Focus areas: ${g?.focus_areas?.length ? g.focus_areas.join(", ") : "Not stated"}`,
    `Source: ${g?.application_url ?? "Not stated"}`,
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
      : "[No TOR text pasted - attach the TOR/RFP document to this conversation instead.]",
  ].join("\n");
}
