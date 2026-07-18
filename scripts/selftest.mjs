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

// ---------------------------------------------------------------------------
console.log("Phase 2 — gate distinguishes ZAP skipped vs ZAP crashed (#23)");
{
  const skippedDir = freshReports();
  const skippedRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: skippedDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_ZAP_ENABLED: "true",
  });
  ok(
    /openapi\.json is unavailable/.test(skippedRun.out),
    "no openapi.json -> gate names the precondition, not a ZAP crash",
  );

  const crashedDir = freshReports();
  writeFileSync(join(crashedDir, "openapi.json"), JSON.stringify({}));
  const crashedRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: crashedDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_ZAP_ENABLED: "true",
  });
  ok(
    /ZAP step failed to produce report/.test(crashedRun.out),
    "openapi.json present but zap-report.json missing -> real ZAP-crash message",
  );
}

console.log("Phase 2 — schemathesis gate counts failures across ALL phases");
{
  const phasedDir = freshReports();
  writeFileSync(
    join(phasedDir, "schemathesis.txt"),
    " ⏭   Examples\n     ✅ 12 passed  ❌ 0 failed\n" +
      " ❌  Coverage\n     ✅ 52 passed  ❌ 23 failed\n" +
      " ❌  Fuzzing\n     ✅ 48 passed  ❌ 27 failed\n" +
      " ❌  Stateful\n     ✅ 268 passed  ❌ 9 failed\n",
  );
  const phasedRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: phasedDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
  });
  ok(
    phasedRun.code === 1,
    "leading '0 failed' phase does not mask later failing phases",
  );
  ok(
    /reported 27 failure/.test(phasedRun.out),
    "gate reports the worst phase count (27), not the first match",
  );
}

console.log(
  "Phase 3 — schemathesis classifier reconciles CF edge 5xx + RFC7807 4xx (#29/#30)",
);
{
  const reconDir = freshReports();
  writeFileSync(
    join(reconDir, "schemathesis.txt"),
    [
      " ❌  Coverage (in 88.35s)",
      "     ✅ 71 passed  ❌  2 failed",
      " ❌  Fuzzing (in 504.10s)",
      "     ✅ 70 passed  ❌  2 failed",
      "=================================== FAILURES ===================================",
      "_____________________ DELETE /v1/groups/{groupId}/schedule _____________________",
      "1. Test Case ID: crvFSN",
      "",
      "- Server error",
      "",
      "[520] Unknown:",
      "",
      "    `<!DOCTYPE html>",
      "    <title>example.com | 520: Web server is returning an unknown error</title>`",
      "",
      "____________________ POST /v1/me/devices/{sessionId}/command ___________________",
      "1. Test Case ID: 4CtQYm",
      "",
      "- API rejected schema-compliant request",
      "",
      "    Valid data should have been accepted",
      "    Expected: 2xx, 401, 403, 404, 409, 5xx",
      "",
      "[400] Bad Request:",
      "",
      '    `{"type":"about:blank","title":"Bad Request","status":400,"detail":"Unknown command: "}`',
      "",
      "____________________ POST /v1/sessions/{sessionId}/signals _____________________",
      "1. Test Case ID: 0tHKMj",
      "",
      "- API rejected schema-compliant request",
      "",
      "[400] Bad Request:",
      "",
      '    `{"type":"about:blank","title":"Bad Request","status":400,"detail":"UUID string too large"}`',
      "",
      "=================================== SUMMARY ====================================",
      "",
      "Test cases:",
      "  7421 generated, 3 found 3 unique failures, 1 skipped",
      "",
      "================== 3 failures, 3 warnings in 637.34s ==================",
      "",
    ].join("\n"),
  );
  const reconRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: reconDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
  });
  ok(
    reconRun.code === 0,
    "CF edge 520 + clean RFC7807 400s fully reconcile -> gate passes",
  );
  ok(
    /1 Cloudflare edge 5xx transient/.test(reconRun.out),
    "CF edge block surfaced as informational",
  );
  ok(
    /2 schema-compliant request\(s\) rejected with structured RFC7807/.test(
      reconRun.out,
    ),
    "problem+json 4xx blocks surfaced as informational",
  );

  const originDir = freshReports();
  writeFileSync(
    join(originDir, "schemathesis.txt"),
    [
      " ❌  Fuzzing (in 10s)",
      "     ✅ 70 passed  ❌  1 failed",
      "=================================== FAILURES ===================================",
      "_____________________ GET /v1/things _____________________",
      "1. Test Case ID: aaaaaa",
      "",
      "- Server error",
      "",
      "[500] Internal Server Error:",
      "",
      '    `{"error":"NullPointerException"}`',
      "",
      "=================================== SUMMARY ====================================",
      "",
      "Test cases:",
      "  100 generated, 1 found 1 unique failures",
      "",
      "================== 1 failures in 10.00s ==================",
      "",
    ].join("\n"),
  );
  const originRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: originDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
  });
  ok(originRun.code === 1, "origin 500 (non-CF body) still blocks");
}

