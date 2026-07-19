#!/usr/bin/env node
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";

const ENABLED = process.env.QA_AUTHZ_ENABLED === "true";
const BASE_URL = process.env.QA_BASE_URL || "";
const AUTH_PATH = process.env.QA_AUTH_PATH || "";
const AUTH_URL = /^https?:\/\//.test(AUTH_PATH)
  ? AUTH_PATH
  : `${BASE_URL.replace(/\/$/, "")}${AUTH_PATH}`;
const USER_A_BODY = process.env.QA_AUTHZ_USER_A_BODY || "";
const USER_B_BODY = process.env.QA_AUTHZ_USER_B_BODY || "";
const RESOURCE_PATHS = (process.env.QA_AUTHZ_RESOURCE_PATHS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REPORT_PATH = "/tmp/qa-reports/authz-matrix.json";
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY || "";

const ACCEPTABLE_FORBIDDEN = new Set([401, 403, 404]);
const TOKEN_FIELDS = ["AccessToken", "access_token", "token", "jwt"];

function extractToken(json) {
  for (const field of TOKEN_FIELDS) {
    if (json && typeof json[field] === "string" && json[field])
      return json[field];
  }
  return "";
}

async function login(body) {
  const origin = AUTH_URL.match(/^https?:\/\/[^/]+/)?.[0] || "";
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Auth failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const json = await res.json();
  const token = extractToken(json);
  if (!token)
    throw new Error(
      `No token field in auth response (tried ${TOKEN_FIELDS.join(", ")})`,
    );
  return token;
}

async function probe(url, headers) {
  try {
    const res = await fetch(url, { headers, redirect: "manual" });
    return { status: res.status, ok: true };
  } catch (err) {
    return { status: 0, ok: false, error: err.message };
  }
}

function appendSummary(content) {
  if (SUMMARY_PATH) {
    try {
      appendFileSync(SUMMARY_PATH, content);
    } catch {}
  }
  console.log(content);
}

async function main() {
  if (!ENABLED) {
    console.log("Skipping AuthZ matrix — QA_AUTHZ_ENABLED != 'true'");
    return;
  }
  if (!BASE_URL || !AUTH_PATH || !USER_A_BODY || !USER_B_BODY) {
    console.log(
      "Skipping AuthZ matrix — required env vars missing (BASE_URL, AUTH_PATH, USER_A_BODY, USER_B_BODY)",
    );
    return;
  }
  if (RESOURCE_PATHS.length === 0) {
    console.log("Skipping AuthZ matrix — QA_AUTHZ_RESOURCE_PATHS empty");
    return;
  }

  console.log(
    `AuthZ matrix: testing ${RESOURCE_PATHS.length} resource paths owned by user A`,
  );

  const [tokenA, tokenB] = await Promise.all([
    login(USER_A_BODY),
    login(USER_B_BODY),
  ]);
  console.log("Both tokens obtained");

  const findings = [];

  for (const path of RESOURCE_PATHS) {
    const url = /^https?:\/\//.test(path)
      ? path
      : `${BASE_URL.replace(/\/$/, "")}${path}`;
    const aRes = await probe(url, { Authorization: `Bearer ${tokenA}` });
    const bRes = await probe(url, { Authorization: `Bearer ${tokenB}` });
    const noAuthRes = await probe(url, {});

    const ownerOk = aRes.status >= 200 && aRes.status < 300;
    const bolaLeak = bRes.status >= 200 && bRes.status < 300;
    const authBypass = noAuthRes.status >= 200 && noAuthRes.status < 300;

    const issues = [];
    if (!ownerOk)
      issues.push({
        kind: "owner-access-broken",
        detail: `user A got ${aRes.status}`,
      });
    if (bolaLeak)
      issues.push({
        kind: "bola",
        detail: `user B got ${bRes.status} (expected 401/403/404)`,
      });
    if (!bolaLeak && !ACCEPTABLE_FORBIDDEN.has(bRes.status)) {
      issues.push({
        kind: "bola-weak",
        detail: `user B got ${bRes.status} (expected 401/403/404)`,
      });
    }
    if (authBypass)
      issues.push({
        kind: "auth-bypass",
        detail: `no-auth got ${noAuthRes.status} (expected 401)`,
      });
    if (!authBypass && !ACCEPTABLE_FORBIDDEN.has(noAuthRes.status)) {
      issues.push({
        kind: "auth-weak",
        detail: `no-auth got ${noAuthRes.status} (expected 401/403/404)`,
      });
    }

    findings.push({
      path,
      userA: aRes.status,
      userB: bRes.status,
      noAuth: noAuthRes.status,
      issues,
    });

    const verdict = issues.length === 0 ? "OK" : "FAIL";
    console.log(
      `  ${verdict} ${path} | A:${aRes.status} B:${bRes.status} none:${noAuthRes.status}`,
    );
  }

  mkdirSync("/tmp/qa-reports", { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({ findings }, null, 2));

  const failed = findings.filter((f) => f.issues.length > 0);
  let md = "\n## AutoQA AuthZ matrix — BOLA / auth-bypass\n\n";
  md += `Resources tested: ${findings.length} · Issues: **${failed.length}**\n\n`;
  if (failed.length > 0) {
    md +=
      "| Path | User A | User B | No auth | Issues |\n|---|---|---|---|---|\n";
    for (const f of failed) {
      const issues = f.issues
        .map((i) => `${i.kind}: ${i.detail}`)
        .join("<br>")
        .replace(/\|/g, "\\|");
      md += `| \`${f.path}\` | ${f.userA} | ${f.userB} | ${f.noAuth} | ${issues} |\n`;
    }
  } else {
    md += "All resources correctly enforce owner-only access.\n";
  }
  appendSummary(md);

  if (failed.length > 0) {
    console.error(`FAIL: ${failed.length} authZ issues (BOLA / auth-bypass)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`AuthZ matrix error: ${err.message}`);
  process.exit(1);
});
