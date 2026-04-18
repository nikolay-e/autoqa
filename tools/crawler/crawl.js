import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE_URL = process.env.CRAWL_URL || '';
const USERNAME = process.env.CRAWL_USERNAME || '';
const PASSWORD = process.env.CRAWL_PASSWORD || '';
const LOGIN_URL = process.env.CRAWL_LOGIN_URL || '/login';
const LOGIN_SELECTOR_USERNAME =
  process.env.CRAWL_LOGIN_SELECTOR_USERNAME || 'input[type="text"], input[type="email"]';
const LOGIN_SELECTOR_PASSWORD =
  process.env.CRAWL_LOGIN_SELECTOR_PASSWORD || 'input[type="password"]';
const LOGIN_SELECTOR_SUBMIT =
  process.env.CRAWL_LOGIN_SELECTOR_SUBMIT || 'button[type="submit"], button';
const SEED_PAGES = (process.env.CRAWL_SEED_PAGES || '/').split(',').map(s => s.trim());
const MAX_PAGES = Number.parseInt(process.env.CRAWL_MAX_PAGES || '50', 10);
const WAIT_MS = Number.parseInt(process.env.CRAWL_WAIT_MS || '2000', 10);
const EXCLUDE_URLS = (process.env.CRAWL_EXCLUDE_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const FAIL_ON_VIOLATIONS = process.env.CRAWL_FAIL_ON_VIOLATIONS !== 'false';

const visited = new Set();
const queue = [];
const results = {
  pagesVisited: 0,
  jsErrors: [],
  networkErrors: [],
  axeViolations: [],
  brokenLinks: [],
  consoleWarnings: [],
};

function isExcluded(url) {
  return EXCLUDE_URLS.some(pattern => url.includes(pattern));
}

async function login(page, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(`${BASE_URL}${LOGIN_URL}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.fill(LOGIN_SELECTOR_USERNAME, USERNAME);
      await page.fill(LOGIN_SELECTOR_PASSWORD, PASSWORD);
      await page.click(LOGIN_SELECTOR_SUBMIT);
      await page.waitForURL(url => !url.toString().includes(LOGIN_URL), { timeout: 30000 });
      await page.waitForTimeout(1000);
      return;
    } catch (err) {
      console.log(`Login attempt ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await page.waitForTimeout(5000);
    }
  }
  throw new Error('Login failed after retries');
}

function extractLinks(page) {
  return page.evaluate(baseUrl => {
    const links = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('/') && !href.startsWith('//')) {
        links.add(href.split('?')[0].split('#')[0]);
      }
      if (href.startsWith(baseUrl)) {
        const path = new URL(href).pathname;
        links.add(path.split('?')[0].split('#')[0]);
      }
    });
    return [...links];
  }, BASE_URL);
}

async function crawlPage(page, path) {
  if (visited.has(path) || visited.size >= MAX_PAGES) return;
  visited.add(path);

  const pageErrors = [];
  const networkFailures = [];
  const warnings = [];

  page.on('pageerror', err => {
    pageErrors.push({ path, error: err.message });
  });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!text.includes('Failed to load resource')) {
        pageErrors.push({ path, error: `console.error: ${text}` });
      }
    }
    if (msg.type() === 'warning') {
      warnings.push({ path, warning: msg.text() });
    }
  });

  page.on('response', response => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && !isExcluded(url)) {
      networkFailures.push({ path, url, status });
    }
  });

  try {
    const response = await page.goto(`${BASE_URL}${path}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    if (!response || response.status() >= 400) {
      results.brokenLinks.push({
        path,
        status: response ? response.status() : 'no response',
      });
    }

    await page.waitForTimeout(WAIT_MS);

    results.pagesVisited++;
    results.jsErrors.push(...pageErrors);
    results.networkErrors.push(...networkFailures);
    results.consoleWarnings.push(...warnings);

    try {
      const axeResults = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
        .analyze();

      for (const violation of axeResults.violations) {
        results.axeViolations.push({
          path,
          id: violation.id,
          impact: violation.impact,
          description: violation.description,
          nodes: violation.nodes.length,
        });
      }
    } catch {
      // axe can fail on some pages
    }

    const links = await extractLinks(page);
    for (const link of links) {
      if (!visited.has(link) && !queue.includes(link)) {
        queue.push(link);
      }
    }

    const status = response ? response.status() : '?';
    const errorCount = pageErrors.length;
    const axeCount = results.axeViolations.filter(v => v.path === path).length;
    console.log(
      `  ${status} ${path} | errors:${errorCount} axe:${axeCount} links:${links.length}`
    );
  } catch (err) {
    results.brokenLinks.push({ path, status: `timeout: ${err.message}` });
    console.log(`  ERR ${path} | ${err.message}`);
  }

  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.removeAllListeners('response');
}

function printJsErrors() {
  if (results.jsErrors.length === 0) return;
  console.log('\n--- JS ERRORS ---');
  for (const e of results.jsErrors) {
    console.log(`  [${e.path}] ${e.error}`);
  }
}

function printNetworkErrors() {
  if (results.networkErrors.length === 0) return;
  console.log('\n--- NETWORK ERRORS ---');
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
  console.log('\n--- ACCESSIBILITY VIOLATIONS ---');
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
      `  [${v.impact}] ${v.id}: ${v.description} (${v.totalNodes} nodes on ${v.pages.length} pages)`
    );
  }
}

function printBrokenLinks() {
  if (results.brokenLinks.length === 0) return;
  console.log('\n--- BROKEN LINKS ---');
  for (const b of results.brokenLinks) {
    console.log(`  ${b.path} -> ${b.status}`);
  }
}

function printReport() {
  console.log('\n========== CRAWL REPORT ==========');
  console.log(`Pages visited: ${results.pagesVisited}`);
  console.log(`JS errors: ${results.jsErrors.length}`);
  console.log(`Network errors: ${results.networkErrors.length}`);
  console.log(`Axe violations: ${results.axeViolations.length}`);
  console.log(`Broken links: ${results.brokenLinks.length}`);
  printJsErrors();
  printNetworkErrors();
  printAxeViolations();
  printBrokenLinks();
  console.log('\n==================================');
}

function writeGitHubOutputs() {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  appendFileSync(outputFile, `pages-visited=${results.pagesVisited}\n`);
  appendFileSync(outputFile, `js-errors=${results.jsErrors.length}\n`);
  appendFileSync(outputFile, `axe-violations=${results.axeViolations.length}\n`);
  appendFileSync(outputFile, `broken-links=${results.brokenLinks.length}\n`);
}

async function main() {
  if (!BASE_URL) {
    console.error('CRAWL_URL is required');
    process.exit(1);
  }

  console.log(`\nCrawling ${BASE_URL} (max ${MAX_PAGES} pages)\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  if (USERNAME && PASSWORD) {
    await login(page);
    console.log('Logged in\n');
  } else {
    console.log('No credentials — skipping login\n');
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
  writeGitHubOutputs();

  const hasFailures =
    results.jsErrors.length > 0 ||
    results.brokenLinks.length > 0 ||
    results.axeViolations.some(v => v.impact === 'critical');

  if (FAIL_ON_VIOLATIONS && hasFailures) {
    process.exit(1);
  }
}

main();
