// Opportunity Pipeline — the shared lists and logic behind the Application
// Tracker's "Breakdown" panel, the Management Dashboard's "Opportunity
// pipeline" tab and its Excel export. Everything here is plain functions (no
// database, no React), so test/pipeline.test.ts covers it.
//
// To change a dropdown, edit the list here: every screen and the Excel export
// read from these.

import type { ActionItem, OpportunityNote, PipelineCategory, PipelineStatusCode, TrackerItem, TrackerStatus } from "./types";

// ── Dropdown lists ──────────────────────────────────────────────────────

export const PIPELINE_CATEGORIES: { value: PipelineCategory; label: string }[] = [
  { value: "solicited", label: "Solicited" },
  { value: "unsolicited", label: "Unsolicited" },
  { value: "partnerships", label: "Partnerships" },
  { value: "award", label: "Award" },
];

// The grants team. `short` is the first name the Management Dashboard used to
// store before full names (old rows still have it, and still match). Emails
// follow BURN's firstname.lastname@burnmfg.com pattern — correct any here.
export const TEAM: { name: string; short: string; email: string }[] = [
  { name: "Hussein Kiarie", short: "Hussein", email: "hussein.kiarie@burnmfg.com" },
  { name: "Sammy Mwathi", short: "Sammy", email: "sammy.mwathi@burnmfg.com" },
  { name: "Christine Theuri", short: "Christine", email: "christine.theuri@burnmfg.com" },
  { name: "Bornventure Kinoti", short: "Bornventure", email: "bornventure.kinoti@burnmfg.com" },
];
export const LEADS = TEAM.map((t) => t.name);

export const PIPELINE_STATUSES: { code: PipelineStatusCode; label: string; group: string }[] = [
  { code: "1a", label: "EOI drafting in progress", group: "1. Drafting" },
  { code: "1b", label: "Full proposal drafting in progress", group: "1. Drafting" },
  { code: "2a", label: "New - Considering whether to apply", group: "2. Considering" },
  { code: "2b", label: "Waiting for solicitation", group: "2. Considering" },
  { code: "2c", label: "Unsolicited - considering strategy", group: "2. Considering" },
  { code: "3a", label: "Full proposal submitted - waiting", group: "3. Submitted" },
  { code: "3b", label: "EOI submitted - waiting", group: "3. Submitted" },
  { code: "3c", label: "DD / contracting in progress", group: "3. Submitted" },
  { code: "4a", label: "Awarded", group: "4. Closed" },
  { code: "4b", label: "Rejected", group: "4. Closed" },
  { code: "4c", label: "Did not pursue", group: "4. Closed" },
];
export const STATUS_GROUPS = [...new Set(PIPELINE_STATUSES.map((s) => s.group))];

export const FUNDING_TYPES = [
  "Catalytic grant",
  "Results-based Financing (RBF)",
  "Milestone-based grant",
  "Debt facility",
  "Cash prize award",
] as const;

export const PRODUCT_TYPES = [
  "ECOA Induction Cooker (iC)",
  "ECOA Cookware",
  "ECOA Char charcoal stove",
  "ECOA Wood firewood stove",
  "ECOA Pro natural draft (wood) institutional stove",
  "ECOA ProAir forced draft (briquette) institutional stove",
  "ECOA gas cooking appliances",
] as const;

// ── Labels and look-ups ─────────────────────────────────────────────────

export const categoryLabel = (v: string | null | undefined) => PIPELINE_CATEGORIES.find((c) => c.value === v)?.label ?? "";
export const statusLabel = (code: string | null | undefined) => {
  const s = PIPELINE_STATUSES.find((x) => x.code === code);
  return s ? `${s.code}. ${s.label}` : "";
};

// Matches full names and the older first-name-only values, case-insensitive.
export function canonicalLead(owner: string | null | undefined): string | null {
  const v = (owner ?? "").trim();
  if (!v) return null;
  const hit = TEAM.find((t) => t.name.toLowerCase() === v.toLowerCase() || t.short.toLowerCase() === v.toLowerCase());
  return hit ? hit.name : v;
}
export const emailOf = (name: string | null | undefined) => TEAM.find((t) => t.name === canonicalLead(name))?.email ?? null;
export const firstName = (name: string | null | undefined) => (canonicalLead(name) ?? "").split(" ")[0];

