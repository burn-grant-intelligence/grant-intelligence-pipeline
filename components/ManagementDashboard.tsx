"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabaseClient";
import { FitStatus, KeyPriority, TrackerItem, TrackerStatus } from "@/lib/types";

// Quick-access buttons shown under the title — edit these two lines once the
// real files exist. "#" is a harmless placeholder until then.
const QUICK_LINKS = {
  weeklyPpt: "#",
  grantsPipeline: "#",
};

type BoardColumnKey = "tracking" | "eligibility" | "drafting" | "submitted" | "won" | "lost";

// "Eligibility Check" is tracker_items.status === "researching" shown under
// the name the team actually uses for that stage (see the Eligibility
// Tracker tab) — not a separate database value. Everything else lines up
// 1:1 with a TrackerStatus; "Won" folds in "implementation" too, since an
// implementation-stage grant was already won.
const BOARD_COLUMNS: { key: BoardColumnKey; label: string; statuses: TrackerStatus[] }[] = [
  { key: "tracking", label: "Tracking", statuses: ["tracking"] },
  { key: "eligibility", label: "Eligibility Check", statuses: ["researching"] },
  { key: "drafting", label: "Drafting", statuses: ["drafting"] },
  { key: "submitted", label: "Submitted", statuses: ["submitted"] },
  { key: "won", label: "Won", statuses: ["won", "implementation"] },
  { key: "lost", label: "Lost", statuses: ["lost"] },
];

const STATUS_LABELS: Record<TrackerStatus, string> = {
  tracking: "Tracking",
  researching: "Researching",
  drafting: "Drafting",
  submitted: "Submitted",
  won: "Won",
  implementation: "Implementation",
  lost: "Lost",
};

type SubTab = "board" | "priorities";
type OwnerFilter = "all" | "unassigned" | string;
type GrantFieldName = "project_start_date" | "project_end_date" | "type_of_funding";

function formatMoney(amount: number, currency?: string | null) {
  return `${currency ?? "USD"} ${amount.toLocaleString()}`;
}

function ownerInitials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
  return initials || "?";
}

// A small fixed palette, picked deterministically from the owner's name so
// the same person always gets the same color without maintaining a staff
// list anywhere in code — names come from whatever gets typed into the
// "Assign staff" fields below.
const OWNER_COLORS = ["#c2410c", "#8b5d7a", "#3f6b52", "#2f5773", "#a3742e", "#7c3aed", "#0f766e"];
function ownerColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return OWNER_COLORS[hash % OWNER_COLORS.length];
}

