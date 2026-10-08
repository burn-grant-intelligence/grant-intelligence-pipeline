"use client";

// Management Dashboard → "Opportunity pipeline" tab: every tracked
// opportunity with the Breakdown fields filled in from the Application
// Tracker, plus its meeting notes and open action points. Read-only here
// (edit in the Application Tracker's Breakdown), with filters and an
// "Export to Excel" that produces the same columns (lib/pipeline.ts).
// Clicking a row opens the opportunity's slide (the same one as in the Grant
// Writing PPT, editable), with its meeting notes and action points under it.

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabaseClient";
import {
  LEADS, PIPELINE_CATEGORIES, PIPELINE_COLUMNS, PIPELINE_STATUSES, STATUS_GROUPS,
  actionLine, categoryLabel, dueState, effectiveFields, fmtDate, money, pipelineRow, sortForPipeline, statusLabel,
} from "@/lib/pipeline";
import type { ActionItem, KeyPriority, OpportunityNote, TrackerItem } from "@/lib/types";
import { slideFor } from "@/lib/slides";
import { SlidePopup, type useSlideRows } from "@/components/Slides";

const GROUP_STYLES: Record<string, string> = {
  "1. Drafting": "bg-blue-100 text-blue-700",
  "2. Considering": "bg-neutral-100 text-neutral-700",
  "3. Submitted": "bg-amber-100 text-amber-800",
  "4. Closed": "bg-emerald-100 text-emerald-700",
};

