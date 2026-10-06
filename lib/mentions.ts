// Tagging people in meeting notes, action points and replies.
//
// Type a team member's name — "Hussein will help facilitate the donor
// meeting" — or "@Hussein", and it becomes a coloured tag; Hussein then sees
// it in his desk (components/TeamInbox.tsx) when he is "Viewing as" himself.
// "@Everyone" (or "@all") tags the whole team.
//
// Names are recognised by first name, last name or full name. Without "@" the
// name must start with a capital letter ("Sammy", not "sammy"), so ordinary
// words are not tagged by accident; with "@" any case works. The text is
// stored exactly as typed, so emails and exports read normally.

import { EVERYONE, TEAM, canonicalLead } from "./pipeline";

export { EVERYONE };

// Names a team member goes by besides the first name. These are also
// suggested while typing without "@" (last names otherwise are not, so "The…"
// does not suggest Christine Theuri).
const CALLED: Record<string, string[]> = {
  "Bornventure Kinoti": ["Kinoti"],
};

// Tag colours (background, text) — one per person, red for Everyone.
const PALETTE: [string, string][] = [
  ["#dbeafe", "#1e40af"], // blue
  ["#dcfce7", "#166534"], // green
  ["#ede9fe", "#5b21b6"], // violet
  ["#fef3c7", "#92400e"], // amber
  ["#cffafe", "#155e75"], // cyan
  ["#fce7f3", "#9d174d"], // pink
];
const EVERYONE_COLOR: [string, string] = ["#fee2e2", "#b91c1c"];

export function tagColor(person: string): { background: string; color: string } {
  if (person === EVERYONE) return { background: EVERYONE_COLOR[0], color: EVERYONE_COLOR[1] };
  const i = TEAM.findIndex((t) => t.name === person);
  const [background, color] = PALETTE[(i >= 0 ? i : 0) % PALETTE.length];
  return { background, color };
}

type Alias = { alias: string; person: string };

function buildAliases(): Alias[] {
  const out: Alias[] = [];
  for (const t of TEAM) {
    const parts = t.name.split(/\s+/);
    const names = new Set([t.name, t.short, parts[0], parts[parts.length - 1], ...(CALLED[t.name] ?? [])]);
    for (const alias of names) if (alias) out.push({ alias, person: t.name });
  }
  // longest first so "Sammy Mwathi" wins over "Sammy"
  return out.sort((a, b) => b.alias.length - a.alias.length);
}
const ALIASES = buildAliases();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// @everyone / @all, or (@)name. Names must not be part of a longer word.
const MENTION_RE = new RegExp(
  `@(everyone|all)\\b|(@)?(?<![\\p{L}\\p{N}_])(${ALIASES.map((a) => escape(a.alias)).join("|")})(?![\\p{L}\\p{N}_])`,
  "giu"
);

export type Segment = { text: string; person?: string };

