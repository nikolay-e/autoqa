import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE_URL = process.env.CRAWL_URL || "";
const USERNAME = process.env.CRAWL_USERNAME || "";
const PASSWORD = process.env.CRAWL_PASSWORD || "";
const LOGIN_URL = process.env.CRAWL_LOGIN_URL || "/login";
const LOGIN_SELECTOR_USERNAME =
  process.env.CRAWL_LOGIN_SELECTOR_USERNAME ||
  'input[type="text"], input[type="email"]';
const LOGIN_SELECTOR_PASSWORD =
  process.env.CRAWL_LOGIN_SELECTOR_PASSWORD || 'input[type="password"]';
const LOGIN_SELECTOR_SUBMIT =
  process.env.CRAWL_LOGIN_SELECTOR_SUBMIT || 'button[type="submit"], button';
const SEED_PAGES = (process.env.CRAWL_SEED_PAGES || "/")
  .split(",")
  .map((s) => s.trim());
const MAX_PAGES = Number.parseInt(process.env.CRAWL_MAX_PAGES || "50", 10);
const WAIT_MS = Number.parseInt(process.env.CRAWL_WAIT_MS || "2000", 10);
const EXCLUDE_URLS = (process.env.CRAWL_EXCLUDE_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CONSOLE_IGNORE_PATTERNS = (process.env.CRAWL_CONSOLE_IGNORE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FAIL_ON_VIOLATIONS = process.env.CRAWL_FAIL_ON_VIOLATIONS === "true";
const FINDINGS_PATH =
  process.env.CRAWL_FINDINGS_PATH || "/tmp/qa-reports/crawler-findings.json";
const PAGES_PATH =
  process.env.CRAWL_PAGES_PATH || "/tmp/qa-reports/crawler-pages.json";
const SCREENSHOT_DIR =
  process.env.CRAWL_SCREENSHOT_DIR || "/tmp/qa-reports/screenshots";
const ARGOS_ENABLED = process.env.CRAWL_ARGOS_ENABLED === "true";

const CSP_VIOLATION_PATTERN = /Content Security Policy/i;

const visited = new Set();
const queue = [];
const results = {
  pagesVisited: 0,
  jsErrors: [],
  networkErrors: [],
  axeViolations: [],
  axeErrors: [],
  brokenLinks: [],
  consoleWarnings: [],
  cspViolations: [],
  mixedContent: [],
};

const pages = [];

function fingerprint(...parts) {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function normalizeJsError(msg) {
  return msg
    .replace(/[a-f0-9]{8,}/gi, "<hash>")
    .replace(/:\d+:\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function pathSlug(path) {
  return path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "root";
}

function isExcluded(url) {
  return EXCLUDE_URLS.some((pattern) => url.includes(pattern));
}

function isIgnoredConsoleMessage(text, sourceUrl) {
  if (sourceUrl && isExcluded(sourceUrl)) return true;
  return CONSOLE_IGNORE_PATTERNS.some(
    (pattern) => text.includes(pattern) || sourceUrl.includes(pattern),
  );
}

async function login(page, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(`${BASE_URL}${LOGIN_URL}`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.fill(LOGIN_SELECTOR_USERNAME, USERNAME);
      await page.fill(LOGIN_SELECTOR_PASSWORD, PASSWORD);
      await page.click(LOGIN_SELECTOR_SUBMIT);
      await page.waitForURL(
        (url) => {
          const p = new URL(url).pathname;
          return p !== LOGIN_URL && !p.startsWith(`${LOGIN_URL}/`);
        },
        { timeout: 30000 },
      );
      await page.waitForTimeout(1000);
      return;
    } catch (err) {
      console.log(`Login attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await page.waitForTimeout(5000);
    }
  }
  throw new Error("Login failed after retries");
}

function extractLinks(page) {
  return page.evaluate((baseUrl) => {
    const links = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      if (href.startsWith("/") && !href.startsWith("//")) {
        links.add(href.split("?")[0].split("#")[0]);
      }
      if (href.startsWith(baseUrl)) {
        const path = new URL(href).pathname;
        links.add(path.split("?")[0].split("#")[0]);
      }
    });
    return [...links];
  }, BASE_URL);
}

async function captureScreenshots(page, path) {
  if (!ARGOS_ENABLED) return;
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const slug = pathSlug(path);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/${slug}__1440x900.png`,
      fullPage: false,
    });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/${slug}__375x667.png`,
      fullPage: false,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
  } catch (err) {
    console.log(`  screenshot failed for ${path}: ${err.message}`);
  }
}

async function crawlPage(page, path) {
  if (visited.has(path) || visited.size >= MAX_PAGES) return;
  if (isExcluded(path)) return;
  visited.add(path);

  const pageErrors = [];
  const networkFailures = [];
  const warnings = [];
  const cspIssues = [];
  const mixed = [];

  page.on("pageerror", (err) => {
    pageErrors.push({
      path,
      error: err.message,
      fingerprint: fingerprint("js-error", normalizeJsError(err.message), path),
    });
  });

  page.on("console", (msg) => {
    const text = msg.text();
    const type = msg.type();
    const sourceUrl = msg.location().url || "";
    if (isIgnoredConsoleMessage(text, sourceUrl)) return;
    if (CSP_VIOLATION_PATTERN.test(text)) {
      cspIssues.push({
        path,
        message: text.slice(0, 300),
        fingerprint: fingerprint("csp", normalizeJsError(text), path),
      });
      return;
    }
    if (type === "error") {
      if (!text.startsWith("Failed to load resource:")) {
        pageErrors.push({
          path,
          error: `console.error: ${text}`,
          fingerprint: fingerprint("js-error", normalizeJsError(text), path),
        });
      }
    }
    if (type === "warning") {
      warnings.push({ path, warning: text });
    }
  });

  page.on("request", (request) => {
    const url = request.url();
    if (
      url.startsWith("http://") &&
      BASE_URL.startsWith("https://") &&
      !isExcluded(url)
    ) {
      mixed.push({
        path,
        url,
        fingerprint: fingerprint("mixed-content", new URL(url).pathname, path),
      });
    }
  });

  page.on("response", (response) => {
    const status = response.status();
    const url = response.url();
    const isMainNavigation =
      response.request().isNavigationRequest() &&
      response.frame() === page.mainFrame();
    if (status >= 400 && !isMainNavigation && !isExcluded(url)) {
      networkFailures.push({
        path,
        url,
        status,
        fingerprint: fingerprint(
          "network",
          String(status),
          new URL(url).pathname,
          path,
        ),
      });
    }
  });

  try {
    const response = await page.goto(`${BASE_URL}${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (!response || response.status() >= 400) {
      const status = response ? response.status() : "no response";
      results.brokenLinks.push({
        path,
        status,
        fingerprint: fingerprint("broken", String(status), path),
      });
    }

    await page.waitForTimeout(WAIT_MS);

    results.pagesVisited++;
    results.jsErrors.push(...pageErrors);
    results.networkErrors.push(...networkFailures);
    results.consoleWarnings.push(...warnings);
    results.cspViolations.push(...cspIssues);
    results.mixedContent.push(...mixed);

    try {
      const axeResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "best-practice"])
        .analyze();

      for (const violation of axeResults.violations) {
        const target = (violation.nodes[0]?.target || []).join(">>>");
        results.axeViolations.push({
          path,
          id: violation.id,
          impact: violation.impact,
          description: violation.description,
          nodes: violation.nodes.length,
          target,
          helpUrl: violation.helpUrl || "",
          failureSummary: (violation.nodes[0]?.failureSummary || "").slice(
            0,
            300,
          ),
          fingerprint: fingerprint("axe", violation.id, path),
        });
      }
    } catch (err) {
      results.axeErrors.push({ path, error: err.message });
      console.log(`  axe failed on ${path}: ${err.message}`);
    }

    await captureScreenshots(page, path);

    try {
      const extracted = await page.evaluate(() => {
        const collectText = (el) => (el?.innerText || "").trim();
        const listSelectors = [
          "ul",
          "ol",
          '[role="list"]',
          "tbody",
          '[role="grid"]',
        ];
        const lists = [];
        for (const sel of listSelectors) {
          for (const el of document.querySelectorAll(sel)) {
            const itemEls =
              sel === "tbody"
                ? el.querySelectorAll("tr")
                : el.querySelectorAll(
                    ":scope > li, :scope > [role='listitem'], :scope > [role='row'], :scope > div",
                  );
            const items = Array.from(itemEls)
              .map((it) => collectText(it))
              .filter((t) => t && t.length < 500);
            if (items.length >= 2) {
              lists.push({
                selector: sel,
                count: items.length,
                items: items.slice(0, 60),
              });
            }
          }
        }
        const textNodes = [];
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null,
        );
        let n;
        while ((n = walker.nextNode())) {
          const t = n.nodeValue.trim();
          if (t && t.length >= 2 && t.length < 500) textNodes.push(t);
        }
        const buttons = Array.from(
          document.querySelectorAll('button, [role="button"]'),
        )
          .map((b) =>
            (b.innerText || b.getAttribute("aria-label") || "").trim(),
          )
          .filter(Boolean);
        const headings = Array.from(
          document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
        )
          .map((h) => collectText(h))
          .filter(Boolean);
        return {
          bodyText: (document.body?.innerText || "").slice(0, 50000),
          textNodes: textNodes.slice(0, 800),
          buttons: buttons.slice(0, 200),
          headings: headings.slice(0, 100),
          lists: lists.slice(0, 20),
        };
      });
      pages.push({ path, ...extracted });
    } catch {
      // page evaluation failed — skip page-level mechanical input but keep crawler findings
    }

    const links = await extractLinks(page);
    for (const link of links) {
      if (!visited.has(link) && !queue.includes(link) && !isExcluded(link)) {
        queue.push(link);
      }
    }

    const status = response ? response.status() : "?";
    const errorCount = pageErrors.length;
    const axeCount = results.axeViolations.filter(
      (v) => v.path === path,
    ).length;
    const cspCount = cspIssues.length;
    const mixedCount = mixed.length;
    console.log(
      `  ${status} ${path} | errors:${errorCount} axe:${axeCount} csp:${cspCount} mixed:${mixedCount} links:${links.length}`,
    );
  } catch (err) {
    results.brokenLinks.push({
      path,
      status: `timeout: ${err.message}`,
      fingerprint: fingerprint("broken", "timeout", path),
    });
    console.log(`  ERR ${path} | ${err.message}`);
  }

  page.removeAllListeners("pageerror");
  page.removeAllListeners("console");
  page.removeAllListeners("request");
  page.removeAllListeners("response");
}

function printJsErrors() {
  if (results.jsErrors.length === 0) return;
  console.log("\n--- JS ERRORS ---");
  for (const e of results.jsErrors) {
    console.log(`  [${e.path}] ${e.error}`);
  }
}

function printNetworkErrors() {
  if (results.networkErrors.length === 0) return;
  console.log("\n--- NETWORK ERRORS ---");
  const unique = new Map();
  for (const e of results.networkErrors) {
    const dedupKey = `${e.status} ${new URL(e.url).pathname}`;
    if (!unique.has(dedupKey)) unique.set(dedupKey, e);
  }
  for (const [, e] of unique) {
    console.log(`  [${e.path}] ${e.status} ${e.url}`);
  }
}

function printAxeViolations() {
  if (results.axeViolations.length === 0) return;
  console.log("\n--- ACCESSIBILITY VIOLATIONS ---");
  const grouped = new Map();
  for (const v of results.axeViolations) {
    if (!grouped.has(v.id)) {
      grouped.set(v.id, { ...v, totalNodes: 0, pages: [] });
    }
    const g = grouped.get(v.id);
    g.totalNodes += v.nodes;
    g.pages.push(v.path);
  }
  for (const [, v] of grouped) {
    console.log(
      `  [${v.impact}] ${v.id}: ${v.description} (${v.totalNodes} nodes on ${v.pages.length} pages)`,
    );
  }
}

function printBrokenLinks() {
  if (results.brokenLinks.length === 0) return;
  console.log("\n--- BROKEN LINKS ---");
  for (const b of results.brokenLinks) {
    console.log(`  ${b.path} -> ${b.status}`);
  }
}

function printCspViolations() {
  if (results.cspViolations.length === 0) return;
  console.log("\n--- CSP VIOLATIONS ---");
  for (const c of results.cspViolations) {
    console.log(`  [${c.path}] ${c.message}`);
  }
}

function printMixedContent() {
  if (results.mixedContent.length === 0) return;
  console.log("\n--- MIXED CONTENT ---");
  for (const m of results.mixedContent) {
    console.log(`  [${m.path}] ${m.url}`);
  }
}

function printReport() {
  console.log("\n========== CRAWL REPORT ==========");
  console.log(`Pages visited: ${results.pagesVisited}`);
  console.log(`JS errors: ${results.jsErrors.length}`);
  console.log(`Network errors: ${results.networkErrors.length}`);
  console.log(`Axe violations: ${results.axeViolations.length}`);
  if (results.axeErrors.length > 0) {
    console.log(`Axe FAILED to run on ${results.axeErrors.length} page(s)`);
  }
  console.log(`Broken links: ${results.brokenLinks.length}`);
  console.log(`CSP violations: ${results.cspViolations.length}`);
  console.log(`Mixed content: ${results.mixedContent.length}`);
  printJsErrors();
  printNetworkErrors();
  printAxeViolations();
  printBrokenLinks();
  printCspViolations();
  printMixedContent();
  console.log("\n==================================");
}

function writeFindings() {
  const dir = FINDINGS_PATH.substring(0, FINDINGS_PATH.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(FINDINGS_PATH, JSON.stringify(results, null, 2));
  writeFileSync(PAGES_PATH, JSON.stringify(pages, null, 2));
  console.log(`\nFindings written to ${FINDINGS_PATH}`);
}

function writeGitHubOutputs() {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  appendFileSync(outputFile, `pages-visited=${results.pagesVisited}\n`);
  appendFileSync(outputFile, `js-errors=${results.jsErrors.length}\n`);
  appendFileSync(
    outputFile,
    `axe-violations=${results.axeViolations.length}\n`,
  );
  appendFileSync(outputFile, `broken-links=${results.brokenLinks.length}\n`);
  appendFileSync(
    outputFile,
    `csp-violations=${results.cspViolations.length}\n`,
  );
  appendFileSync(outputFile, `mixed-content=${results.mixedContent.length}\n`);
}

async function main() {
  if (!BASE_URL) {
    console.error("CRAWL_URL is required");
    process.exit(1);
  }

  console.log(`\nCrawling ${BASE_URL} (max ${MAX_PAGES} pages)\n`);

  const browser = await chromium.launch({
    headless: true,
    args:
      process.env.CRAWL_NO_SANDBOX === "true"
        ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  if (USERNAME && PASSWORD) {
    await login(page);
    console.log("Logged in\n");
  } else {
    console.log("No credentials — skipping login\n");
  }

  for (const seed of SEED_PAGES) {
    if (!queue.includes(seed) && !visited.has(seed)) {
      queue.push(seed);
    }
  }

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const path = queue.shift();
    await crawlPage(page, path);
  }

  await browser.close();
  printReport();
  writeFindings();
  writeGitHubOutputs();

  const hasFailures =
    results.jsErrors.length > 0 ||
    results.brokenLinks.length > 0 ||
    results.cspViolations.length > 0 ||
    results.mixedContent.length > 0 ||
    results.axeViolations.some((v) => v.impact === "critical");

  if (FAIL_ON_VIOLATIONS && hasFailures) {
    process.exit(1);
  }
}

main();