export default function OpportunityPipeline({
  items,
  priorities,
  slideApi,
}: {
  items: TrackerItem[];
  priorities: KeyPriority[];
  slideApi: ReturnType<typeof useSlideRows>;
}) {
  const [notes, setNotes] = useState<OpportunityNote[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState("all");
  const [lead, setLead] = useState("all");
  const [group, setGroup] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from("opportunity_notes").select("*"),
      supabase.from("action_items").select("*"),
    ]).then(([n, a]) => {
      if (cancelled) return;
      if (n.error || a.error)
        setNotice("Notes and action points will appear here once supabase/opportunity_pipeline_migration_2026-10-01.sql has been run.");
      setNotes((n.data as OpportunityNote[]) ?? []);
      setActions((a.data as ActionItem[]) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortForPipeline(items).filter((i) => {
      const e = effectiveFields(i);
      if (category !== "all" && (i.pipeline_category ?? "") !== category) return false;
      if (lead === "unassigned" ? !!e.lead : lead !== "all" && e.lead !== lead) return false;
      const g = PIPELINE_STATUSES.find((s) => s.code === i.pipeline_status)?.group ?? "none";
      if (group !== "all" && g !== group) return false;
      if (q && !`${e.programName} ${e.funder} ${e.countries.join(" ")}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, category, lead, group, query]);

  const totals = useMemo(() => {
    const requested = rows.reduce((sum, i) => sum + (i.requested_amount_usd ?? 0), 0);
    const awarded = rows.filter((i) => i.pipeline_status === "4a").reduce((sum, i) => sum + (i.requested_amount_usd ?? 0), 0);
    return { requested, awarded };
  }, [rows]);

  function exportToExcel() {
    const data = rows.map((i) => pipelineRow(i, notes, actions));
    const worksheet = XLSX.utils.json_to_sheet(data, { header: PIPELINE_COLUMNS.map((c) => c.header) });
    worksheet["!cols"] = PIPELINE_COLUMNS.map((c) => ({ wch: c.width }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Opportunity pipeline");
    XLSX.writeFile(workbook, `opportunity-pipeline-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const openItem = openId ? items.find((i) => i.id === openId) ?? null : null;
  const openSlide = openItem ? slideFor({ kind: "tracker", id: openItem.id }, items, priorities, slideApi.rows) : null;

  const select = "rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-700";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={select}>
            <option value="all">All categories</option>
            {PIPELINE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select value={lead} onChange={(e) => setLead(e.target.value)} className={select}>
            <option value="all">All leads</option>
            <option value="unassigned">Unassigned</option>
            {LEADS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <select value={group} onChange={(e) => setGroup(e.target.value)} className={select}>
            <option value="all">All statuses</option>
            {STATUS_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
            <option value="none">No status yet</option>
          </select>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search programme, funder, country…" className={`${select} w-64`} />
        </div>
        <button
          onClick={exportToExcel}
          disabled={rows.length === 0}
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export to Excel
        </button>
      </div>

      <p className="text-sm text-white">
        {rows.length} opportunit{rows.length === 1 ? "y" : "ies"}
        {totals.requested > 0 && ` · ${money(totals.requested)} requested`}
        {totals.awarded > 0 && ` · ${money(totals.awarded)} awarded`}
        {" · "}Edit details in the Application Tracker → Breakdown. Click a row to open its slide, with its notes and action points.
      </p>
      {notice && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{notice}</div>}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full min-w-[1400px] text-sm">
          <thead>
            <tr>
              {["Category", "Lead", "Status", "Program / funder", "Type of funding", "Target country/ies", "Product type", "Ticket size", "Requested (USD)", "Deadline", "Submitted", "Link", "ClickUp", "Actions"].map((h) => (
                <th key={h} className="whitespace-nowrap bg-[var(--accent)] px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-white">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const e = effectiveFields(i);
              const st = PIPELINE_STATUSES.find((s) => s.code === i.pipeline_status);
              const open = actions.filter((a) => a.tracker_item_id === i.id && !a.done);
              const overdue = open.filter((a) => dueState(a) === "overdue").length;
              const isOpen = openId === i.id;
              return (
                <tr key={i.id} onClick={() => setOpenId(i.id)} className={`cursor-pointer border-t border-neutral-100 align-top hover:bg-neutral-50 ${isOpen ? "bg-orange-50/50" : ""}`}>
                  <td className="whitespace-nowrap px-3 py-2">{categoryLabel(i.pipeline_category) || <Dash />}</td>
                  <td className="whitespace-nowrap px-3 py-2">{e.lead || <Dash />}</td>
                  <td className="min-w-[200px] px-3 py-2">
                    {st ? <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${GROUP_STYLES[st.group]}`}>{statusLabel(st.code)}</span> : <Dash />}
                  </td>
                  <td className="min-w-[240px] px-3 py-2">
                    <p className="font-medium text-neutral-800">
                      {e.programName || "(untitled)"} <span className="ml-1 rounded border border-neutral-200 px-1 text-[10px] font-semibold text-neutral-500">🖼 Slide</span>
                    </p>
                    <p className="text-xs text-neutral-500">{e.funder}</p>
                  </td>
                  <td className="px-3 py-2">{e.fundingType || <Dash />}</td>
                  <td className="px-3 py-2">{e.countries.join(", ") || <Dash />}</td>
                  <td className="min-w-[180px] px-3 py-2 text-xs">{i.product_types?.length ? i.product_types.join("; ") : <Dash />}</td>
                  <td className="px-3 py-2">{e.ticketSize || <Dash />}</td>
                  <td className="whitespace-nowrap px-3 py-2">{typeof i.requested_amount_usd === "number" ? money(i.requested_amount_usd) : <Dash />}</td>
                  <td className="whitespace-nowrap px-3 py-2">{e.deadline ? fmtDate(e.deadline) : <Dash />}</td>
                  <td className="whitespace-nowrap px-3 py-2">{i.submission_date ? fmtDate(i.submission_date) : <Dash />}</td>
                  <td className="px-3 py-2">
                    {e.link ? (
                      <a href={e.link} target="_blank" rel="noopener noreferrer" onClick={(ev) => ev.stopPropagation()} className="text-[var(--accent)] underline">
                        Open{i.link_check_note?.startsWith("Link checked") ? " ✓" : ""}
                      </a>
                    ) : <Dash />}
                  </td>
                  <td className="px-3 py-2">
                    {i.clickup_url ? (
                      <a href={i.clickup_url} target="_blank" rel="noopener noreferrer" onClick={(ev) => ev.stopPropagation()} className="text-[var(--accent)] underline">
                        ClickUp ↗
                      </a>
                    ) : <Dash />}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {open.length ? (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${overdue ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
                        {open.length} open{overdue ? ` · ${overdue} overdue` : ""}
                      </span>
                    ) : <Dash />}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-4 py-8 text-center text-neutral-400">
                  Nothing matches these filters. Opportunities appear here once they are tracked; fill in their Breakdown in the Application Tracker.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {openItem && openSlide && (
        <SlidePopup
          slide={openSlide}
          notice={slideApi.notice}
          onSave={(f, v) => slideApi.saveField(openSlide, f, v)}
          onReset={() => slideApi.resetSlide(openSlide)}
          onHide={(h) => slideApi.setHidden(openSlide, h)}
          onClose={() => setOpenId(null)}
          extra={<PipelineDetails item={openItem} notes={notes} actions={actions} />}
        />
      )}
    </div>
  );
}

function PipelineDetails({ item, notes, actions }: { item: TrackerItem; notes: OpportunityNote[]; actions: ActionItem[] }) {
  const itemNotes = notes.filter((n) => n.tracker_item_id === item.id).sort((a, b) => b.meeting_date.localeCompare(a.meeting_date));
  const open = actions.filter((a) => a.tracker_item_id === item.id && !a.done);
  return (
    <div className="grid gap-4 rounded-xl bg-white p-4 lg:grid-cols-2">
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Meeting notes</p>
        {itemNotes.length ? (
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm text-neutral-700">
            {itemNotes.map((n) => (
              <li key={n.id}>
                <span className="font-semibold">{fmtDate(n.meeting_date)}</span>
                {n.author && <span className="text-xs text-neutral-400"> · {n.author}</span>}
                <p className="whitespace-pre-wrap">{n.notes}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-400">None yet.</p>
        )}
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Open action points</p>
        {open.length ? (
          <ul className="flex flex-col gap-1 text-sm text-neutral-700">
            {open.map((a) => (
              <li key={a.id} className={dueState(a) === "overdue" ? "text-red-700" : ""}>
                • {actionLine(a)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-400">None.</p>
        )}
      </div>
    </div>
  );
}

function Dash() {
  return <span className="text-neutral-300">—</span>;
}