export default function ManagementDashboard() {
  const [items, setItems] = useState<TrackerItem[]>([]);
  const [priorities, setPriorities] = useState<KeyPriority[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("board");
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    loadBoard();
    loadPriorities();
  }, []);

  async function loadBoard() {
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

  async function loadPriorities() {
    const { data, error: fetchError } = await supabase
      .from("key_priorities")
      .select("*")
      .order("sort_order", { ascending: true });
    if (fetchError) setError(fetchError.message);
    setPriorities((data as KeyPriority[]) ?? []);
  }

  const owners = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => {
      if (i.owner) set.add(i.owner);
    });
    return Array.from(set).sort();
  }, [items]);

  const filteredItems = useMemo(() => {
    if (ownerFilter === "all") return items;
    if (ownerFilter === "unassigned") return items.filter((i) => !i.owner);
    return items.filter((i) => i.owner === ownerFilter);
  }, [items, ownerFilter]);

  const columns = useMemo(
    () =>
      BOARD_COLUMNS.map((col) => ({
        ...col,
        items: filteredItems.filter((i) => (col.statuses as string[]).includes(i.status)),
      })),
    [filteredItems]
  );

  const wonValue = useMemo(
    () =>
      filteredItems
        .filter((i) => i.status === "won" || i.status === "implementation")
        .reduce((sum, i) => sum + (i.grant?.amount ?? 0), 0),
    [filteredItems]
  );

  async function updateOwner(trackerItemId: string, owner: string) {
    const value = owner.trim() || null;
    const { error: updateError } = await supabase
      .from("tracker_items")
      .update({ owner: value, updated_at: new Date().toISOString() })
      .eq("id", trackerItemId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === trackerItemId ? { ...i, owner: value } : i)));
  }

  async function updateGrantField(grantId: string, field: GrantFieldName, value: string) {
    const payload = { [field]: value.trim() || null };
    const { error: updateError } = await supabase.from("grants").update(payload).eq("id", grantId);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setItems((prev) =>
      prev.map((i) => (i.grant?.id === grantId ? { ...i, grant: { ...i.grant!, ...payload } } : i))
    );
  }

  async function updatePriorityField(id: string, field: "opportunity" | "deadline" | "lead", value: string) {
    const { error: updateError } = await supabase
      .from("key_priorities")
      .update({ [field]: value, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setPriorities((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  }

  async function addPriorityRow() {
    const nextOrder = priorities.length > 0 ? Math.max(...priorities.map((p) => p.sort_order)) + 1 : 0;
    const { data, error: insertError } = await supabase
      .from("key_priorities")
      .insert({ opportunity: "New opportunity", deadline: "TBD", lead: "TBD", sort_order: nextOrder })
      .select()
      .single();
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setPriorities((prev) => [...prev, data as KeyPriority]);
  }

  async function removePriorityRow(id: string) {
    const { error: deleteError } = await supabase.from("key_priorities").delete().eq("id", id);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setPriorities((prev) => prev.filter((p) => p.id !== id));
  }

  function exportPrioritiesToExcel() {
    const rows = priorities.map((p) => ({
      Opportunity: p.opportunity,
      Deadline: p.deadline ?? "",
      Lead: p.lead ?? "",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [{ wch: 55 }, { wch: 18 }, { wch: 22 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Key priorities");
    XLSX.writeFile(workbook, `key-priorities-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <datalist id="dashboard-owner-suggestions">
        {owners.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>

      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="font-serif text-lg font-semibold text-[var(--ink)]">Management Dashboard</h2>
        </div>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          Every tracked opportunity, wherever it sits — Tracking, Eligibility Check, Drafting,
          Submitted, Won or Lost — with who on the team is driving it. &ldquo;Eligibility
          Check&rdquo; mirrors the Application Tracker&rsquo;s &ldquo;Researching&rdquo; status;
          the rest line up 1:1 with its stages.
        </p>
      </section>

      <div className="flex flex-wrap gap-2">
        <a
          href={QUICK_LINKS.weeklyPpt}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
        >
          📊 Weekly PPT
        </a>
        <a
          href={QUICK_LINKS.grantsPipeline}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
        >
          📈 Grants Pipeline
        </a>
      </div>

      <div className="flex w-fit gap-1 rounded-lg bg-neutral-100 p-1">
        <SubTabButton active={subTab === "board"} onClick={() => setSubTab("board")}>
          Board view
        </SubTabButton>
        <SubTabButton active={subTab === "priorities"} onClick={() => setSubTab("priorities")}>
          Key priorities
        </SubTabButton>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {subTab === "board" && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {columns.map((col) => (
              <div key={col.key} className="rounded-lg border border-neutral-200 bg-white p-3 text-center">
                <p
                  className={`text-2xl font-semibold ${
                    col.key === "won" ? "text-emerald-600" : "text-neutral-800"
                  }`}
                >
                  {col.items.length}
                </p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                  {col.label}
                </p>
                {col.key === "won" && wonValue > 0 && (
                  <p className="mt-0.5 text-[11px] font-semibold text-[var(--accent-dark)]">
                    {formatMoney(wonValue)}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Filter by staff
            </span>
            <FilterPill active={ownerFilter === "all"} onClick={() => setOwnerFilter("all")}>
              All staff
            </FilterPill>
            <FilterPill active={ownerFilter === "unassigned"} onClick={() => setOwnerFilter("unassigned")}>
              Unassigned
            </FilterPill>
            {owners.map((owner) => (
              <FilterPill key={owner} active={ownerFilter === owner} onClick={() => setOwnerFilter(owner)}>
                <OwnerBadge name={owner} />
                {owner}
              </FilterPill>
            ))}
          </div>

          {!loading && !error && filteredItems.length === 0 && (
            <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center text-neutral-500">
              Nothing tracked yet — track an opportunity from the Grant Scanner or Application
              Tracker first.
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {columns.map((col) => (
              <div key={col.key} className="flex flex-col gap-2 rounded-xl bg-neutral-50 p-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs font-semibold text-neutral-700">{col.label}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-neutral-500">
                    {col.items.length}
                  </span>
                </div>
                {col.items.map((item) => (
                  <BoardCard
                    key={item.id}
                    item={item}
                    onOpen={() => setSelectedId(item.id)}
                    onOwnerChange={(o) => updateOwner(item.id, o)}
                  />
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {subTab === "priorities" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--ink-muted)]">
              Editable — click any cell to update it directly.
            </p>
            <button
              onClick={exportPrioritiesToExcel}
              disabled={priorities.length === 0}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Export to Excel
            </button>
          </div>
          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="bg-[var(--accent)] px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-white">
                    Opportunity
                  </th>
                  <th className="w-40 bg-[var(--accent)] px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-white">
                    Deadline
                  </th>
                  <th className="w-52 bg-[var(--accent)] px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-white">
                    Lead
                  </th>
                  <th className="w-10 bg-[var(--accent)]" />
                </tr>
              </thead>
              <tbody>
                {priorities.map((p) => (
                  <tr key={p.id} className="border-t border-neutral-100">
                    <EditableCell value={p.opportunity} onSave={(v) => updatePriorityField(p.id, "opportunity", v)} />
                    <EditableCell
                      value={p.deadline ?? ""}
                      onSave={(v) => updatePriorityField(p.id, "deadline", v)}
                      nowrap
                    />
                    <EditableCell value={p.lead ?? ""} onSave={(v) => updatePriorityField(p.id, "lead", v)} />
                    <td className="px-2 text-center">
                      <button
                        onClick={() => removePriorityRow(p.id)}
                        title="Remove row"
                        className="text-neutral-300 hover:text-red-500"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
                {priorities.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-neutral-400">
                      No priorities yet — add one below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <button
            onClick={addPriorityRow}
            className="flex w-fit items-center gap-2 rounded-md border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 text-sm font-medium text-[var(--accent-dark)] hover:bg-orange-100"
          >
            + Add row
          </button>
        </div>
      )}

      {selected && (
        <DetailModal
          item={selected}
          onClose={() => setSelectedId(null)}
          onSaveGrantField={updateGrantField}
          onOwnerChange={(o) => updateOwner(selected.id, o)}
        />
      )}
    </div>
  );
}

function BoardCard({
  item,
  onOpen,
  onOwnerChange,
}: {
  item: TrackerItem;
  onOpen: () => void;
  onOwnerChange: (owner: string) => void;
}) {
  const grant = item.grant;
  const fitStatus = item.fit_status ?? "unreviewed";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
      <button onClick={onOpen} className="text-left">
        <p className="line-clamp-2 text-sm font-medium text-neutral-800 hover:text-[var(--accent)]">
          {grant?.title ?? "(untitled grant)"}
        </p>
      </button>
      <p className="text-xs text-neutral-500">{grant?.funder ?? "Unknown funder"}</p>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-[var(--accent-dark)]">
          {grant?.amount ? formatMoney(grant.amount, grant.currency) : "—"}
        </span>
        <span className="whitespace-nowrap text-neutral-500">
          {grant?.deadline ? `Due ${grant.deadline}` : ""}
        </span>
      </div>
      <FitBadge status={fitStatus} />
      <input
        list="dashboard-owner-suggestions"
        defaultValue={item.owner ?? ""}
        onBlur={(e) => onOwnerChange(e.target.value)}
        placeholder="Assign staff…"
        className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-700"
      />
    </div>
  );
}

function FitBadge({ status }: { status: FitStatus }) {
  if (status === "fit") {
    return (
      <span className="w-fit rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
        Fit
      </span>
    );
  }
  if (status === "not_fit") {
    return (
      <span className="w-fit rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
        Not fit
      </span>
    );
  }
  return (
    <span className="w-fit rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-600">
      Unreviewed
    </span>
  );
}

function OwnerBadge({ name }: { name: string }) {
  return (
    <span
      className="mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white"
      style={{ backgroundColor: ownerColor(name) }}
    >
      {ownerInitials(name)}
    </span>
  );
}

function DetailModal({
  item,
  onClose,
  onSaveGrantField,
  onOwnerChange,
}: {
  item: TrackerItem;
  onClose: () => void;
  onSaveGrantField: (grantId: string, field: GrantFieldName, value: string) => void;
  onOwnerChange: (owner: string) => void;
}) {
  const grant = item.grant;
  const link = grant?.application_url || grant?.rfp_url || null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/40 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-y-auto rounded-2xl bg-white p-7 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h3 className="font-serif text-xl font-semibold text-[var(--ink)]">
            {grant?.title ?? "(untitled grant)"}
          </h3>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full bg-neutral-100 p-1.5 leading-none text-neutral-500 hover:bg-neutral-200"
          >
            ✕
          </button>
        </div>
        <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-neutral-200 sm:grid-cols-[220px_1fr]">
          <div className="flex flex-col gap-3 border-b border-neutral-200 bg-neutral-50 p-4 sm:border-b-0 sm:border-r">
            <ModalField label="Organization" value={grant?.funder ?? "—"} />
            <ModalField label="Submission deadline" value={grant?.deadline ?? "TBD"} />
            <ModalEditableField
              label="Project start date"
              value={grant?.project_start_date ?? ""}
              placeholder="TBD"
              type="date"
              onSave={(v) => grant && onSaveGrantField(grant.id, "project_start_date", v)}
            />
            <ModalEditableField
              label="Project end date"
              value={grant?.project_end_date ?? ""}
              placeholder="TBD"
              type="date"
              onSave={(v) => grant && onSaveGrantField(grant.id, "project_end_date", v)}
            />
            <ModalField
              label="Amount"
              value={grant?.amount ? formatMoney(grant.amount, grant.currency) : "TBD"}
            />
            <ModalEditableField
              label="Type of funding"
              value={grant?.type_of_funding ?? ""}
              placeholder="TBD — e.g. Grant, Carbon finance"
              onSave={(v) => grant && onSaveGrantField(grant.id, "type_of_funding", v)}
            />
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                BURN lead
              </p>
              <input
                list="dashboard-owner-suggestions"
                defaultValue={item.owner ?? ""}
                onBlur={(e) => onOwnerChange(e.target.value)}
                placeholder="Unassigned"
                className="w-full rounded-md border border-neutral-200 px-2 py-1 text-sm text-neutral-800"
              />
            </div>
          </div>
          <div className="flex flex-col">
            <div className="bg-neutral-500 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white">
              Application — {STATUS_LABELS[item.status]}
            </div>
            <div className="flex-1 p-4 text-sm leading-relaxed text-neutral-700">
              {grant?.description || grant?.eligibility || "No description on file yet."}
            </div>
            <ModalRow
              label="Countries"
              value={grant?.eligible_countries?.length ? grant.eligible_countries.join(", ") : grant?.geography ?? "TBD"}
            />
            <ModalRow
              label="Product type"
              value={grant?.focus_areas?.length ? grant.focus_areas.join(", ") : "TBD"}
            />
            <ModalRow label="Source" value={grant?.source_note ?? "Grant Scanner"} />
            <ModalRow
              label="Link"
              value={
                link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-[var(--accent)] underline"
                  >
                    {link}
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="text-sm font-medium text-neutral-800">{value}</p>
    </div>
  );
}

function ModalEditableField({
  label,
  value,
  placeholder,
  type = "text",
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  type?: string;
  onSave: (value: string) => void;
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <input
        type={type}
        defaultValue={value}
        placeholder={placeholder}
        onBlur={(e) => onSave(e.target.value)}
        className="w-full rounded-md border border-transparent px-1 py-0.5 text-sm font-medium text-neutral-800 hover:border-neutral-200 focus:border-neutral-300 focus:bg-white focus:outline-none"
      />
    </div>
  );
}

function ModalRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-t border-neutral-100 px-4 py-2 text-sm">
      <span className="w-28 shrink-0 font-semibold text-neutral-500">{label}</span>
      <span className="min-w-0 text-neutral-700">{value}</span>
    </div>
  );
}

function EditableCell({
  value,
  onSave,
  nowrap,
}: {
  value: string;
  onSave: (value: string) => void;
  nowrap?: boolean;
}) {
  return (
    <td className="px-1 py-1">
      <input
        defaultValue={value}
        onBlur={(e) => onSave(e.target.value)}
        className={`w-full rounded-md border border-transparent bg-transparent px-3 py-1.5 text-neutral-800 outline-none hover:border-neutral-200 focus:border-[var(--accent)] focus:bg-white ${
          nowrap ? "whitespace-nowrap" : ""
        }`}
      />
    </td>
  );
}

function SubTabButton({
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
      className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
        active ? "bg-[var(--accent)] text-white" : "text-neutral-600 hover:text-neutral-900"
      }`}
    >
      {children}
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
      className={`flex items-center rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-[var(--accent)] text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}
