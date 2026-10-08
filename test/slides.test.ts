// Run: npx tsx test/slides.test.ts
// The Grant Writing PPT (lib/slides.ts).
import {
  TBD, bulletLines, buildDeck, inDeck, initialsOf, matchPriority, mergeSlide, nextOverrides, prioritySlideDefaults, slideFor, stageLabel, trackerSlideDefaults,
} from "../lib/slides";
import type { KeyPriority, OpportunitySlideRow, TrackerItem } from "../lib/types";

let failed = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

const now = "2026-10-08T08:00:00Z";
const grant = (id: string, title: string, funder: string, over: Record<string, unknown> = {}) =>
  ({ id, title, funder, amount: 250000, currency: "USD", deadline: "2026-11-20", description: "Clean cooking for schools.", eligible_countries: ["Kenya", "Uganda"], type_of_funding: "Grant", source_note: null, project_start_date: "2027-01-01", project_end_date: null, application_url: "https://example.org/call", rfp_url: null, ...over }) as unknown as TrackerItem["grant"];
const item = (id: string, g: TrackerItem["grant"], over: Partial<TrackerItem> = {}): TrackerItem =>
  ({ id, grant_id: g?.id ?? null, grant: g, owner: "Hussein Kiarie", status: "drafting", fit_status: "fit", draft_override: false, draft_stage: "concept", removed_at: null, created_at: now, updated_at: now, ...over }) as TrackerItem;
const prio = (id: string, opportunity: string, deadline: string | null, lead: string | null, sort_order: number): KeyPriority => ({ id, opportunity, deadline, lead, sort_order, created_at: now, updated_at: now });

// ── live values ──
check(initialsOf("Hussein Kiarie") === "HK" && initialsOf("Sammy") === "SM" && initialsOf("") === "" && initialsOf("TBD") === TBD, "BURN lead as initials (HK), first names resolve to the team");
const a = item("t1", grant("g1", "Clean Cooking Schools Window", "GiveDirectly"));
const d = trackerSlideDefaults(a);
check(d.title === "GiveDirectly / Clean Cooking Schools Window", "title: funder / programme, like the team's slides: " + d.title);
check(d.organization === "GiveDirectly" && d.deadline === "20 Nov 2026" && d.start === "1 Jan 2027" && d.end === TBD, "left box: organisation, readable dates, TBD when unknown");
check(d.amount === "USD 250,000" && d.funding === "Grant" && d.lead === "HK", "amount, funding type, lead initials");
check(d.countries === "Kenya, Uganda" && d.description === "Clean cooking for schools." && d.source === "Grant Scanner" && d.link === "https://example.org/call", "right table: countries, description, source, link");
check(trackerSlideDefaults(item("t9", grant("g9", "MIT Solve Challenge", "MIT Solve"))).title === "MIT Solve Challenge", "no doubled funder when the programme already names it");
check(trackerSlideDefaults(item("t8", grant("g8", "X", "Y"), { requested_amount_usd: 90000 })).amount === "USD 90,000", "requested amount wins over the call's amount");
check(stageLabel(null) === "Application - Prospecting" && stageLabel({ status: "drafting", draft_stage: "concept" }) === "Application - Concept note" && stageLabel({ status: "drafting", draft_stage: "first_draft" }) === "Application - First draft" && stageLabel({ status: "submitted", draft_stage: "first_draft" }) === "Application - Submitted" && stageLabel({ status: "won", draft_stage: null }) === "Awarded - Implementation", "stage header follows the application");
const pd = prioritySlideDefaults(prio("p1", "Berkouwer / GiveDirectly", "TBD", "Hussein", 0));
check(pd.title === "Berkouwer / GiveDirectly" && pd.stage === "Application - Prospecting" && pd.deadline === TBD && pd.lead === "HK" && pd.source === "Key priorities", "a key priority's slide: prospecting, TBDs, lead initials");
check(prioritySlideDefaults(prio("p2", "EU call", "2026-12-01", null, 1)).deadline === "1 Dec 2026", "an ISO deadline on a priority reads as a date");

