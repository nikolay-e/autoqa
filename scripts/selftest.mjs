#!/usr/bin/env node
// Integration self-test for the gate + findings backbone. Drives the REAL
// scripts end-to-end against fixtures written to a temp reports dir — no unit
// mocking (repo mandate: integration/e2e only). Exits non-zero on the first
// failed assertion so it can gate autoqa's own CI.
//
// Covers:
//   Phase 0 — baseline-diff + aggregate-gate actually FAIL on a new crawler
//     finding under baseline-fail-on-new, and pass when it matches the baseline.
//   Phase 1 — normalize-findings converts every artifact into valid
//     StandardFindings, --strict rejects a schema-invalid custom finding, and
//     generate-qa-report emits the md+json deliverable with correct counts.

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;

function ok(cond, label) {
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures++;
  }
}

function runNode(script, env, args = []) {
  try {
    const out = execFileSync("node", [join(HERE, script), ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: (err.stdout || "") + (err.stderr || ""),
    };
  }
}

function freshReports() {
  const dir = mkdtempSync(join(tmpdir(), "autoqa-selftest-"));
  mkdirSync(join(dir, "baseline"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
console.log("Phase 0 — gate fails on a new crawler finding");
{
  const dir = freshReports();
  const baseline = {
    pagesVisited: 3,
    jsErrors: [],
    axeViolations: [
      {
        path: "/",
        id: "color-contrast",
        impact: "serious",
        description: "Elements must have sufficient color contrast",
        nodes: 1,
        target: "button.cta",
        fingerprint: "base-contrast-0001",
      },
    ],
    brokenLinks: [],
    networkErrors: [],
    cspViolations: [],
    mixedContent: [],
  };
  writeFileSync(
    join(dir, "baseline", "baseline.json"),
    JSON.stringify(baseline),
  );

  // Current run introduces a NEW axe finding not in the baseline.
  const regressed = JSON.parse(JSON.stringify(baseline));
  regressed.axeViolations.push({
    path: "/settings",
    id: "button-name",
    impact: "critical",
    description: "Buttons must have discernible text",
    nodes: 2,
    target: "button.icon-only",
    fingerprint: "new-buttonname-9999",
  });
  writeFileSync(join(dir, "crawler-findings.json"), JSON.stringify(regressed));

  const gateEnv = {
    QA_REPORTS_DIR: dir,
    QA_BASELINE_DIR: join(dir, "baseline"),
    CRAWL_FINDINGS_PATH: join(dir, "crawler-findings.json"),
    QA_EVENT_NAME: "push",
    QA_REF_NAME: "main",
    QA_GATE_CRAWLER_ENABLED: "true",
    QA_GATE_BASELINE_ENABLED: "true",
    QA_GATE_BASELINE_FAIL_ON_NEW: "true",
  };
  runNode("baseline-diff.mjs", gateEnv);
  const regRun = runNode("aggregate-gate.mjs", gateEnv);
  ok(regRun.code === 1, "new finding under fail-on-new exits 1 (blocking)");
  ok(
    /button-name|NEW crawler/.test(regRun.out),
    "gate output names the new finding",
  );

  // Second run: current == baseline (the regression was absorbed) -> green.
  const dir2 = freshReports();
  writeFileSync(
    join(dir2, "baseline", "baseline.json"),
    JSON.stringify(regressed),
  );
  writeFileSync(join(dir2, "crawler-findings.json"), JSON.stringify(regressed));
  const cleanEnv = {
    ...gateEnv,
    QA_REPORTS_DIR: dir2,
    QA_BASELINE_DIR: join(dir2, "baseline"),
    CRAWL_FINDINGS_PATH: join(dir2, "crawler-findings.json"),
  };
  runNode("baseline-diff.mjs", cleanEnv);
  const cleanRun = runNode("aggregate-gate.mjs", cleanEnv);
  ok(cleanRun.code === 0, "no new findings vs baseline exits 0 (green)");
}

// ---------------------------------------------------------------------------
console.log("Phase 1 — normalize converts every artifact to valid findings");
const richDir = freshReports();
{
  writeFileSync(
    join(richDir, "crawler-findings.json"),
    JSON.stringify({
      pagesVisited: 5,
      jsErrors: [
        { path: "/", error: "TypeError: x is undefined", fingerprint: "js1" },
      ],
      networkErrors: [
        { path: "/", url: "https://x/api/y", status: 502, fingerprint: "n1" },
      ],
      axeViolations: [
        {
          path: "/",
          id: "color-contrast",
          impact: "serious",
          description: "contrast",
          nodes: 3,
          target: "button.cta",
          helpUrl: "https://dequeuniversity.com/rules/axe/4.10/color-contrast",
          failureSummary: "Fix any of the following: contrast 2.1 < 4.5",
          fingerprint: "axe1",
        },
      ],
      brokenLinks: [{ path: "/dead", status: 404, fingerprint: "bl1" }],
      cspViolations: [
        { path: "/", message: "Refused to load script", fingerprint: "csp1" },
      ],
      mixedContent: [
        { path: "/", url: "http://insecure/img.png", fingerprint: "mc1" },
      ],
    }),
  );
  writeFileSync(
    join(richDir, "mechanical-findings.json"),
    JSON.stringify([
      {
        check: "M1",
        path: "/",
        severity: "P0",
        evidence: "mojibake Ð",
        sample: "Ð¿Ñ€",
      },
    ]),
  );
  writeFileSync(
    join(richDir, "observatory.json"),
    JSON.stringify({
      grade: "F",
      score: 10,
      tests_failed: 6,
      details_url: "https://obs/x",
    }),
  );
  writeFileSync(
    join(richDir, "schemathesis.txt"),
    "___ GET /widgets ___\n[500] Server error\n\n=== SUMMARY ===\n3 failed\n",
  );
  writeFileSync(
    join(richDir, "zap-report.json"),
    JSON.stringify({
      site: [
        {
          alerts: [
            {
              name: "SQL Injection",
              riskcode: "3",
              riskdesc: "High",
              instances: [{ uri: "https://x/api/login" }],
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(richDir, "authz-matrix.json"),
    JSON.stringify({
      findings: [
        {
          path: "/api/notes/1",
          userA: 200,
          userB: 200,
          noAuth: 401,
          issues: [{ kind: "bola", detail: "user B got 200" }],
        },
      ],
    }),
  );
  writeFileSync(
    join(richDir, "monkey-findings.json"),
    JSON.stringify({
      seed: 1337,
      findings: [
        {
          kind: "http-5xx",
          where: "/",
          message: "500 https://x/api/z",
          serious: true,
          count: 2,
          fingerprint: "mk1",
        },
      ],
    }),
  );

  const res = runNode("normalize-findings.mjs", { QA_REPORTS_DIR: richDir }, [
    "--strict",
  ]);
  ok(res.code === 0, "normalize --strict exits 0 on valid fixtures");
  const findings = existsSync(join(richDir, "findings.json"))
    ? JSON.parse(readFileSync(join(richDir, "findings.json"), "utf8"))
    : [];
  ok(
    findings.length >= 10,
    `produced ${findings.length} findings (>=10 expected)`,
  );
  const tools = new Set(findings.map((f) => f.tool));
  for (const t of [
    "crawler-axe",
    "crawler-js",
    "crawler-network",
    "crawler-links",
    "crawler-csp",
    "crawler-mixed",
    "mechanical",
    "observatory",
    "schemathesis",
    "zap",
    "authz",
    "monkey",
  ]) {
    ok(tools.has(t), `converter emitted a ${t} finding`);
  }
  const axe = findings.find((f) => f.tool === "crawler-axe");
  ok(
    axe && axe.docs_url.includes("dequeuniversity") && axe.fix_hint.length > 0,
    "axe finding carries docs_url + fix_hint from enriched capture",
  );
}

// ---------------------------------------------------------------------------
console.log("Phase 1 — --strict rejects a schema-invalid custom finding");
{
  const badDir = freshReports();
  const extra = join(badDir, "extra.json");
  writeFileSync(
    extra,
    JSON.stringify([
      { tool: "custom", title: "no severity", category: "security" },
    ]),
  );
  const res = runNode(
    "normalize-findings.mjs",
    { QA_REPORTS_DIR: badDir, QA_EXTRA_FINDINGS: extra },
    ["--strict"],
  );
  ok(res.code === 1, "invalid custom finding fails --strict (schema is law)");

  const lenient = runNode("normalize-findings.mjs", {
    QA_REPORTS_DIR: badDir,
    QA_EXTRA_FINDINGS: extra,
  });
  ok(
    lenient.code === 0,
    "same invalid finding is dropped (not fatal) in lenient mode",
  );
}

// ---------------------------------------------------------------------------
console.log("Phase 1 — report generator emits the COMPLETE deliverable");
{
  const res = runNode("generate-qa-report.mjs", {
    QA_REPORTS_DIR: richDir,
    QA_URL: "https://example.com",
  });
  ok(res.code === 0, "generate-qa-report exits 0 (never gates)");
  ok(existsSync(join(richDir, "qa-report.md")), "qa-report.md written");
  const reportJson = existsSync(join(richDir, "qa-report.json"))
    ? JSON.parse(readFileSync(join(richDir, "qa-report.json"), "utf8"))
    : null;
  ok(reportJson && reportJson.total >= 10, "qa-report.json has finding total");
  const md = readFileSync(join(richDir, "qa-report.md"), "utf8");
  ok(
    /Executive summary/.test(md) && /Scope & coverage/.test(md),
    "md has exec summary + coverage sections",
  );
}

console.log("");
if (failures > 0) {
  console.error(`SELFTEST FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("SELFTEST PASSED");
