"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TrackerItem } from "@/lib/types";

// TODO: paste your BURN Grant Applications project's URL from claude.ai here
// (open the project on claude.ai and copy the address bar).
const CLAUDE_PROJECT_URL = "https://claude.ai/project/01a065f7-7c14-7799-8687-b60d821dd698";

export default function DraftApplication() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="mb-1 text-lg font-semibold text-[var(--ink)]">Draft an application</h2>
        <p className="text-sm text-[var(--ink-muted)]">
          Click "Draft application" on a tracked opportunity and it opens Claude with a first-draft
          prompt already filled in, ready to send — pulling from your BURN Grant Applications
          project and the past applications stored there. If there's a TOR or RFP document, attach
          it directly in that Claude chat once it opens.
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
              <a  
              href={buildClaudeLink(item)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]"
            >
              Draft application
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildPrompt(item: TrackerItem): string {
  const g = item.grant;
  const amount = g?.amount ? `${g.currency ?? "USD"} ${g.amount.toLocaleString()}` : "Not stated";

  return [
    "Please draft a first-pass application for the funding opportunity below,",
    "following the rules in this project's instructions.",
    "",
    "## THE OPPORTUNITY",
    `Title: ${g?.title ?? "(untitled grant)"}`,
    `Funder: ${g?.funder ?? "Not stated"}`,
    `Amount: ${amount}`,
    `Deadline: ${g?.deadline ?? "Not stated"}`,
    `Geography: ${g?.geography ?? "Not stated"}`,
    `Focus areas: ${g?.focus_areas?.length ? g.focus_areas.join(", ") : "Not stated"}`,
    `Source: ${g?.application_url ?? "Not stated"}`,
    "",
    "### Eligibility (as published)",
    g?.eligibility?.trim() || "Not specified",
    "",
    "### Summary of the opportunity",
    g?.description?.trim() || "Not provided",
    "",
    "### Our internal fit assessment",
    g?.fit_analysis?.trim() || "Not yet analyzed",
    "",
    "## THE TOR / RFP",
    item.tor_text?.trim()
      ? item.tor_text.trim()
      : "[No TOR text pasted - attach the TOR/RFP document to this conversation instead.]",
    "",
    "## WHAT I NEED",
    "1. First, the requirements checklist: every required section in the funder's own order, page or word limits, mandatory annexes, eligibility conditions, submission method and deadline.",
    "2. Then the first draft, following that structure exactly, drawing on the past applications in this project's knowledge.",
    "3. Finally, list every [NEEDS INPUT] marker as a checklist of what the team must still supply.",
  ].join("\n");
}
  function buildClaudeLink(item: TrackerItem): string {
   return `${CLAUDE_PROJECT_URL}?q=${encodeURIComponent(buildPrompt(item))}`;

 }
