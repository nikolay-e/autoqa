#!/usr/bin/env node
// Final gate for the autoqa composite action.
//
// The composite sets `continue-on-error: true` on every tool step so a
// crash in one tool does not skip the rest. Without this script, that
// design silently absorbs every tool's non-zero exit: a crawler that
// finds 200 broken links, a ZAP run with HIGH alerts, a schemathesis
// run with 5xx failures all leave the job green and ship the findings.
//
// This script runs `if: always()` AFTER every tool step and re-derives
// pass/fail from the report files written into /tmp/qa-reports. Each
// tool is gated by its own input (defaults: crawler/schemathesis/zap on,
// mechanical off because M1–M6 are advisory). Exits 1 if any enabled
// gate triggers; the composite action's exit code is what consumers
// actually read.
//
// Refs: https://github.com/nikolay-e/autoqa/issues/3

import { readFileSync, existsSync } from "node:fs";

const REPORTS = process.env.QA_REPORTS_DIR || "/tmp/qa-reports";
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || "";
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY || "";

const flag = (name, dflt = "false") =>
  (process.env[name] || dflt).toLowerCase() === "true";

const ENABLED = {
  crawler: flag("QA_GATE_CRAWLER_ENABLED", "true"),
  baseline: flag("QA_GATE_BASELINE_ENABLED", "true"),
  schemathesis: flag("QA_GATE_SCHEMATHESIS_ENABLED", "false"),
  zap: flag("QA_GATE_ZAP_ENABLED", "false"),
  mechanical: flag("QA_GATE_MECHANICAL_ENABLED", "true"),
  observatory: flag("QA_GATE_OBSERVATORY_ENABLED", "false"),
  authz: flag("QA_GATE_AUTHZ_ENABLED", "false"),
};

const FAIL_ON = {
  crawler: flag("QA_GATE_CRAWLER_FAIL", "true"),
  schemathesis: flag("QA_GATE_SCHEMATHESIS_FAIL", "true"),
  zap: flag("QA_GATE_ZAP_FAIL", "true"),
  mechanical: flag("QA_GATE_MECHANICAL_FAIL", "false"),
  observatory: flag("QA_GATE_OBSERVATORY_FAIL", "true"),
  authz: flag("QA_GATE_AUTHZ_FAIL", "true"),
};

const findings = [];

