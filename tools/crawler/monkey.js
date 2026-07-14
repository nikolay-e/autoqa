import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { redactUrlSecrets } from "./redact.js";

const BASE_URL = process.env.MONKEY_URL || "";
const USERNAME = process.env.MONKEY_USERNAME || "";
const PASSWORD = process.env.MONKEY_PASSWORD || "";
const HTTP_BASIC_USERNAME = process.env.MONKEY_HTTP_BASIC_USERNAME || "";
const HTTP_BASIC_PASSWORD = process.env.MONKEY_HTTP_BASIC_PASSWORD || "";
const LOGIN_URL = process.env.MONKEY_LOGIN_URL || "/login";
const LOGIN_SELECTOR_USERNAME =
  process.env.MONKEY_LOGIN_SELECTOR_USERNAME ||
  'input[type="text"], input[type="email"]';
const LOGIN_SELECTOR_PASSWORD =
  process.env.MONKEY_LOGIN_SELECTOR_PASSWORD || 'input[type="password"]';
const LOGIN_SELECTOR_SUBMIT =
  process.env.MONKEY_LOGIN_SELECTOR_SUBMIT || 'button[type="submit"], button';
const SEED_PAGES = (process.env.MONKEY_SEED_PAGES || "/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DURATION_MS = Number.parseInt(
  process.env.MONKEY_DURATION_MS || "300000",
  10,
);
const SEED = Number.parseInt(process.env.MONKEY_SEED || "1337", 10);
const PER_ACTION_TIMEOUT = Number.parseInt(
  process.env.MONKEY_PER_ACTION_TIMEOUT_MS || "2000",
  10,
);
const ACTION_DELAY_MS = Number.parseInt(
  process.env.MONKEY_ACTION_DELAY_MS || "120",
  10,
);
const EXCLUDE_URLS = (process.env.MONKEY_EXCLUDE_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CONSOLE_IGNORE_PATTERNS = (process.env.MONKEY_CONSOLE_IGNORE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AVOID_TEXT = (
  process.env.MONKEY_AVOID_TEXT ||
  "logout,log out,sign out,signout,delete account,deactivate,remove account"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const FAIL_ON_VIOLATIONS = process.env.MONKEY_FAIL_ON_VIOLATIONS === "true";
const FINDINGS_PATH =
  process.env.MONKEY_FINDINGS_PATH || "/tmp/qa-reports/monkey-findings.json";

const SERIOUS_KINDS = new Set(["pageerror", "crash", "http-5xx"]);

const FUZZ_STRINGS = [
  "",
  " ",
  "a".repeat(5000),
  "🐒💥🔥𝕏‮\u0000",
  "<script>throw new Error('xss')</script>",
  '"><img src=x onerror=alert(1)>',
  "' OR 1=1 --",
  "%s%n%x%d",
  "-1e308",
  "99999999999999999999999999",
  "../../../../etc/passwd",
  "{{constructor.constructor('return 1')()}}",
  "\n\r\t\b\f",
];

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

function fingerprint(...parts) {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function normalize(msg) {
  return (msg || "")
    .replace(/[a-f0-9]{8,}/gi, "<hash>")
    .replace(/:\d+:\d+/g, "")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const findings = new Map();
let actionsPerformed = 0;

function isOffOrigin(where) {
  if (!originHost) return false;
  try {
    return new URL(where).host !== originHost;
  } catch {
    return false;
  }
}

function record(kind, where, message) {
  // Events firing while the monkey is on a foreign page (before the
  // framenavigated guard walks it back) describe the third-party site, not
  // the target app — same origin boundary the crawler enforces (issue #27).
  // The off-origin-nav breadcrumb itself stays: it documents the excursion.
  if (kind !== "off-origin-nav" && isOffOrigin(where)) return;
  const fp = fingerprint(kind, normalize(message), where);
  if (findings.has(fp)) {
    findings.get(fp).count++;
    return;
  }
  findings.set(fp, {
    kind,
    where,
    message: (message || "").slice(0, 500),
    serious: SERIOUS_KINDS.has(kind),
    count: 1,
    fingerprint: fp,
  });
}

function isExcluded(url) {
  return EXCLUDE_URLS.some((p) => url.includes(p));
}

let originHost = "";

function attachListeners(page) {
  page.on("pageerror", (err) => record("pageerror", page.url(), err.message));
  page.on("crash", () =>
    record("crash", page.url(), "page crashed (renderer)"),
  );
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text.startsWith("Failed to load resource:")) return;
    const sourceUrl = msg.location()?.url || "";
    if (sourceUrl && isExcluded(sourceUrl)) return;
    if (
      CONSOLE_IGNORE_PATTERNS.some(
        (pattern) => text.includes(pattern) || sourceUrl.includes(pattern),
      )
    )
      return;
    record("console-error", page.url(), text);
  });
  page.on("requestfailed", (req) => {
    const url = req.url();
    const errorText = req.failure()?.errorText || "";
    // ERR_ABORTED is the browser cancelling its own in-flight request when the
    // monkey navigates away or the SPA tears down a component — not a server
    // or network defect. Observed drowning real findings 200:1 on SPAs.
    if (errorText === "net::ERR_ABORTED") return;
    if (!isExcluded(url))
      record(
        "request-failed",
        page.url(),
        `${redactUrlSecrets(url)} ${errorText}`,
      );
  });
  page.on("response", (res) => {
    const status = res.status();
    const url = res.url();
    if (status >= 500 && !isExcluded(url))
      record("http-5xx", page.url(), `${status} ${redactUrlSecrets(url)}`);
  });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    let host = "";
    try {
      host = new URL(frame.url()).host;
    } catch {
      return;
    }
    if (host && originHost && host !== originHost) {
      record("off-origin-nav", frame.url(), `wandered to ${host}, returning`);
      page.goBack({ timeout: PER_ACTION_TIMEOUT }).catch(() => {});
    }
  });
}