// Picking a pipeline Status moves the card on the Management Dashboard board
// to match, so the two never disagree. "Implementation" is kept when the
// status is "Awarded" (it is the stage after winning).
const BOARD_STATUS: Record<PipelineStatusCode, TrackerStatus> = {
  "1a": "drafting", "1b": "drafting",
  "2a": "tracking", "2b": "tracking", "2c": "tracking",
  "3a": "submitted", "3b": "submitted", "3c": "submitted",
  "4a": "won", "4b": "lost", "4c": "lost",
};
export function trackerStatusFor(code: PipelineStatusCode, current: TrackerStatus): TrackerStatus {
  const next = BOARD_STATUS[code];
  return next === "won" && current === "implementation" ? "implementation" : next;
}

// ── Values shown on screen and in Excel ─────────────────────────────────
// A typed value always wins; otherwise what the grant record already holds.

export function money(n: number | null | undefined, currency = "USD"): string {
  return typeof n === "number" && isFinite(n) ? `${currency} ${Math.round(n).toLocaleString("en-US")}` : "";
}

export function effectiveFields(item: TrackerItem) {
  const g = item.grant;
  return {
    programName: item.program_name || g?.title || "",
    funder: item.pipeline_funder || g?.funder || "",
    description: item.pipeline_description || g?.description || "",
    fundingType: g?.type_of_funding || "",
    countries: item.target_countries?.length ? item.target_countries : g?.eligible_countries?.length ? g.eligible_countries : [],
    ticketSize: item.ticket_size || (g?.amount ? money(g.amount, g.currency ?? "USD") : ""),
    deadline: item.pipeline_deadline || g?.deadline || "",
    link: item.pipeline_link || g?.rfp_url || g?.application_url || "",
    lead: canonicalLead(item.owner) ?? "",
  };
}

// "2026-09-23" -> "23 Sep 2026"
export function fmtDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return iso ?? "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export const todayIso = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

// How urgent an action point is, for colouring and the "My action points" badge.
export type DueState = "done" | "overdue" | "today" | "soon" | "later" | "none";
export function dueState(a: Pick<ActionItem, "done" | "due_date">, today = todayIso()): DueState {
  if (a.done) return "done";
  if (!a.due_date) return "none";
  if (a.due_date < today) return "overdue";
  if (a.due_date === today) return "today";
  const days = (Date.parse(a.due_date) - Date.parse(today)) / 86_400_000;
  return days <= 3 ? "soon" : "later";
}