function record(tool, severity, message, details = null) {
  findings.push({ tool, severity, message, details });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function gateCrawler() {
  if (!ENABLED.crawler) return;
  const findingsPath = `${REPORTS}/crawler-findings.json`;
  if (!existsSync(findingsPath)) {
    record(
      "crawler",
      "fail",
      "crawler-findings.json missing — crawler step failed to produce output",
    );
    return;
  }
  const data = readJson(findingsPath);
  if (!data) {
    record("crawler", "fail", "crawler-findings.json is not valid JSON");
    return;
  }

  if (ENABLED.baseline) {
    const diff = readJson(`${REPORTS}/baseline-diff.json`);
    if (!diff) {
      record(
        "crawler",
        "warn",
        "baseline-diff.json missing — baseline step did not run",
      );
      return;
    }
    const fresh = diff.fresh || [];
    if (fresh.length > 0) {
      record(
        "crawler",
        "fail",
        `${fresh.length} NEW crawler findings vs baseline`,
        fresh
          .slice(0, 10)
          .map((f) => `${f.label || f.category} @ ${f.path}: ${f.summary}`),
      );
    }
    return;
  }

  const counts = {
    jsErrors: (data.jsErrors || []).length,
    brokenLinks: (data.brokenLinks || []).length,
    networkErrors: (data.networkErrors || []).length,
    cspViolations: (data.cspViolations || []).length,
    mixedContent: (data.mixedContent || []).length,
    critAxe: (data.axeViolations || []).filter((v) => v.impact === "critical")
      .length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    record(
      "crawler",
      "fail",
      `crawler reported ${total} violation(s)`,
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`),
    );
  }
}

function gateSchemathesis() {
  if (!ENABLED.schemathesis) return;
  const txt = `${REPORTS}/schemathesis.txt`;
  if (!existsSync(txt)) {
    record(
      "schemathesis",
      "fail",
      "schemathesis.txt missing — schemathesis step failed to run",
    );
    return;
  }
  const out = readFileSync(txt, "utf8");

  const summaryMatch = out.match(/(\d+)\s+failed/i);
  if (summaryMatch && Number(summaryMatch[1]) > 0) {
    record(
      "schemathesis",
      "fail",
      `schemathesis reported ${summaryMatch[1]} failure(s)`,
    );
    return;
  }
  const errorMatch = out.match(/(\d+)\s+errored/i);
  if (errorMatch && Number(errorMatch[1]) > 0) {
    record(
      "schemathesis",
      "fail",
      `schemathesis reported ${errorMatch[1]} errored case(s)`,
    );
    return;
  }
  if (/ERROR:|^Error:/m.test(out) && !/0 failed/i.test(out)) {
    const firstError = out
      .split("\n")
      .find((l) => /ERROR:|^Error:/.test(l))
      ?.slice(0, 200);
    record("schemathesis", "fail", "schemathesis step emitted an error", [
      firstError || "",
    ]);
  }
}

function gateZap() {
  if (!ENABLED.zap) return;
  const reportPath = `${REPORTS}/zap-report.json`;
  if (!existsSync(reportPath)) {
    record(
      "zap",
      "fail",
      "zap-report.json missing — ZAP step failed to produce report",
    );
    return;
  }
  const data = readJson(reportPath);
  if (!data) {
    record("zap", "fail", "zap-report.json is not valid JSON");
    return;
  }
  const sites = data.site || [];
  const highs = [];
  for (const site of sites) {
    for (const alert of site.alerts || []) {
      if (String(alert.riskcode) === "3") {
        highs.push(`${alert.name} (${alert.riskdesc || "High"})`);
      }
    }
  }
  if (highs.length > 0) {
    record(
      "zap",
      "fail",
      `${highs.length} HIGH ZAP alert(s)`,
      highs.slice(0, 10),
    );
  }
}

function gateMechanical() {
  if (!ENABLED.mechanical) return;
  const path = `${REPORTS}/mechanical-findings.json`;
  if (!existsSync(path)) return;
  const data = readJson(path) || [];
  const p0 = data.filter((f) => f.severity === "P0");
  if (p0.length > 0) {
    record(
      "mechanical",
      "fail",
      `${p0.length} P0 mechanical finding(s)`,
      p0.slice(0, 10).map((f) => `${f.check} @ ${f.path}: ${f.evidence}`),
    );
  }
}

const OBSERVATORY_GRADES = "A+ A A- B+ B B- C+ C C- D+ D D- F".split(" ");

function gateObservatory() {
  if (!ENABLED.observatory) return;
  const path = `${REPORTS}/observatory.json`;
  if (!existsSync(path)) return;
  const data = readJson(path);
  if (!data || !data.grade) return;
  const failGrade = process.env.QA_OBSERVATORY_FAIL_GRADE || "B";
  const currentRank = OBSERVATORY_GRADES.indexOf(data.grade);
  const threshold = OBSERVATORY_GRADES.indexOf(failGrade);
  if (currentRank > threshold && currentRank !== -1 && threshold !== -1) {
    record(
      "observatory",
      "fail",
      `Observatory grade ${data.grade} is worse than threshold ${failGrade}`,
    );
  }
}

function gateAuthz() {
  if (!ENABLED.authz) return;
  const path = `${REPORTS}/authz-matrix.json`;
  if (!existsSync(path)) return;
  const data = readJson(path);
  if (!data) return;
  const failures = (data.findings || []).filter(
    (f) => (f.issues || []).length > 0,
  );
  if (failures.length > 0) {
    record(
      "authz",
      "fail",
      `${failures.length} AuthZ matrix violation(s) (BOLA / auth-bypass)`,
      failures
        .slice(0, 10)
        .map(
          (f) => `${f.path}: ${(f.issues || []).map((i) => i.kind).join(", ")}`,
        ),
    );
  }
}

gateCrawler();
gateSchemathesis();
gateZap();
gateMechanical();
gateObservatory();
gateAuthz();

const lines = ["## AutoQA — final gate\n"];
lines.push(`Event: \`${EVENT_NAME || "local"}\`\n`);
lines.push("| Tool | Gate enabled | Fail on | Status |");
lines.push("|---|---|---|---|");
for (const tool of Object.keys(ENABLED)) {
  if (tool === "baseline") continue;
  const tFindings = findings.filter((f) => f.tool === tool);
  const status = tFindings.length === 0 ? "ok" : tFindings[0].severity;
  lines.push(
    `| ${tool} | ${ENABLED[tool] ? "yes" : "no"} | ${FAIL_ON[tool] ? "yes" : "no"} | ${status} |`,
  );
}
lines.push("");

const blocking = findings.filter(
  (f) => f.severity === "fail" && FAIL_ON[f.tool],
);
if (findings.length > 0) {
  lines.push("### Findings\n");
  for (const f of findings) {
    const willFail =
      f.severity === "fail" && FAIL_ON[f.tool] ? " (BLOCKING)" : "";
    lines.push(`- **${f.tool}** [${f.severity}]${willFail}: ${f.message}`);
    if (f.details && f.details.length) {
      for (const d of f.details) lines.push(`  - ${d}`);
    }
  }
  lines.push("");
}

const summary = lines.join("\n");
console.log(summary);
if (SUMMARY_PATH) {
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(SUMMARY_PATH, summary);
  } catch (err) {
    console.log(`Failed to write step summary: ${err.message}`);
  }
}

if (blocking.length > 0) {
  console.error(
    `\nFAIL: ${blocking.length} blocking finding(s) across ${new Set(blocking.map((f) => f.tool)).size} tool(s)`,
  );
  process.exit(1);
}
console.log("\nOK: no blocking findings");
