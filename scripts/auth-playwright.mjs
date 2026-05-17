import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.QA_BASE_URL;
const loginPath = process.env.QA_AUTH_LOGIN_PAGE || "/login";
const apiPath = process.env.QA_AUTH_API_PATH;
const body = process.env.QA_AUTH_BODY;
const userSel = process.env.QA_AUTH_SELECTOR_USERNAME || 'input[type="text"], input[type="email"]';
const passSel = process.env.QA_AUTH_SELECTOR_PASSWORD || 'input[type="password"]';
const submitSel = process.env.QA_AUTH_SELECTOR_SUBMIT || 'form button[type="submit"]';
const reportsDir = process.env.QA_REPORTS_DIR || "/tmp/qa-reports";

if (!baseUrl || !body) {
  console.log("Skipping Playwright auth — QA_BASE_URL or QA_AUTH_BODY missing");
  process.exit(0);
}

let creds;
try {
  creds = JSON.parse(body);
} catch (e) {
  console.error(`Invalid QA_AUTH_BODY JSON: ${e.message}`);
  process.exit(1);
}

const pick = (...keys) => {
  for (const k of keys) {
    for (const variant of [k, k.toLowerCase(), k.charAt(0).toUpperCase() + k.slice(1)]) {
      if (creds[variant] != null) return creds[variant];
    }
  }
  return undefined;
};
const username = pick("username", "email", "user", "Username", "Email", "User", "login", "Login");
const password = pick("password", "pass", "Password", "Pw", "pw");
if (!username || !password) {
  console.error("QA_AUTH_BODY must contain username/email and password (case-insensitive, Pw/Password accepted)");
  process.exit(1);
}

fs.mkdirSync(reportsDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
});
const page = await context.newPage();

let token = "";

if (apiPath) {
  const fullApi = `${baseUrl.replace(/\/$/, "")}${apiPath}`;
  page.on("response", async (response) => {
    if (token || !response.url().startsWith(fullApi)) return;
    try {
      const data = await response.json();
      token =
        data.AccessToken ?? data.access_token ?? data.token ?? data.jwt ?? "";
    } catch {
      /* not JSON */
    }
  });
}

try {
  const loginUrl = `${baseUrl.replace(/\/$/, "")}${loginPath}`;
  console.log(`Navigating to ${loginUrl}...`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  await page.locator(userSel).first().fill(username);
  await page.locator(passSel).first().fill(password);

  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}),
    page.locator(submitSel).first().click(),
  ]);

  if (!token) {
    token = await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage)) {
        const val = window.localStorage.getItem(key) ?? "";
        if (val.startsWith("eyJ") || /^[\w-]+\.[\w-]+\.[\w-]+$/.test(val)) {
          return val;
        }
        try {
          const parsed = JSON.parse(val);
          const candidate =
            parsed?.token ?? parsed?.access_token ?? parsed?.AccessToken ?? "";
          if (typeof candidate === "string" && candidate.length > 20) {
            return candidate;
          }
        } catch {
          /* not JSON */
        }
      }
      return "";
    });
  }
} finally {
  await browser.close();
}

if (!token) {
  console.error("ERROR: Failed to extract auth token after Playwright login");
  process.exit(1);
}

const tokenPath = path.join(reportsDir, ".auth-token");
fs.writeFileSync(tokenPath, token, "utf8");
console.log(`::add-mask::${token}`);
console.log("Auth token obtained via Playwright");

if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `QA_AUTH_TOKEN=${token}\n`);
}