/** The text split into plain pieces and tags, for display. */
export function segments(text: string | null | undefined): Segment[] {
  const src = text ?? "";
  const out: Segment[] = [];
  let last = 0;
  for (const m of src.matchAll(MENTION_RE)) {
    const person = personOf(m);
    if (!person) continue;
    const start = m.index ?? 0;
    if (start > last) out.push({ text: src.slice(last, start) });
    out.push({ text: m[0], person });
    last = start + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

function personOf(m: RegExpMatchArray): string | null {
  if (m[1]) return EVERYONE;
  const at = !!m[2];
  const word = m[3];
  if (!word) return null;
  const hit = ALIASES.find((a) => a.alias.toLowerCase() === word.toLowerCase());
  if (!hit) return null;
  // Without @, only a capitalised name counts ("Sammy", "SAMMY" — not "sammy").
  if (!at && word[0] !== word[0].toUpperCase()) return null;
  return hit.person;
}

/** Everyone tagged in the text (full names, and/or "Everyone"), in order, no repeats. */
export function mentionsIn(text: string | null | undefined): string[] {
  return [...new Set(segments(text).filter((s) => s.person).map((s) => s.person as string))];
}

/** Who should be notified: tagged people (Everyone = the whole team), minus the author. */
export function recipientsFor(people: string[], author: string | null | undefined): string[] {
  const me = canonicalLead(author);
  const expanded = people.includes(EVERYONE) ? TEAM.map((t) => t.name) : people;
  return [...new Set(expanded.map((p) => canonicalLead(p) ?? p))].filter((p) => p && p !== me);
}

/** The sentence around a position — used as the notification excerpt. */
export function sentenceAround(text: string, index: number, max = 220): string {
  const before = text.slice(0, index);
  const after = text.slice(index);
  const start = Math.max(before.search(/[^.!?\n]*$/), 0);
  const endRel = after.search(/[.!?\n]/);
  const end = endRel === -1 ? text.length : index + endRel + 1;
  const s = text.slice(start, end).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** For each person tagged: the first sentence they are tagged in. */
export function excerptsByPerson(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const person = personOf(m);
    if (person && !out.has(person)) out.set(person, sentenceAround(text, m.index ?? 0));
  }
  return out;
}

export type SuggestedAction = { person: string; description: string };

/**
 * Sentences in meeting notes that tag one team member — offered as action
 * points ("Hussein will help facilitate the donor meeting" → Hussein).
 * Sentences tagging several people or Everyone are left to the writer.
 */
export function suggestActions(notes: string): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  for (const raw of notes.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.replace(/^[\s•\-*\d.)]+/, "").trim();
    if (sentence.length < 8) continue;
    const people = mentionsIn(sentence);
    if (people.length !== 1 || people[0] === EVERYONE) continue;
    if (!out.some((s) => s.description === sentence)) out.push({ person: people[0], description: sentence });
  }
  return out;
}

// ── Typing: suggestions while you type ──

export type MentionQuery = { start: number; query: string; at: boolean };

/** The name being typed just before the caret, if any. */
export function mentionQuery(textBeforeCaret: string): MentionQuery | null {
  const at = /(^|[\s(])@([\p{L}]*)$/u.exec(textBeforeCaret);
  if (at) return { start: textBeforeCaret.length - at[2].length - 1, query: at[2], at: true };
  const word = /(^|[\s(])([\p{Lu}][\p{L}]{1,})$/u.exec(textBeforeCaret);
  if (word) return { start: textBeforeCaret.length - word[2].length, query: word[2], at: false };
  return null;
}

export type MentionOption = { person: string; label: string; insert: string };

/** People (and Everyone, after "@") whose name starts with what is being typed. */
export function mentionOptions(q: MentionQuery): MentionOption[] {
  const query = q.query.toLowerCase();
  // Without "@": first names (and CALLED names) only, from 3 letters.
  if (!q.at && query.length < 3) return [];
  const namesOf = (t: (typeof TEAM)[number]) => {
    const parts = t.name.split(/\s+/);
    const called = [parts[0], t.short, ...(CALLED[t.name] ?? [])];
    return q.at ? [...called, ...parts, t.name] : called;
  };
  const opts: MentionOption[] = [];
  for (const t of TEAM) {
    const hit = query ? namesOf(t).find((n) => n.toLowerCase().startsWith(query)) : t.name.split(/\s+/)[0];
    if (!hit) continue;
    // Without "@", stop suggesting once a whole name has been typed.
    if (!q.at && namesOf(t).some((n) => n.toLowerCase() === query)) return [];
    const word = hit.includes(" ") ? hit.split(/\s+/)[0] : hit;
    opts.push({ person: t.name, label: t.name, insert: `${q.at ? "@" : ""}${word}` });
  }
  if (q.at && (!query || "everyone".startsWith(query) || "all".startsWith(query))) {
    opts.push({ person: EVERYONE, label: "Everyone — the whole team", insert: "@Everyone" });
  }
  return opts;
}

/** Text with the typed name at `q` replaced by the chosen option; returns the new text and caret. */
export function applyMention(text: string, caret: number, q: MentionQuery, opt: MentionOption): { text: string; caret: number } {
  const before = text.slice(0, q.start);
  const after = text.slice(caret).replace(/^[\p{L}]*/u, "");
  const insert = `${opt.insert}${after.startsWith(" ") ? "" : " "}`;
  // caret goes after the space that follows the name
  return { text: before + insert + after, caret: before.length + opt.insert.length + 1 };
}