function attachContextListeners(context) {
  context.on("page", (popup) => {
    if (popup.url() && popup !== context.pages()[0]) {
      popup.close().catch(() => {});
    }
  });
}

async function login(page) {
  for (let i = 0; i < 3; i++) {
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
      // Confirm the session is usable on a fresh navigation — a
      // SameSite=Strict / __Host- cookie can fail to attach after the submit,
      // leaving the monkey clicking around an unauthenticated shell. Bounce
      // back to /login means the session did not take; retry.
      const probe =
        SEED_PAGES.find(
          (p) => p && p !== LOGIN_URL && !p.startsWith(`${LOGIN_URL}/`),
        ) || "/";
      await page.goto(`${BASE_URL}${probe}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForTimeout(1500);
      const landed = new URL(page.url()).pathname;
      if (landed === LOGIN_URL || landed.startsWith(`${LOGIN_URL}/`)) {
        throw new Error(`session did not persist — bounced to ${landed}`);
      }
      return true;
    } catch (err) {
      console.log(`Login attempt ${i + 1}/3 failed: ${err.message}`);
      await page.waitForTimeout(2000);
    }
  }
  return false;
}

async function gotoSeed(page) {
  const seed = pick(SEED_PAGES);
  try {
    await page.goto(`${BASE_URL}${seed}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  } catch {
    /* dead end — next action recovers */
  }
}

const CANDIDATE_SELECTOR =
  "a, button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [onclick], [tabindex]";

async function pickElement(page) {
  const loc = page.locator(CANDIDATE_SELECTOR);
  let count = 0;
  try {
    count = await loc.count();
  } catch {
    return null;
  }
  if (count === 0) return null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const el = loc.nth(Math.floor(rng() * count));
    try {
      if ((await el.isVisible()) && (await el.isEnabled())) return el;
    } catch {
      /* element detached mid-check — try another */
    }
  }
  return null;
}

async function looksDestructive(el) {
  try {
    const label = (
      (await el.getAttribute("aria-label")) ||
      (await el.innerText().catch(() => "")) ||
      ""
    )
      .toLowerCase()
      .slice(0, 80);
    return AVOID_TEXT.some((t) => label.includes(t));
  } catch {
    return false;
  }
}

async function isOffOriginLink(el) {
  try {
    const tag = await el.evaluate((n) => n.tagName.toLowerCase());
    if (tag !== "a") return false;
    const href = (await el.getAttribute("href")) || "";
    if (/^(mailto:|tel:|javascript:|blob:|data:)/i.test(href)) return true;
    if (/^https?:\/\//i.test(href)) return new URL(href).host !== originHost;
    return false;
  } catch {
    return false;
  }
}

async function doClick(page) {
  const el = await pickElement(page);
  if (!el) return false;
  if (await looksDestructive(el)) return false;
  if (await isOffOriginLink(el)) return false;
  await el.click({ timeout: PER_ACTION_TIMEOUT, force: rng() < 0.2 });
  return true;
}

async function doType(page) {
  const loc = page.locator("input, textarea, [contenteditable=true]");
  let count = 0;
  try {
    count = await loc.count();
  } catch {
    return false;
  }
  if (count === 0) return false;
  const el = loc.nth(Math.floor(rng() * count));
  await el.fill(pick(FUZZ_STRINGS), { timeout: PER_ACTION_TIMEOUT });
  return true;
}

async function doSelect(page) {
  const loc = page.locator("select");
  let count = 0;
  try {
    count = await loc.count();
  } catch {
    return false;
  }
  if (count === 0) return false;
  const el = loc.nth(Math.floor(rng() * count));
  const options = await el.evaluate((n) =>
    Array.from(n.options).map((o) => o.value),
  );
  if (!options.length) return false;
  await el.selectOption(pick(options), { timeout: PER_ACTION_TIMEOUT });
  return true;
}

async function doKey(page) {
  await page.keyboard.press(
    pick(["Tab", "Enter", "Escape", "ArrowDown", "ArrowUp", "Space", "End"]),
  );
  return true;
}

async function doScroll(page) {
  await page.mouse.wheel(0, Math.floor((rng() - 0.3) * 2000));
  return true;
}

const ACTIONS = [
  ["click", doClick, 50],
  ["type", doType, 18],
  ["key", doKey, 12],
  ["scroll", doScroll, 8],
  ["select", doSelect, 5],
  ["back", async (page) => page.goBack({ timeout: PER_ACTION_TIMEOUT }), 4],
  ["seed", gotoSeed, 3],
];
const ACTION_BAG = ACTIONS.flatMap(([name, fn, weight]) =>
  Array(weight).fill([name, fn]),
);

function writeFindings(meta) {
  const list = [...findings.values()];
  const out = { ...meta, findings: list };
  const dir = FINDINGS_PATH.substring(0, FINDINGS_PATH.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(FINDINGS_PATH, JSON.stringify(out, null, 2));
  return list;
}

function writeSummary(meta, list) {
  const serious = list.filter((f) => f.serious);
  let md = "\n## AutoQA Monkey — chaos UI test\n\n";
  md += `Seed: \`${meta.seed}\` · duration: ${Math.round(meta.elapsedMs / 1000)}s · actions: ${meta.actions} · unique findings: ${list.length} (serious: **${serious.length}**)\n\n`;
  if (list.length) {
    md += "| Kind | Count | Where | Detail |\n|---|---|---|---|\n";
    for (const f of [...serious, ...list.filter((x) => !x.serious)].slice(
      0,
      50,
    )) {
      const detail = f.message.replace(/\|/g, "\\|").slice(0, 120);
      md += `| ${f.serious ? "🔴 " : ""}${f.kind} | ${f.count} | \`${f.where}\` | ${detail} |\n`;
    }
  } else {
    md += "No crashes, uncaught errors, or 5xx responses observed.\n";
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, md);
    } catch {}
  }
  console.log(md);
}