console.log(
  "Phase 3 — schemathesis v4 errors: timeouts are transients, the rest gates (#34)",
);
{
  const errDir = freshReports();
  writeFileSync(
    join(errDir, "schemathesis.txt"),
    [
      " 🚫  Fuzzing (in 504.10s)",
      "     ✅ 70 passed  🚫  2 errors",
      "==================================== ERRORS ====================================",
      "___________________________ GET /v1/recommend/search ___________________________",
      "Network Error",
      "",
      "Read timed out after 10.0 seconds",
      "",
      "___________________________ POST /v1/groups ___________________________",
      "Network Error",
      "",
      "Connection reset by peer",
      "",
      "=================================== SUMMARY ====================================",
      "",
      "Test cases:",
      "  742 generated, 1 skipped",
      "",
      "================== 2 errors, 3 warnings in 63.34s ==================",
      "",
    ].join("\n"),
  );
  const errRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: errDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
  });
  ok(
    errRun.code === 1,
    "non-timeout network error (connection reset) still gates",
  );
  ok(
    /1 errored case/.test(errRun.out),
    "gate counts only the non-timeout errors as blocking",
  );
  ok(
    /1 read-timeout/.test(errRun.out),
    "read-timeout surfaced as a non-blocking transient",
  );

  const timeoutOnlyDir = freshReports();
  writeFileSync(
    join(timeoutOnlyDir, "schemathesis.txt"),
    [
      " 🚫  Fuzzing (in 504.10s)",
      "     ✅ 70 passed  🚫  1 error",
      "==================================== ERRORS ====================================",
      "___________________________ GET /Artists ___________________________",
      "Network Error",
      "",
      "Read timed out after 10.0 seconds",
      "",
      "=================================== SUMMARY ====================================",
      "",
      "Test cases:",
      "  742 generated, 1 skipped",
      "",
      "================== 1 error, 3 warnings in 63.34s ==================",
      "",
    ].join("\n"),
  );
  const timeoutOnlyRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: timeoutOnlyDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
  });
  ok(
    timeoutOnlyRun.code === 0,
    "read-timeout-only errors do not gate (self-inflicted fuzz load)",
  );
}

console.log(
  "Phase 3 — schemathesis all-429 failure blocks are rate-limiting, not bugs (#34)",
);
{
  const rlDir = freshReports();
  writeFileSync(
    join(rlDir, "schemathesis.txt"),
    [
      " ❌  Coverage (in 88.35s)",
      "     ✅ 71 passed  ❌  2 failed",
      "=================================== FAILURES ===================================",
      "_____________________ POST /v1/groups _____________________",
      "1. Test Case ID: aaaaaa",
      "",
      "- Missing Content-Type header",
      "",
      "[429] Too Many Requests:",
      "",
      "    `Too Many Requests`",
      "",
      "_____________________ GET /v1/things _____________________",
      "1. Test Case ID: bbbbbb",
      "",
      "- Server error",
      "",
      "[500] Internal Server Error:",
      "",
      '    `{"error":"NullPointerException"}`',
      "",
      "=================================== SUMMARY ====================================",
      "",
      "Test cases:",
      "  100 generated, 2 found 2 unique failures",
      "",
      "================== 2 failures in 10.00s ==================",
      "",
    ].join("\n"),
  );
  const rlRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: rlDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
  });
  ok(rlRun.code === 1, "origin 500 alongside a 429 block still gates");
  ok(
    /1 rate-limited operation/.test(rlRun.out),
    "all-429 block surfaced as informational rate-limiting",
  );
  ok(
    /reported 1 failure/.test(rlRun.out),
    "only the non-429 block counts as blocking",
  );

  const rlOnlyDir = freshReports();
  writeFileSync(
    join(rlOnlyDir, "schemathesis.txt"),
    [
      " ❌  Coverage (in 88.35s)",
      "     ✅ 71 passed  ❌  1 failed",
      "=================================== FAILURES ===================================",
      "_____________________ POST /v1/groups _____________________",
      "1. Test Case ID: cccccc",
      "",
      "- Missing Content-Type header",
      "",
      "- JSON deserialization error",
      "",
      "[429] Too Many Requests:",
      "",
      "    `Too Many Requests`",
      "",
      "=================================== SUMMARY ====================================",
      "",
      "Test cases:",
      "  100 generated, 1 found 1 unique failures",
      "",
      "================== 1 failures in 10.00s ==================",
      "",
    ].join("\n"),
  );
  const rlOnlyRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: rlOnlyDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
  });
  ok(
    rlOnlyRun.code === 0,
    "all-429-only failures fully reconcile -> gate passes",
  );
}

