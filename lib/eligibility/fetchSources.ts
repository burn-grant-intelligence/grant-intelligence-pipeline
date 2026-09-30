// Gathers the text/PDFs Gemini needs to read: the call page itself plus the
// most RFP-like links on it (guidelines, ToR, application form, annexes, FAQ).
//
// Merged from the grants project's fetchSources.ts, with these changes:
//  - SSRF hardening. The URLs come from scraped data, so every request (and
//    every redirect hop) is checked: http/https only, no credentials, default
//    ports only, and the hostname must not be — or resolve to — a private,
//    loopback, link-local or otherwise internal address.
//  - One shared time budget, and linked documents are fetched in parallel
//    (the original was sequential, up to ~100s worst case; the API route has 60s).
//  - Size caps are enforced while reading, not after the whole body is loaded.
//  - Results are merged in a fixed order, so the prompt is the same run to run.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GatheredSources {
  parts: Part[];
  used: string[]; // URLs actually read
  notes: string[]; // things that went wrong / were skipped
  rfpUrl: string | null; // best guess at the primary RFP document
  textChars: number;
  pdfCount: number;
  coverageHint: string;
}

const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_TOTAL = 17 * 1024 * 1024; // Gemini request cap is ~20MB
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_PER_PAGE = 60_000;
const MAX_FOLLOWED_LINKS = 4;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 12_000;
const TOTAL_BUDGET_MS = 20_000;
const UA = "Mozilla/5.0 (compatible; GrantEligibilityBot/1.0)";

const LINK_HINTS =
  /(rfp|call[- _]for[- _](proposals?|applications?)|cfp|guideline|guidance|terms[- _]of[- _]reference|\btor\b|application[- _]form|annex|eligibility|criteria|faq|prospectus|concept[- _]note|instructions|apply|download|\.pdf)/i;
const LINK_ANTI = /(privacy|cookie|login|sign-?in|facebook|twitter|linkedin|instagram|youtube|mailto:|tel:|javascript:|#$)/i;

// ───────────────────────── URL safety ─────────────────────────

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(v) === 4) {
    const [a, b, c] = v.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(v) === 6) {
    if (v === "::" || v === "::1") return true;
    // IPv4-mapped addresses. new URL() rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1,
    // so both the dotted and the hex spelling have to be understood.
    const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("2001:db8");
  }
  return false;
}

// Synchronous checks only (no DNS). `allowPrivate` exists for the local test
// server in test/fetchSources.test.ts — the API route never sets it.
export function isSafeUrl(raw: string, allowPrivate = false): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.username || u.password) return false;
    if (u.port && u.port !== "80" && u.port !== "443" && !allowPrivate) return false;
    if (allowPrivate) return true;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localdomain")) return false;
    if (isIP(h) && isPrivateIp(h)) return false;
    return true;
  } catch {
    return false;
  }
}

// A public-looking hostname can still resolve to an internal address.
async function assertPublicHost(url: string): Promise<void> {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(h)) {
    if (isPrivateIp(h)) throw new Error("private address");
    return;
  }
  const addrs = await lookup(h, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new Error("resolves to a private address");
}