// ── typed over ──
const merged = mergeSlide(d, { amount: "EUR 9 million", junk: "x" });
check(merged.amount === "EUR 9 million" && merged.title === d.title && !("junk" in merged), "typed values win, unknown keys ignored");
let o = nextOverrides({}, d, "amount", " EUR 9 million ");
check(o.amount === "EUR 9 million", "an edit is stored trimmed");
o = nextOverrides(o, d, "amount", "USD 250,000");
check(!("amount" in o), "typing the live value back drops the override (the slide follows live data again)");
check(nextOverrides({}, d, "countries", "")["countries"] === "", "clearing a field on purpose is kept");
check(bulletLines("Chris\n• Website\n- LinkedIn\n\n") .join("|") === "Chris|Website|LinkedIn", "source lines become bullets");

// ── the deck ──
check(inDeck(a) && inDeck(item("w", grant("gw", "W", "F"), { status: "won", fit_status: "unreviewed" })), "fit opportunities and won ones are in the deck");
check(!inDeck(item("u", grant("gu", "U", "F"), { fit_status: "unreviewed" })) && inDeck(item("o", grant("go", "O", "F"), { fit_status: "unreviewed", draft_override: true })), "unreviewed stays out unless 'draft anyway'");
check(!inDeck(item("r", grant("gr", "R", "F"), { removed_at: now })) && !inDeck(item("l", grant("gl", "L", "F"), { status: "lost" })), "removed and lost are left out");

const items = [
  a,
  item("t2", grant("g2", "EU Call for Proposals Ethiopia", "European Union", { deadline: "2026-10-30" })),
  item("t3", grant("g3", "Women in Energy Award", "Energy Alliance", { deadline: "2026-12-15" }), { fit_status: "not_fit" }),
  item("t4", grant("g4", "DGBP Partnership", "Danida", { deadline: null })),
];
const priorities = [prio("p2", "EU Call for Proposals – Ethiopia", "2026-10-30", "Sammy", 1), prio("p1", "Berkouwer / GiveDirectly", "TBD", "Hussein", 0), prio("p3", "", null, null, 2)];
check(matchPriority(priorities[0], items)?.id === "t2", "a priority finds its tracked opportunity even worded differently");
check(matchPriority(priorities[1], items) === null, "an untracked priority has no match");
const rows: OpportunitySlideRow[] = [
  { id: "s1", tracker_item_id: "t2", key_priority_id: null, fields: { description: "Concept note due 20 Nov." }, hidden: false, updated_by: "Sammy Mwathi", created_at: now, updated_at: now },
  { id: "s2", tracker_item_id: "t4", key_priority_id: null, fields: {}, hidden: true, updated_by: null, created_at: now, updated_at: now },
];
const deck = buildDeck(items, priorities, rows);
check(deck.map((s) => s.key).join(",") === "priority:p1,tracker:t2,tracker:t1,tracker:t4", "order: key priorities first (their order), then the rest by deadline; not-fit left out; blank priority skipped: " + deck.map((s) => s.key).join(","));
check(deck.filter((s) => s.key === "tracker:t2").length === 1, "a priority that is also tracked appears once");
const eu = deck.find((s) => s.key === "tracker:t2")!;
check(eu.fields.description === "Concept note due 20 Nov." && eu.overridden.join() === "description" && !!eu.priority && !!eu.item, "the tracked slide carries the typed text and knows its priority");
check(deck.find((s) => s.key === "tracker:t4")!.hidden && deck.find((s) => s.key === "tracker:t4")!.fields.deadline === TBD, "a slide can be left out of the PPT; unknown deadline is TBD");
check(slideFor({ kind: "priority", id: "p2" }, items, priorities, rows)?.key === "tracker:t2", "opening a tracked priority's slide opens the tracker's slide (one slide per opportunity)");
check(slideFor({ kind: "priority", id: "p1" }, items, priorities, rows)?.key === "priority:p1", "an untracked priority has its own slide");
check(slideFor({ kind: "tracker", id: "t3" }, items, priorities, rows)?.fields.title === "Energy Alliance / Women in Energy Award", "any tracked opportunity has a slide, even outside the deck");
check(slideFor({ kind: "tracker", id: "nope" }, items, priorities, rows) === null, "unknown target → no slide");
const t2NoLead = buildDeck([item("t5", grant("g5", "Alpha Call", "Alpha"), { owner: null, grant: grant("g5", "Alpha Call", "Alpha", { deadline: null }) })], [prio("p5", "Alpha Call", "2026-11-01", "Christine", 0)], []);
check(t2NoLead[0].fields.lead === "CT" && t2NoLead[0].fields.deadline === "1 Nov 2026", "the priority's lead and deadline fill the tracker's gaps");

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