// Open action points for one person, most urgent first.
export function myOpenActions(actions: ActionItem[], person: string | null, today = todayIso()): ActionItem[] {
  if (!person) return [];
  const me = canonicalLead(person);
  const rank: Record<DueState, number> = { overdue: 0, today: 1, soon: 2, later: 3, none: 4, done: 5 };
  return actions
    .filter((a) => !a.done && canonicalLead(a.assignee) === me)
    .sort((a, b) => rank[dueState(a, today)] - rank[dueState(b, today)] || (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
}

// "Meeting with Jane (Acme Fund): agree budget (Sammy, due 3 Oct 2026)"
export function actionLine(a: ActionItem): string {
  const head = a.kind === "meeting" ? `Meeting${a.meeting_with ? ` with ${a.meeting_with}` : ""}: ` : "";
  const tail = [a.assignee ? firstName(a.assignee) : "", a.due_date ? `due ${fmtDate(a.due_date)}` : ""].filter(Boolean).join(", ");
  return `${head}${a.description}${tail ? ` (${tail})` : ""}`;
}

// ── Email (opens the person's own mail app, e.g. Outlook) ───────────────

const MAILTO_MAX = 1800; // long mailto links get cut off by some mail apps

export function notesEmailLink(opts: {
  opportunity: string;
  note: Pick<OpportunityNote, "meeting_date" | "notes" | "author">;
  actions: ActionItem[];
  extraTo?: string[];
}): string {
  const to = [...new Set([...opts.actions.map((a) => emailOf(a.assignee)), ...(opts.extraTo ?? [])].filter(Boolean) as string[])];
  const subject = `Meeting notes – ${opts.opportunity} – ${fmtDate(opts.note.meeting_date)}`;
  const actionText = opts.actions.length ? opts.actions.map((a) => `- ${actionLine(a)}`).join("\n") : "- None recorded";
  let body = `Meeting on ${fmtDate(opts.note.meeting_date)}${opts.note.author ? ` (notes by ${opts.note.author})` : ""}\n\nNOTES\n${opts.note.notes}\n\nACTION POINTS\n${actionText}\n\n— Sent from Grant Intelligence`;
  const build = (b: string) => `mailto:${to.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
  if (build(body).length > MAILTO_MAX) {
    const suffix = "\n\n[Notes shortened for email — see the full notes in Grant Intelligence.]";
    while (body.length > 50 && build(body + suffix).length > MAILTO_MAX) body = body.slice(0, Math.floor(body.length * 0.9));
    body += suffix;
  }
  return build(body);
}

// ── Calendar invite (.ics) so Outlook reminds you of a meeting ──────────

const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

export function meetingIcs(opts: { uid: string; title: string; description: string; date: string; attendees?: string[]; now?: Date }): string {
  const d = opts.date.replace(/-/g, "");
  const next = new Date(`${opts.date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = next.toISOString().slice(0, 10).replace(/-/g, "");
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BURN//Grant Intelligence//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${opts.uid}@grant-intelligence`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${d}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    `DESCRIPTION:${icsEscape(opts.description)}`,
    ...(opts.attendees ?? []).map((e) => `ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${e}`),
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(opts.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

// ── Excel export: one row per opportunity, in the agreed column order ──

export const PIPELINE_COLUMNS: { header: string; width: number }[] = [
  { header: "Category", width: 14 },
  { header: "Lead", width: 20 },
  { header: "Status", width: 34 },
  { header: "Program name", width: 40 },
  { header: "Funder", width: 28 },
  { header: "Description", width: 60 },
  { header: "Type of funding", width: 26 },
  { header: "Target country/ies", width: 30 },
  { header: "Product type", width: 40 },
  { header: "Ticket size", width: 20 },
  { header: "Requested amount (USD)", width: 18 },
  { header: "Deadline", width: 14 },
  { header: "Link", width: 40 },
  { header: "Submission date", width: 14 },
  { header: "Notes", width: 70 },
  { header: "Open action points", width: 50 },
];

export function pipelineRow(item: TrackerItem, notes: OpportunityNote[], actions: ActionItem[]): Record<string, string | number> {
  const e = effectiveFields(item);
  const myNotes = notes
    .filter((n) => n.tracker_item_id === item.id)
    .sort((a, b) => b.meeting_date.localeCompare(a.meeting_date))
    .map((n) => `${fmtDate(n.meeting_date)}: ${n.notes.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const open = actions.filter((a) => a.tracker_item_id === item.id && !a.done).map(actionLine).join("\n");
  return {
    Category: categoryLabel(item.pipeline_category),
    Lead: e.lead,
    Status: statusLabel(item.pipeline_status),
    "Program name": e.programName,
    Funder: e.funder,
    Description: e.description,
    "Type of funding": e.fundingType,
    "Target country/ies": e.countries.join(", "),
    "Product type": (item.product_types ?? []).join("; "),
    "Ticket size": e.ticketSize,
    "Requested amount (USD)": typeof item.requested_amount_usd === "number" ? item.requested_amount_usd : "",
    Deadline: fmtDate(e.deadline),
    Link: e.link,
    "Submission date": fmtDate(item.submission_date),
    Notes: myNotes,
    "Open action points": open,
  };
}

// Pipeline order: by status group (drafting first), then nearest deadline.
export function sortForPipeline(items: TrackerItem[]): TrackerItem[] {
  const order = (i: TrackerItem) => (i.pipeline_status ? PIPELINE_STATUSES.findIndex((s) => s.code === i.pipeline_status) : 99);
  return [...items].sort((a, b) => order(a) - order(b) || (effectiveFields(a).deadline || "9999").localeCompare(effectiveFields(b).deadline || "9999"));
}