// fetch() that validates the URL and EVERY redirect hop before requesting it.
async function safeFetch(startUrl: string, signal: AbortSignal, allowPrivate: boolean): Promise<{ res: Response; url: string }> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeUrl(url, allowPrivate)) throw new Error(`unsafe URL: ${url}`);
    if (!allowPrivate) await assertPublicHost(url);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/pdf,*/*;q=0.8" },
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url).toString();
      continue;
    }
    return { res, url };
  }
  throw new Error("too many redirects");
}

// Reads at most `max` bytes; `truncated` is true if the body was longer.
async function readCapped(res: Response, max: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(chunks), truncated };
}

// ───────────────────────── HTML helpers ─────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n")
    .trim();
}

function extractLinks(html: string, base: string, allowPrivate: boolean): { url: string; text: string; score: number }[] {
  const out: { url: string; text: string; score: number }[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let url: string;
    try { url = new URL(m[1], base).toString(); } catch { continue; }
    const text = htmlToText(m[2]).slice(0, 120);
    const hay = `${url} ${text}`;
    if (LINK_ANTI.test(hay) || !isSafeUrl(url, allowPrivate)) continue;
    let score = 0;
    if (/\.pdf(\?|$)/i.test(url)) score += 3;
    if (LINK_HINTS.test(hay)) score += 2;
    if (/(rfp|call[- _]for|guideline|terms[- _]of[- _]reference|application[- _]form)/i.test(hay)) score += 3;
    // Threshold 2 (the original was 3) so a plain "Eligibility FAQ" / "Apply" /
    // "Download" link still qualifies; ranking + MAX_FOLLOWED_LINKS keep the
    // strongest RFP-like links first.
    if (score >= 2) out.push({ url, text, score });
  }
  const seen = new Set<string>();
  return out.sort((a, b) => b.score - a.score).filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
}

// ───────────────────────── gathering ─────────────────────────

interface Fetched {
  url: string;
  label: string;
  kind: "pdf" | "html";
  pdf?: Buffer;
  text?: string;
  links?: { url: string; text: string; score: number }[];
}

async function fetchOne(
  url: string, label: string, wantLinks: boolean, signal: AbortSignal, allowPrivate: boolean, notes: string[]
): Promise<Fetched | null> {
  let res: Response;
  let finalUrl: string;
  try {
    ({ res, url: finalUrl } = await safeFetch(url, signal, allowPrivate));
  } catch (e) {
    notes.push(`Could not fetch ${url}: ${(e as Error).message}`);
    return null;
  }
  if (!res.ok) { await res.body?.cancel(); notes.push(`${url} returned HTTP ${res.status}`); return null; }

  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const declaredLength = Number(res.headers.get("content-length") ?? 0);
  const looksPdf = type.includes("application/pdf") || /\.pdf(\?|$)/i.test(finalUrl);
  try {
    if (looksPdf) {
      if (declaredLength > MAX_PDF_BYTES) { await res.body?.cancel(); notes.push(`PDF too large to send (${(declaredLength / 1e6).toFixed(1)} MB): ${finalUrl}`); return null; }
      const { buf, truncated } = await readCapped(res, MAX_PDF_BYTES);
      if (truncated) { notes.push(`PDF too large to send (> ${MAX_PDF_BYTES / 1e6 | 0} MB): ${finalUrl}`); return null; }
      if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") { notes.push(`Not actually a PDF: ${finalUrl}`); return null; }
      return { url: finalUrl, label, kind: "pdf", pdf: buf };
    }
    if (!type.includes("html") && !type.includes("text") && !type.includes("json")) {
      await res.body?.cancel();
      notes.push(`Unsupported content-type (${type || "unknown"}): ${finalUrl}`);
      return null;
    }
    const { buf, truncated } = await readCapped(res, MAX_HTML_BYTES);
    if (truncated) notes.push(`Page longer than ${MAX_HTML_BYTES / 1e6 | 0} MB — only the start was read: ${finalUrl}`);
    const html = buf.toString("utf8");
    return {
      url: finalUrl, label, kind: "html",
      text: htmlToText(html).slice(0, MAX_TEXT_PER_PAGE),
      links: wantLinks ? extractLinks(html, finalUrl, allowPrivate).slice(0, MAX_FOLLOWED_LINKS) : undefined,
    };
  } catch (e) {
    notes.push(`Could not read ${finalUrl}: ${(e as Error).message}`);
    return null;
  }
}

export async function gatherSources(
  startUrl: string | null,
  trackerContext: string,
  opts: { allowPrivateHosts?: boolean } = {}
): Promise<GatheredSources> {
  const allowPrivate = opts.allowPrivateHosts === true; // tests only
  const g: GatheredSources = { parts: [], used: [], notes: [], rfpUrl: null, textChars: 0, pdfCount: 0, coverageHint: "" };
  const budget = AbortSignal.timeout(TOTAL_BUDGET_MS);
  let inlineBytes = 0;
  const seen = new Set<string>();

  // Optionally give the model what the tracker already has (scraper output).
  if (trackerContext) g.parts.push({ text: `--- SOURCE: tracker record (scraper output) ---\n${trackerContext}` });

  const merge = (f: Fetched) => {
    if (f.kind === "pdf") {
      if (inlineBytes + f.pdf!.length > MAX_INLINE_TOTAL) { g.notes.push(`Skipped PDF (request size budget): ${f.url}`); return; }
      inlineBytes += f.pdf!.length;
      g.parts.push({ text: `--- SOURCE: ${f.label} [PDF] (${f.url}) ---` });
      g.parts.push({ inlineData: { mimeType: "application/pdf", data: f.pdf!.toString("base64") } });
      g.pdfCount++;
      g.rfpUrl ??= f.url;
    } else {
      g.parts.push({ text: `--- SOURCE: ${f.label} (${f.url}) ---\n${f.text}` });
      g.textChars += f.text!.length;
    }
    g.used.push(f.url);
  };

  if (startUrl) {
    seen.add(startUrl);
    const main = await fetchOne(startUrl, "call page", true, budget, allowPrivate, g.notes);
    if (main) {
      merge(main);
      const followUps = (main.links ?? []).filter((l) => !seen.has(l.url));
      followUps.forEach((l) => seen.add(l.url));
      // Parallel fetch, merged in link-score order so the prompt is stable.
      const fetched = await Promise.all(
        followUps.map((l) => fetchOne(l.url, `linked document: ${l.text || l.url}`, false, budget, allowPrivate, g.notes))
      );
      fetched.forEach((f) => f && merge(f));
    }
  } else g.notes.push("No source URL on file for this grant.");

  if (g.used.length === 0 && !trackerContext) throw new Error(`Could not read any source for this grant. ${g.notes.join(" ")}`);

  g.rfpUrl ??= g.used.find((u) => u !== startUrl) ?? startUrl;
  g.coverageHint =
    g.pdfCount > 0 || g.textChars > 8000
      ? "Sources include a full document or a long page — likely enough to read eligibility criteria."
      : g.textChars > 2500
      ? "Sources are a medium-length page — eligibility criteria may be incomplete."
      : "Sources are very short (likely a landing page or scraper summary) — probably NOT the full RFP.";
  return g;
}

// The most the model may claim about its own coverage, judged from what we
// actually fetched (the model can overrate a summary page). null = no cap.
export function maxCoverage(g: GatheredSources): "landing_page_only" | "partial" | null {
  if (g.pdfCount === 0 && g.textChars < 2500) return "landing_page_only";
  if (g.pdfCount === 0 && g.textChars <= 8000) return "partial";
  return null;
}