console.log("Phase 3 — ZAP auto-skip (no Docker) is non-blocking (#31)");
{
  const zapSkipDir = freshReports();
  writeFileSync(
    join(zapSkipDir, "zap-skipped.txt"),
    "no usable Docker daemon\n",
  );
  const zapSkipRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: zapSkipDir,
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_ZAP_ENABLED: "true",
    QA_GATE_ZAP_FAIL: "true",
  });
  ok(zapSkipRun.code === 0, "zap-skipped marker -> gate does not block");
  ok(
    /ZAP skipped — no usable Docker daemon/.test(zapSkipRun.out),
    "gate names the skip reason loudly",
  );
}

console.log("Phase 3 — baseline updates on schedule/workflow_dispatch runs");
{
  const schedDir = freshReports();
  const findingsPath = join(schedDir, "crawler-findings.json");
  writeFileSync(
    findingsPath,
    JSON.stringify({
      jsErrors: [{ path: "/", error: "boom", fingerprint: "fp-sched-1" }],
    }),
  );
  writeFileSync(join(schedDir, "baseline", "baseline.json"), "[]");
  const schedDiff = runNode("baseline-diff.mjs", {
    QA_REPORTS_DIR: schedDir,
    CRAWL_FINDINGS_PATH: findingsPath,
    QA_BASELINE_DIR: join(schedDir, "baseline"),
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF_NAME: "main",
    GITHUB_BASE_REF: "",
  });
  ok(schedDiff.code === 0, "baseline-diff exits 0 on schedule event");
  ok(
    readFileSync(join(schedDir, "baseline", "baseline.json"), "utf8").includes(
      "fp-sched-1",
    ),
    "schedule run overwrites the baseline (was push-only)",
  );

  const gateRun = runNode("aggregate-gate.mjs", {
    QA_REPORTS_DIR: schedDir,
    QA_GATE_CRAWLER_ENABLED: "true",
    QA_GATE_BASELINE_ENABLED: "true",
    QA_GATE_CRAWLER_FAIL: "true",
  });
  ok(
    gateRun.code === 0,
    "fresh findings on schedule run warn (alarm-once), not block",
  );
}

console.log(
  "Phase 4 — warehouse: gate emits findings-log.ndjson with rule ids",
);
{
  const whDir = freshReports();
  const persistDir = join(whDir, "persist");
  mkdirSync(persistDir, { recursive: true });
  writeFileSync(
    join(whDir, "schemathesis.txt"),
    [
      " 🚫  Fuzzing (in 10s)",
      "     ✅ 70 passed  🚫  1 error",
      "==================================== ERRORS ====================================",
      "___________ GET /Artists ___________",
      "Network Error",
      "",
      "Read timed out after 10.0 seconds",
      "",
      "=================================== SUMMARY ====================================",
      "",
      "================== 1 error in 10.00s ==================",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(whDir, "findings.json"),
    JSON.stringify([
      {
        tool: "crawler",
        severity: "medium",
        category: "a11y",
        fingerprint: "fp-wh-1",
      },
    ]),
  );
  const whEnv = {
    QA_REPORTS_DIR: whDir,
    QA_URL: "https://warehouse.selftest",
    QA_RUN_ID: "wh-run-1",
    QA_GATE_CRAWLER_ENABLED: "false",
    QA_GATE_SCHEMATHESIS_ENABLED: "true",
    QA_GATE_SCHEMATHESIS_FAIL: "true",
    QA_FINDINGS_LOG_DIR: persistDir,
  };
  runNode("aggregate-gate.mjs", whEnv);
  const logPath = join(whDir, "findings-log.ndjson");
  ok(existsSync(logPath), "findings-log.ndjson written to reports dir");
  const logRows = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  ok(
    logRows.some((r) => r.kind === "gate" && r.rule_id === "fuzz-read-timeout"),
    "gate row carries the downgrade rule_id",
  );
  ok(
    logRows.some((r) => r.kind === "finding" && r.fingerprint === "fp-wh-1"),
    "normalized finding row carries the fingerprint",
  );
  ok(
    logRows.every((r) => r.consumer === "warehouse.selftest"),
    "rows stamped with the consumer host",
  );
  runNode("aggregate-gate.mjs", { ...whEnv, QA_RUN_ID: "wh-run-2" });
  const persisted = readFileSync(
    join(persistDir, "findings-log.ndjson"),
    "utf8",
  )
    .trim()
    .split("\n");
  ok(
    persisted.length === logRows.length * 2,
    "persistent dir accumulates rows across runs (append)",
  );
  const hits = runNode("warehouse.mjs", {}, [
    "rule-hits",
    join(persistDir, "findings-log.ndjson"),
  ]);
  ok(hits.code === 0, "warehouse rule-hits query runs");
  ok(
    /fuzz-read-timeout\s+2\s+warehouse\.selftest/.test(hits.out),
    "rule-hits counts both runs for the firing rule",
  );
}

console.log("");
if (failures > 0) {
  console.error(`SELFTEST FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("SELFTEST PASSED");
