/* eslint-disable @typescript-eslint/no-explicit-any */
// Run: npx tsx test/fetchSources.test.ts
// Uses a throw-away local HTTP server (so no internet needed). The server lives
// on 127.0.0.1, which the real SSRF guard blocks — tests that need it pass
// allowPrivateHosts, the API route never does.
import http from "node:http";
import { gatherSources, isPrivateIp, isSafeUrl, maxCoverage } from "../lib/eligibility/fetchSources";

let failed = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra}`);
};

async function main() {
  // ── URL safety (no network) ──
  console.log("──────── URL safety ────────");
  const unsafe = [
    "http://localhost/x", "http://127.0.0.1/x", "http://10.1.2.3/x", "http://192.168.0.5/x", "http://172.16.0.1/x",
    "http://172.31.255.255/x", "http://169.254.169.254/latest/meta-data", "http://0.0.0.0/x", "http://100.64.0.1/x",
    "http://[::1]/x", "http://[fd00::1]/x", "http://[::ffff:127.0.0.1]/x", "http://2130706433/x", "http://0x7f000001/x",
    "http://foo.internal/x", "http://printer.local/x", "ftp://example.org/x", "file:///etc/passwd",
    "https://user:pass@example.org/x", "https://example.org:8443/x", "http://example.org:22/x",
  ];
  for (const u of unsafe) check(!isSafeUrl(u), `blocked ${u}`);
  for (const u of ["https://example.org/call.pdf", "http://example.org/a?b=1", "https://sub.funder.eu:443/x"]) check(isSafeUrl(u), `allowed ${u}`);
  check(isPrivateIp("172.15.0.1") === false && isPrivateIp("172.32.0.1") === false, "172.15/172.32 are public, 172.16–31 private");
  check(isPrivateIp("8.8.8.8") === false && isPrivateIp("2606:4700::1111") === false, "public v4/v6 not flagged");

  // With the guard ON, a page on localhost is refused and nothing is read.
  let threw = false;
  try { await gatherSources("http://127.0.0.1:1/never", ""); } catch { threw = true; }
  check(threw, "guard on: localhost start URL → error, nothing read");

  // ── local server ──
  console.log("\n──────── fetching ────────");
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n" + "x".repeat(2000));
  const longText = "Eligibility: private companies operating in Kenya may apply. ".repeat(200); // ~12k chars
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/call") {
      res.setHeader("content-type", "text/html");
      res.end(`<html><body><h1>Call for proposals</h1>${longText}
        <a href="/docs/guidelines.pdf">Guidelines</a>
        <a href="/docs/fake.pdf">Application form (broken)</a>
        <a href="/faq">Eligibility FAQ</a>
        <a href="/privacy-policy">Privacy policy</a>
        <a href="https://twitter.com/funder">Follow us</a>
        <a href="/docs/missing.pdf">Terms of reference</a></body></html>`);
    } else if (url === "/call-huge") {
      res.setHeader("content-type", "text/html");
      res.end(`<html><body>${longText}<a href="/docs/huge.pdf">Annex huge</a></body></html>`);
    } else if (url === "/docs/guidelines.pdf") { res.setHeader("content-type", "application/pdf"); res.end(pdfBytes); }
    else if (url === "/docs/fake.pdf") { res.setHeader("content-type", "application/pdf"); res.end("<html>not a pdf</html>"); }
    else if (url === "/docs/huge.pdf") { res.setHeader("content-type", "application/pdf"); res.setHeader("content-length", String(50 * 1024 * 1024)); res.end("%PDF-"); }
    else if (url === "/faq") { res.setHeader("content-type", "text/html"); res.end("<p>FAQ: applicants must be registered companies.</p>"); }
    else if (url === "/short") { res.setHeader("content-type", "text/html"); res.end("<p>Landing page. Apply soon.</p>"); }
    else if (url === "/r1") { res.statusCode = 302; res.setHeader("location", "/r2"); res.end(); }
    else if (url === "/r2") { res.statusCode = 302; res.setHeader("location", "/faq"); res.end(); }
    else if (url === "/loop") { res.statusCode = 302; res.setHeader("location", "/loop"); res.end(); }
    else if (url === "/binary") { res.setHeader("content-type", "application/zip"); res.end("PK"); }
    else if (url === "/big") { res.setHeader("content-type", "text/html"); res.end("<p>" + "a ".repeat(2_000_000) + "</p>"); }
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const opts = { allowPrivateHosts: true };

  const g = await gatherSources(`${base}/call`, "", opts);
  check(g.pdfCount === 1, "reads the good PDF, skips the fake one", ` (pdfCount ${g.pdfCount})`);
  check(g.used.includes(`${base}/faq`) && g.used.includes(`${base}/docs/guidelines.pdf`), "follows RFP-like links (PDF + FAQ)");
  check(!g.used.some((u) => u.includes("privacy") || u.includes("twitter")), "does not follow privacy / social links");
  check(g.notes.some((n) => n.includes("Not actually a PDF")), "flags a PDF that isn't one");
  check(g.notes.some((n) => n.includes("HTTP 404")), "records a 404 on a linked document");
  const hugeRun = await gatherSources(`${base}/call-huge`, "", opts);
  check(hugeRun.pdfCount === 0 && hugeRun.notes.some((n) => n.includes("too large")), "refuses a PDF whose declared size is over the cap");
  check(g.rfpUrl === `${base}/docs/guidelines.pdf`, "rfpUrl = the PDF");
  check(g.parts.some((p: any) => p.inlineData?.mimeType === "application/pdf"), "PDF is inlined as base64 part");
  check(maxCoverage(g) === null, "long page + PDF → no coverage cap");
  const order = g.parts.filter((p: any) => p.text?.startsWith("--- SOURCE")).map((p: any) => p.text.split("(")[0]);
  check(order[0].includes("call page"), "call page comes first in the prompt parts");

  const short = await gatherSources(`${base}/short`, "", opts);
  check(maxCoverage(short) === "landing_page_only" && short.coverageHint.includes("NOT the full RFP"), "short page → landing_page_only cap");

  const redir = await gatherSources(`${base}/r1`, "", opts);
  check(redir.used.length === 1 && redir.used[0] === `${base}/faq`, "follows a redirect chain (r1→r2→faq)", ` (${redir.used})`);

  let loopErr = "";
  try { await gatherSources(`${base}/loop`, "", opts); } catch (e) { loopErr = (e as Error).message; }
  check(loopErr.includes("too many redirects") || loopErr.includes("Could not read any source"), "redirect loop is cut off", ` (${loopErr.slice(0, 80)})`);

  let binErr = "";
  try { await gatherSources(`${base}/binary`, "", opts); } catch (e) { binErr = (e as Error).message; }
  check(binErr.includes("Unsupported content-type") || binErr.includes("Could not read any source"), "unsupported content-type is skipped");

  const big = await gatherSources(`${base}/big`, "", opts);
  check(big.textChars <= 60_000 && big.notes.some((n) => n.includes("only the start was read")), "oversized page is truncated, not loaded whole", ` (${big.textChars} chars)`);

  // Fetch failure but tracker context present → still returns something usable
  const ctxOnly = await gatherSources(`${base}/missing`, "Deadline on file: 2026-12-01", opts);
  check(ctxOnly.used.length === 0 && ctxOnly.parts.length === 1 && maxCoverage(ctxOnly) === "landing_page_only", "unreachable page + tracker context → context only, capped");

  let nothing = false;
  try { await gatherSources(`${base}/missing`, "", opts); } catch { nothing = true; }
  check(nothing, "unreachable page + no context → error (route then falls back to Gemini's own page reading)");

  server.close();
  console.log(failed ? `\n${failed} FAILED` : "\nAll scenarios passed");
  process.exit(failed ? 1 : 0);
}
main();
