#!/usr/bin/env node
// Integration self-test for HTTP Basic Auth support (issue #26).
//
// Starts a local HTTP server gated by Basic auth and drives the REAL crawler
// against it twice: with credentials (expects a clean crawl) and without
// (expects the 401 to surface as a broken-link finding). Requires the
// Playwright chromium browser already installed (runs in the self-test CI
// job after the composite action has installed tools/crawler deps).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRAWLER = join(REPO_ROOT, "tools", "crawler", "crawl.js");

const BASIC_USER = "qa-basic-user";
const BASIC_PASS = "qa-basic-pass";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}`;

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Basic Auth self-test</title></head>
<body><main><h1>Protected page</h1><p>Visible only with credentials.</p></main>
<script>
  // Deliberate repeated identical error: the crawler must dedup by
  // fingerprint (one entry, count=3), and the api_key must be redacted from
  // the recorded message text.
  for (let i = 0; i < 3; i++) {
    console.error("fetch failed /api/data?api_key=deadbeefcafe1234 (attempt)");
  }
</script>
</body>
</html>`;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The crawler must run as an async child (never spawnSync): the Basic-auth
// test server lives on THIS process's event loop, and a synchronous wait
// would freeze it — every page.goto would then time out against a server
// that can no longer accept connections.
function runCrawler(env) {
  const reports = mkdtempSync(join(tmpdir(), "autoqa-basic-"));
  const child = spawn("node", [CRAWLER], {
    env: {
      ...process.env,
      CRAWL_MAX_PAGES: "1",
      CRAWL_WAIT_MS: "100",
      CRAWL_FAIL_ON_VIOLATIONS: "false",
      CRAWL_FINDINGS_PATH: join(reports, "crawler-findings.json"),
      CRAWL_PAGES_PATH: join(reports, "crawler-pages.json"),
      CRAWL_SCREENSHOT_DIR: join(reports, "screenshots"),
      GITHUB_OUTPUT: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.resume();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 120000);
  return new Promise((resolve) => {
    child.on("close", (status) => {
      clearTimeout(killTimer);
      let findings = null;
      try {
        findings = JSON.parse(
          readFileSync(join(reports, "crawler-findings.json"), "utf8"),
        );
      } catch {
        // left null — asserted below
      }
      resolve({ result: { status, stderr }, findings });
    });
  });
}

const server = createServer((req, res) => {
  if (req.headers.authorization !== EXPECTED_AUTH) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="autoqa"',
      "Content-Type": "text/html",
    });
    // Challenge-page-like markup, deliberately full of axe violations
    // (no lang, meta-refresh, no title): none of it may be attributed to
    // the app path — error pages are not audited.
    res.end(
      '<html><head><meta http-equiv="refresh" content="5"></head>' +
        "<body>Unauthorized</body></html>",
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`Basic-auth test server on ${baseUrl}`);

console.log("\nPhase 1 — crawler WITH httpCredentials reaches the page");
const withCreds = await runCrawler({
  CRAWL_URL: baseUrl,
  CRAWL_HTTP_BASIC_USERNAME: BASIC_USER,
  CRAWL_HTTP_BASIC_PASSWORD: BASIC_PASS,
});
check(
  "crawler exits 0",
  withCreds.result.status === 0,
  `exit=${withCreds.result.status}\n${withCreds.result.stderr}`,
);
check("findings written", withCreds.findings !== null);
check(
  "page visited",
  withCreds.findings?.pagesVisited === 1,
  `pagesVisited=${withCreds.findings?.pagesVisited}`,
);
check(
  "no broken links (main navigation got 200)",
  (withCreds.findings?.brokenLinks || []).length === 0,
  JSON.stringify(withCreds.findings?.brokenLinks),
);
const jsErrors = withCreds.findings?.jsErrors || [];
check(
  "repeated identical console.error dedups to one entry with count=3",
  jsErrors.length === 1 && jsErrors[0].count === 3,
  JSON.stringify(jsErrors),
);
check(
  "api_key value redacted from recorded error text",
  jsErrors.length === 1 &&
    jsErrors[0].error.includes("api_key=REDACTED") &&
    !jsErrors[0].error.includes("deadbeefcafe1234"),
  JSON.stringify(jsErrors[0]),
);

console.log("\nPhase 2 — crawler WITHOUT credentials surfaces the 401");
const noCreds = await runCrawler({ CRAWL_URL: baseUrl });
check(
  "401 reported as broken link",
  (noCreds.findings?.brokenLinks || []).some((b) => b.status === 401),
  JSON.stringify(noCreds.findings?.brokenLinks),
);
check(
  "error page is not audited (no axe findings from the 401 page)",
  (noCreds.findings?.axeViolations || []).length === 0,
  JSON.stringify(noCreds.findings?.axeViolations),
);
check(
  "error page not counted as visited",
  noCreds.findings?.pagesVisited === 0,
  `pagesVisited=${noCreds.findings?.pagesVisited}`,
);

server.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll HTTP Basic Auth self-test checks passed");