function writeGitHubOutputs(list) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const serious = list.filter((f) => f.serious).length;
  appendFileSync(outputFile, `monkey-actions=${actionsPerformed}\n`);
  appendFileSync(outputFile, `monkey-findings=${list.length}\n`);
  appendFileSync(outputFile, `monkey-serious=${serious}\n`);
}

async function main() {
  if (!BASE_URL) {
    console.error("MONKEY_URL is required");
    process.exit(1);
  }
  try {
    originHost = new URL(BASE_URL).host;
  } catch {
    console.error(`MONKEY_URL is not a valid URL: ${BASE_URL}`);
    process.exit(1);
  }

  console.log(
    `\nMonkey chaos test on ${BASE_URL} — seed ${SEED}, budget ${Math.round(DURATION_MS / 1000)}s\n`,
  );

  const browser = await chromium.launch({
    headless: true,
    args:
      process.env.MONKEY_NO_SANDBOX === "true"
        ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    ...(HTTP_BASIC_USERNAME && HTTP_BASIC_PASSWORD
      ? {
          httpCredentials: {
            username: HTTP_BASIC_USERNAME,
            password: HTTP_BASIC_PASSWORD,
          },
        }
      : {}),
  });
  const page = await context.newPage();
  attachContextListeners(context);
  attachListeners(page);

  const hardKill = setTimeout(() => {
    console.log("Hard-kill backstop fired — closing browser");
    browser.close().catch(() => {});
  }, DURATION_MS + 30000);

  if (USERNAME && PASSWORD) {
    const ok = await login(page);
    console.log(
      ok ? "Logged in\n" : "Login failed — continuing unauthenticated\n",
    );
  }
  await gotoSeed(page);

  const start = Date.now();
  let noProgress = 0;
  while (Date.now() - start < DURATION_MS && !page.isClosed()) {
    const [, fn] = pick(ACTION_BAG);
    let acted = true;
    try {
      acted = (await fn(page)) !== false;
    } catch {
      acted = false;
    }
    actionsPerformed++;
    noProgress = acted ? 0 : noProgress + 1;
    if (noProgress >= 8 && !page.isClosed()) {
      await page.keyboard.press("Escape").catch(() => {});
      await gotoSeed(page);
      noProgress = 0;
    } else if (actionsPerformed % 50 === 0 && !page.isClosed()) {
      await gotoSeed(page);
    }
    if (ACTION_DELAY_MS > 0 && !page.isClosed())
      await page
        .waitForTimeout(Math.floor(rng() * ACTION_DELAY_MS))
        .catch(() => {});
    if (actionsPerformed > 0 && actionsPerformed % 200 === 0)
      console.log(
        `  …${actionsPerformed} actions, ${findings.size} unique findings, ${Math.round((Date.now() - start) / 1000)}s`,
      );
  }

  clearTimeout(hardKill);
  const elapsedMs = Date.now() - start;
  const meta = {
    seed: SEED,
    durationMs: DURATION_MS,
    elapsedMs,
    actions: actionsPerformed,
  };
  const list = writeFindings(meta);
  await browser.close().catch(() => {});

  console.log(
    `\nMonkey done: ${actionsPerformed} actions, ${list.length} unique findings (${list.filter((f) => f.serious).length} serious)`,
  );
  writeSummary(meta, list);
  writeGitHubOutputs(list);

  const serious = list.filter((f) => f.serious).length;
  if (FAIL_ON_VIOLATIONS && serious > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`Monkey error: ${err.message}`);
  process.exit(0);
});
