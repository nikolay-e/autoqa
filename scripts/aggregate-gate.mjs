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
  monkey: flag("QA_GATE_MONKEY_ENABLED", "false"),
};

const FAIL_ON = {
  crawler: flag("QA_GATE_CRAWLER_FAIL", "true"),
  schemathesis: flag("QA_GATE_SCHEMATHESIS_FAIL", "true"),
  zap: flag("QA_GATE_ZAP_FAIL", "true"),
  mechanical: flag("QA_GATE_MECHANICAL_FAIL", "false"),
  observatory: flag("QA_GATE_OBSERVATORY_FAIL", "true"),
  authz: flag("QA_GATE_AUTHZ_FAIL", "true"),
  monkey: flag("QA_GATE_MONKEY_FAIL", "false"),
};

// Decorative-resource paths (e.g. /Images/) whose 4xx network errors / broken
// links are expected when the underlying optional asset is genuinely absent —
// the API's correct answer is 404 and the UI renders a placeholder. Each such
// URL usually carries a unique id (/Items/<id>/Images/Primary), so it never
// settles into the baseline and keeps surfacing as a NEW finding. When the
// consumer opts in via crawler-decorative-paths, matching 4xx crawler findings
// are downgraded to non-blocking info instead of failing the gate. Default
// empty — opt-in, no behaviour change for existing consumers. Ref: issue #11.
const DECORATIVE_PATHS = (process.env.QA_GATE_CRAWLER_DECORATIVE_PATHS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DECORATIVE_CATEGORIES = new Set(["networkErrors", "brokenLinks"]);

function isDecorative(category, ...haystacks) {
  if (DECORATIVE_PATHS.length === 0) return false;
  if (!DECORATIVE_CATEGORIES.has(category)) return false;
  return haystacks.some(
    (h) => h && DECORATIVE_PATHS.some((p) => h.includes(p)),
  );
}

// HIGH ZAP alerts on endpoints fronted by a rate limiter / auth gate are false
// positives: the differential ZAP measured (typically boolean-based SQLi) is the
// limiter's 429/403, not a real DB-level injection — the attack never reached the
// database. The traditional -J report carries no per-instance HTTP status, so the
// gate cannot see the 429 directly; instead the consumer declares the rate-limited
// / auth-gated paths and a HIGH alert is downgraded to non-blocking info only when
// EVERY one of its instances targets such a path (an alert that also fires on an
// un-gated path still blocks, and an alert with no instance data fails safe and
// stays blocking). Default empty — opt-in, no behaviour change. Ref: issue #7.
const ZAP_RATE_LIMITED_PATHS = (
  process.env.QA_GATE_ZAP_RATE_LIMITED_PATHS || ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function allInstancesRateLimited(alert) {
  if (ZAP_RATE_LIMITED_PATHS.length === 0) return false;
  const instances = alert.instances || [];
  if (instances.length === 0) return false;
  return instances.every(
    (i) => i.uri && ZAP_RATE_LIMITED_PATHS.some((p) => i.uri.includes(p)),
  );
}

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
    const freshAll = diff.fresh || [];
    const decorative = freshAll.filter((f) =>
      isDecorative(f.category, f.summary, f.path),
    );
    const fresh = freshAll.filter((f) => !decorative.includes(f));
    if (decorative.length > 0) {
      record(
        "crawler",
        "info",
        `${decorative.length} decorative-resource 4xx finding(s) downgraded (matched crawler-decorative-paths)`,
        decorative
          .slice(0, 10)
          .map((f) => `${f.label || f.category} @ ${f.path}: ${f.summary}`),
      );
    }
    if (fresh.length > 0) {
      const baselineUpdatedOnMainPush =
        diff.eventName === "push" && ["main", "master"].includes(diff.refName);
      const noBaselineYet = diff.baselinePresent === false;
      const notBlocking = baselineUpdatedOnMainPush || noBaselineYet;
      const reason = baselineUpdatedOnMainPush
        ? " (baseline updated on main push — not blocking)"
        : noBaselineYet
          ? " (no baseline cached — first run, not blocking)"
          : "";
      record(
        "crawler",
        notBlocking ? "warn" : "fail",
        `${fresh.length} NEW crawler findings vs baseline${reason}`,
        fresh
          .slice(0, 10)
          .map((f) => `${f.label || f.category} @ ${f.path}: ${f.summary}`),
      );
    }
    return;
  }

  const networkErrors = (data.networkErrors || []).filter(
    (e) => !isDecorative("networkErrors", e.url, e.path),
  );
  const brokenLinks = (data.brokenLinks || []).filter(
    (e) => !isDecorative("brokenLinks", e.url, e.path),
  );
  const decoCount =
    (data.networkErrors || []).length -
    networkErrors.length +
    ((data.brokenLinks || []).length - brokenLinks.length);
  if (decoCount > 0) {
    record(
      "crawler",
      "info",
      `${decoCount} decorative-resource 4xx finding(s) downgraded (matched crawler-decorative-paths)`,
    );
  }
  const counts = {
    jsErrors: (data.jsErrors || []).length,
    brokenLinks: brokenLinks.length,
    networkErrors: networkErrors.length,
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

// Parse the schemathesis text report's FAILURES section into per-test-case
// blocks and split them into "pre-servlet container rejections" (text/html
// 4xx whose sole finding is an undocumented content-type — rejected below the
// app, not fixable in app code) versus genuinely blocking failures.
// `reconciled` is true only when the parsed block count matches the report's
// own "N failed" total; when it does not, the caller falls back to failing on
// the raw total so a parser drift can never silently suppress real failures.
function classifySchemathesis(out) {
  const failIdx = out.search(/={6,}\s*FAILURES\s*={6,}/);
  const summaryIdx = out.search(/={6,}\s*SUMMARY\s*={6,}/);
  if (failIdx === -1) return { preServlet: 0, blocking: 0, reconciled: false };
  const section = out.slice(
    failIdx,
    summaryIdx === -1 ? out.length : summaryIdx,
  );
  // Blocks are delimited by underscore-ruled headers: "____ GET /path ____".
  const rawBlocks = section.split(/^_{3,}.*_{3,}$/m).slice(1);
  let preServlet = 0;
  let blocking = 0;
  for (const block of rawBlocks) {
    const findingTypes = [...block.matchAll(/^- (.+)$/gm)].map((m) =>
      m[1].trim(),
    );
    if (findingTypes.length === 0) continue;
    const statuses = [...block.matchAll(/^\[(\d{3})\]/gm)].map((m) => m[1]);
    const receivedCTs = [...block.matchAll(/Received:\s*(\S+)/g)].map((m) =>
      m[1].toLowerCase(),
    );
    const onlyContentType = findingTypes.every(
      (f) => f === "Undocumented Content-Type",
    );
    const allHtml =
      receivedCTs.length > 0 &&
      receivedCTs.every((ct) => ct.startsWith("text/html"));
    const all4xx =
      statuses.length > 0 && statuses.every((s) => s.startsWith("4"));
    if (onlyContentType && allHtml && all4xx) preServlet++;
    else blocking++;
  }
  const parsedTotal = preServlet + blocking;
  const totalMatch = out.match(/(\d+)\s+failed/i);
  const reportedTotal = totalMatch ? Number(totalMatch[1]) : -1;
  return {
    preServlet,
    blocking,
    reconciled: parsedTotal > 0 && parsedTotal === reportedTotal,
  };
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
    const total = Number(summaryMatch[1]);
    // An API that documents JSON/problem+json error bodies cannot itself
    // emit a text/html 4xx from a controller — every reachable error path
    // renders structured JSON. So a failure whose ONLY issue is an
    // "Undocumented Content-Type" of text/html on a 4xx is a request that a
    // layer BELOW the app (Tomcat/Jetty connector, nginx, the CDN) rejected
    // before it ever reached a handler — typically the fuzzer's malformed
    // path (control chars, invalid %-encoding) tripping the servlet
    // container's URI parser. These are not app bugs and cannot be fixed in
    // app code; surface them as informational, never blocking. 5xx text/html
    // (e.g. a half-written binary stream) stays blocking. Ref: issue #8/#11.
    const { preServlet, blocking, reconciled } = classifySchemathesis(out);
    if (reconciled && preServlet > 0) {
      if (preServlet > 0) {
        record(
          "schemathesis",
          "info",
          `${preServlet} pre-servlet container rejection(s) (text/html 4xx on malformed input — not app-fixable)`,
        );
      }
      if (blocking > 0) {
        record(
          "schemathesis",
          "fail",
          `schemathesis reported ${blocking} failure(s)`,
        );
      }
      return;
    }
    record("schemathesis", "fail", `schemathesis reported ${total} failure(s)`);
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
  const downgraded = [];
  for (const site of sites) {
    for (const alert of site.alerts || []) {
      if (String(alert.riskcode) === "3") {
        const label = `${alert.name} (${alert.riskdesc || "High"})`;
        if (allInstancesRateLimited(alert)) {
          downgraded.push(label);
        } else {
          highs.push(label);
        }
      }
    }
  }
  if (downgraded.length > 0) {
    record(
      "zap",
      "info",
      `${downgraded.length} HIGH ZAP alert(s) downgraded — every instance on a declared rate-limited/auth-gated path (#7)`,
      downgraded.slice(0, 10),
    );
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

function gateMonkey() {
  if (!ENABLED.monkey) return;
  const path = `${REPORTS}/monkey-findings.json`;
  if (!existsSync(path)) {
    record(
      "monkey",
      "warn",
      "monkey-findings.json missing — monkey step did not run",
    );
    return;
  }
  const data = readJson(path);
  if (!data) {
    record("monkey", "warn", "monkey-findings.json is not valid JSON");
    return;
  }
  const all = data.findings || [];
  const serious = all.filter((f) => f.serious);
  const advisory = all.filter((f) => !f.serious);
  if (advisory.length > 0) {
    record(
      "monkey",
      "info",
      `${advisory.length} non-blocking monkey finding(s) (console errors / failed requests)`,
      advisory
        .slice(0, 10)
        .map(
          (f) =>
            `${f.kind} ×${f.count} @ ${f.where}: ${f.message.slice(0, 120)}`,
        ),
    );
  }
  if (serious.length > 0) {
    record(
      "monkey",
      "fail",
      `${serious.length} serious monkey finding(s) (crashes / uncaught errors / 5xx) — replay with seed ${data.seed}`,
      serious
        .slice(0, 10)
        .map(
          (f) =>
            `${f.kind} ×${f.count} @ ${f.where}: ${f.message.slice(0, 120)}`,
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
gateMonkey();

const lines = ["## AutoQA — final gate\n"];
lines.push(`Event: \`${EVENT_NAME || "local"}\`\n`);
lines.push("| Tool | Gate enabled | Fail on | Status |");
lines.push("|---|---|---|---|");
for (const tool of Object.keys(ENABLED)) {
  if (tool === "baseline") continue;
  const tFindings = findings.filter((f) => f.tool === tool);
  const severityRank = { fail: 3, warn: 2, info: 1 };
  const status =
    tFindings.length === 0
      ? "ok"
      : tFindings.reduce((worst, f) =>
          (severityRank[f.severity] || 0) > (severityRank[worst.severity] || 0)
            ? f
            : worst,
        ).severity;
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
