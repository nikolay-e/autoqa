#!/usr/bin/env node
// Integration self-test for the crawler's origin boundary (issue #27).
//
// Starts an "app" server whose /oauth/authorize 302-redirects to a separate
// "provider" server on another port (a different origin). The provider page
// is deliberately broken — throwing script, 404 asset, no landmarks — so any
// audit leak across the boundary shows up as findings. The crawler must skip
// the off-origin page entirely: no JS errors, no network errors, no axe
// violations attributed to the redirecting path.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRAWLER = join(REPO_ROOT, "tools", "crawler", "crawl.js");

const APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Off-origin self-test app</title></head>
<body><main><h1>App home</h1><a href="/oauth/authorize">Connect provider</a></main></body>
</html>`;

const PROVIDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>External provider login</title></head>
<body>
<p>Provider login page with deliberate defects.</p>
<img src="/missing-hero.jpeg" alt="">
<script>throw new Error("provider-page-error");</script>
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

// Same trap as selftest-http-basic: both test servers live on THIS process's
// event loop, so the crawler must run as an async child — never spawnSync.
function runCrawler(env) {
  const reports = mkdtempSync(join(tmpdir(), "autoqa-offorigin-"));
  const child = spawn("node", [CRAWLER], {
    env: {
      ...process.env,
      CRAWL_MAX_PAGES: "5",
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
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
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
      resolve({ result: { status, stdout, stderr }, findings });
    });
  });
}

const provider = createServer((req, res) => {
  if (req.url.startsWith("/missing-hero.jpeg")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PROVIDER_HTML);
});

await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}`;

const app = createServer((req, res) => {
  if (req.url.startsWith("/oauth/authorize")) {
    res.writeHead(302, { Location: `${providerUrl}/login` });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(APP_HTML);
});

await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const appUrl = `http://127.0.0.1:${app.address().port}`;
console.log(`App server on ${appUrl}, provider server on ${providerUrl}`);

console.log("\nCrawler must stop at the origin boundary");
const run = await runCrawler({ CRAWL_URL: appUrl });

check(
  "crawler exits 0",
  run.result.status === 0,
  `exit=${run.result.status}\n${run.result.stderr}`,
);
check("findings written", run.findings !== null);
check(
  "off-origin redirect logged as skipped",
  run.result.stdout.includes("SKIP /oauth/authorize"),
  run.result.stdout,
);
check(
  "provider JS error not reported",
  !(run.findings?.jsErrors || []).some((e) =>
    e.error.includes("provider-page-error"),
  ),
  JSON.stringify(run.findings?.jsErrors),
);
check(
  "provider 404 asset not reported",
  !(run.findings?.networkErrors || []).some((e) =>
    e.url.includes("missing-hero"),
  ),
  JSON.stringify(run.findings?.networkErrors),
);
check(
  "no axe violations attributed to the redirecting path",
  !(run.findings?.axeViolations || []).some(
    (v) => v.path === "/oauth/authorize",
  ),
  JSON.stringify(run.findings?.axeViolations),
);
check(
  "redirecting path not counted as visited page",
  run.findings?.pagesVisited === 1,
  `pagesVisited=${run.findings?.pagesVisited}`,
);

provider.close();
app.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll off-origin self-test checks passed");
