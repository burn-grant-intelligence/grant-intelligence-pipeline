// Run: npx tsx test/linkCheck.test.ts
import { assessLink, findLinkPrompt, isGroundingRedirect, looksGated, parseFoundLink, titleOverlap } from "../lib/eligibility/linkCheck";
import type { GatheredSources } from "../lib/eligibility/fetchSources";

let failed = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra}`);
};

const gs = (text: string, o: Partial<GatheredSources> = {}): GatheredSources => ({
  parts: [{ text: "--- SOURCE: call page (https://x.org/a) ---\n" + text }],
  used: ["https://x.org/a"], notes: [], rfpUrl: null, textChars: text.length, pdfCount: 0, coverageHint: "", ...o,
});
const grant = { title: "Call for Solutions: Clean Cooking Innovations", funder: "Solar Impulse Foundation" };
const long = (s: string) => (s + " ").repeat(Math.ceil(9000 / (s.length + 1)));

// nothing read
check(assessLink(null, grant).status === "unreadable", "no sources at all → unreadable");
check(assessLink(gs("", { used: [] }), grant).status === "unreadable", "empty used list → unreadable");

// a PDF was read → trusted
check(assessLink(gs("short", { pdfCount: 1 }), grant).status === "ok", "a PDF read → ok (cannot be text-matched)");

// long and relevant / long and irrelevant
check(assessLink(gs(long("Call for Solutions on clean cooking innovations: eligibility, budget and how to apply.")), grant).status === "ok", "long relevant page → ok");
check(assessLink(gs(long("Latest news from the football season, transfers, fixtures and results.")), grant).status === "mismatch", "long page about something else → mismatch");
check(assessLink(gs(long("Solar Impulse Foundation newsletter: many topics, batteries and hydrogen.")), grant).status === "ok", "long page that names the funder is given the benefit of the doubt");

// short pages
check(assessLink(gs("Please sign in to view this opportunity. Create an account to continue."), grant).status === "gated", "short login wall → gated");
check(assessLink(gs("Log in to your account. Forgot password? Register to view the call."), { title: "Unrelated Thing", funder: null }).status === "gated", "login wall wins over mismatch");
check(assessLink(gs("Fun fact of the day: cats sleep a lot. Read more about cats and dogs here."), grant).status === "mismatch", "short page about something else → mismatch");
check(assessLink(gs("Clean cooking innovations call for solutions — more details soon."), grant).status === "thin", "short relevant page → thin");
check(assessLink(gs("Clean cooking innovations call for solutions. " + "Details. ".repeat(400)), grant).status === "ok", "medium relevant page (2.5k–8k chars) → ok");

// a long page with a 'Log in' menu is NOT gated
check(!looksGated(long("Welcome. Log in | Register. Clean cooking call for solutions, full criteria below.")), "long page with a login link is not gated");
check(looksGated("Access denied"), "'Access denied' short page is gated");
check(looksGated("Please verify you are human to continue"), "captcha wall is gated");

// title overlap ignores filler words
const o = titleOverlap("Call for Proposals 2026: Clean Cooking Fund", "clean cooking is great");
check(o.total === 2 && o.matched === 2, "filler words (call, proposals, 2026, fund) are ignored", ` (${JSON.stringify(o)})`);
check(titleOverlap(null, "abc").total === 0, "no title → nothing to match");

// notes are present exactly when not ok
check(assessLink(gs("Sign in"), grant).note !== null && assessLink(gs(long("Clean cooking call for solutions")), grant).note === null, "note only when there is a problem");

// Gemini link lookup plumbing
const fl = parseFoundLink('```json\n{"url": "https://funder.org/call-2026", "reason": "Official page"}\n```');
check(fl?.url === "https://funder.org/call-2026" && fl.reason === "Official page", "parses a fenced JSON answer");
check(parseFoundLink('{"url": null, "reason": "not sure"}')?.url === null, "null url stays null");
check(parseFoundLink('{"url": "javascript:alert(1)", "reason": "x"}')?.url === null, "non-http urls are rejected");
check(parseFoundLink('{"url": "ftp://x/y"}')?.url === null, "ftp urls are rejected");
check(parseFoundLink("no json here") === null && parseFoundLink("{broken") === null, "garbage → null");
check(isGroundingRedirect("https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc") && !isGroundingRedirect("https://funder.org/a"), "grounding redirects recognised");
const pr = findLinkPrompt({ title: "T", funder: "F", application_url: "https://l.org/x" });
check(pr.includes('"T"') && pr.includes("F") && pr.includes("https://l.org/x") && pr.includes("LinkedIn"), "prompt names the grant, funder, link and social posts");

console.log(failed ? `\n${failed} FAILED` : "\nAll scenarios passed");
process.exit(failed ? 1 : 0);
