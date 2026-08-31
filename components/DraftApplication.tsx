"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { TrackerItem } from "@/lib/types";

export default function DraftApplication() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [torText, setTorText] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId]
  );

  function selectItem(item: TrackerItem) {
    setSelectedId(item.id);
    setTorText(item.tor_text ?? "");
    setCopied(false);
  }

  async function saveTor() {
    if (!selected) return;
    setSaving(true);
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ tor_text: torText, updated_at: new Date().toISOString() })
      .eq("id", selected.id);
    if (!updateError) {
      setItems((prev) =>
        prev.map((i) => (i.id === selected.id ? { ...i, tor_text: torText } : i))
      );
    }
    setSaving(false);
  }

  function buildPrompt(item: TrackerItem) {
    const g = item.grant;
    const amount = g?.amount
      ? `${g.currency ?? "USD"} ${g.amount.toLocaleString()}`
      : "Not stated";
    return [
      "Please draft a first-pass application for the funding opportunity below,",
      "following the rules in this project's instructions.",
      "",
      "## THE OPPORTUNITY",
      `Title: ${g?.title ?? "(untitled)"}`,
      `Funder: ${g?.funder ?? "Not stated"}`,
      `Amount: ${amount}`,
      `Deadline: ${g?.deadline ?? "Not stated"}`,
      `Geography: ${g?.geography ?? "Not stated"}`,
      `Focus areas: ${g?.focus_areas?.length ? g.focus_areas.join(", ") : "Not stated"}`,
      `Source: ${g?.application_url ?? "Not stated"}`,
      "",
      "### Eligibility (as published)",
      g?.eligibility ?? "Not stated - check the TOR.",
      "",
      "### Summary of the opportunity",
      g?.description ?? "Not stated.",
      "",
      "### Our internal fit assessment",
      g?.fit_analysis ?? "Not yet assessed.",
      "",
      "## THE TOR / RFP",
      torText.trim()
        ? torText.trim()
        : "[No TOR text pasted - attach the TOR/RFP document to this conversation instead.]",
      "",
      "## WHAT I NEED",
      "1. First, the requirements checklist: every required section in the funder's own order, page or word limits, mandatory annexes, eligibility conditions, submission method and deadline.",
      "2. Then the first draft, following that structure exactly, drawing on the past applications in this project's knowledge.",
      "3. Finally, list every [NEEDS INPUT] marker as a checklist of what the team must still supply.",
    ].join("\n");
  }

  async function copyPrompt() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(buildPrompt(selected));
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setError("Couldn't copy automatically — select the prompt text below and copy it manually.");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="font-serif-display text-lg text-[var(--ink)]">Draft an application</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          Pick a tracked opportunity, paste in its TOR or RFP text, then copy the generated prompt
          into your BURN Grant Applications project in Claude. Claude drafts from your past
          applications stored there — nothing confidential is kept in this app.
        </p>
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-[var(--surface)] p-10 text-center text-[var(--ink-muted)]">
          <p className="mb-1 font-medium text-[var(--ink)]">Nothing in the pipeline yet</p>
          <p className="text-sm">
            Track an opportunity from the Grant Scanner and it will appear here, ready to draft.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const open = selectedId === item.id;
          return (
            <article
              key={item.id}
              className={`rounded-lg border bg-[var(--surface)] p-5 transition-colors ${
                open ? "border-[var(--accent)]" : "border-[var(--border)]"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  {item.grant?.funder && (
                    <p className="text-xs text-[var(--ink-muted)]">{item.grant.funder}</p>
                  )}
                  <h3 className="font-serif-display text-base leading-snug text-[var(--ink)]">
                    {item.grant?.title ?? "(untitled grant)"}
                  </h3>
                  <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-[var(--ink-muted)]">
                    {item.grant?.deadline && <span>Closes {item.grant.deadline}</span>}
                    <span className="capitalize">Status: {item.status}</span>
                  </div>
                </div>
                <button
                  onClick={() => (open ? setSelectedId(null) : selectItem(item))}
                  className="shrink-0 rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)]"
                >
                  {open ? "Close" : "Draft application"}
                </button>
              </div>

              {open && (
                <div className="mt-5 space-y-4 border-t border-[var(--border)] pt-4">
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                      TOR / RFP text (optional)
                    </label>
                    <textarea
                      value={torText}
                      onChange={(e) => setTorText(e.target.value)}
                      rows={8}
                      placeholder="Paste the terms of reference or RFP text here. If it's a PDF, you can skip this and attach the file directly in Claude instead."
                      className="mt-1 w-full rounded-md border border-neutral-300 p-3 text-sm text-neutral-800"
                    />
                    <button
                      onClick={saveTor}
                      disabled={saving}
                      className="mt-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-[var(--ink-muted)] hover:border-neutral-400 disabled:opacity-50"
                    >
                      {saving ? "Saving…" : "Save TOR text"}
                    </button>
                  </div>

                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                        Prompt for Claude
                      </label>
                      <button
                        onClick={copyPrompt}
                        className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-dark)]"
                      >
                        {copied ? "Copied ✓" : "Copy prompt"}
                      </button>
                    </div>
                    <textarea
                      readOnly
                      value={buildPrompt(item)}
                      rows={12}
                      className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs text-neutral-700"
                    />
                    <p className="mt-2 text-xs text-[var(--ink-muted)]">
                      Paste this into your BURN Grant Applications project in Claude. If the TOR is a
                      PDF, attach the file to that conversation as well.
                    </p>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
