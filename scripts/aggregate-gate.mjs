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

// When the only autoqa runs a consumer ever does are push-to-main post-deploy
// (Argo Workflows, main-only GitHub jobs), the default "baseline updated on
// main push — not blocking" downgrade makes the crawler gate permanently
// vacuous: every regression is absorbed into the baseline in the same run and
// only warns. Opting in makes a NEW finding fail exactly that one run — the
// baseline still updates, so the next run is green (alarm-once semantics).
const BASELINE_FAIL_ON_NEW = flag("QA_GATE_BASELINE_FAIL_ON_NEW", "false");

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
        ["push", "schedule", "workflow_dispatch"].includes(diff.eventName) &&
        ["main", "master"].includes(diff.refName);
      const noBaselineYet = diff.baselinePresent === false;
      const notBlocking =
        (baselineUpdatedOnMainPush && !BASELINE_FAIL_ON_NEW) || noBaselineYet;
      const reason = noBaselineYet
        ? " (no baseline cached — first run, not blocking)"
        : baselineUpdatedOnMainPush
          ? notBlocking
            ? " (baseline updated on main push — not blocking)"
            : " (baseline updated — alarms once, absorbed next run)"
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
// Schemathesis 4 prints one "N passed  M failed" line PER PHASE (Examples,
// Coverage, Fuzzing, Stateful). A single .match() takes whichever line comes
// first — under-reporting when a later phase failed more, and going blind
// entirely if an early clean phase prints "0 failed" before a failing one.
// The max across all phase lines is the conservative per-phase worst case.
function maxFailedCount(out) {
  let max = 0;
  for (const m of out.matchAll(/(\d+)\s+failed/gi)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

// Schemathesis 3 printed "N errored"; Schemathesis 4 counts errors only in the
// final ruled line ("== 3 failures, 1 error, 3 warnings in 637.34s =="). Phase
// lines ("🚫 1 error") and section headers are not ruled, so restricting the
// v4 match to ruled lines avoids counting the same error twice or matching
// prose like "Network Error".
function erroredCount(out) {
  const v3 = out.match(/(\d+)\s+errored/i);
  if (v3) return Number(v3[1]);
  for (const line of out.split("\n")) {
    if (!/^={5,}.*={5,}$/.test(line.trim())) continue;
    const m = line.match(/(\d+)\s+errors?\b/i);
    if (m) return Number(m[1]);
  }
  return 0;
}

// The FAILURES section prints one block per failing OPERATION, and the summary's
// "X found Y unique failures" line reports exactly that X. The per-phase "N failed"
// counters cannot reconcile against blocks: an operation failing in two phases is
// merged into one block, and different phases fail different operation sets — the
// per-phase max both over- and under-counts (observed: phases 4/2 vs 5 blocks).
function reportedFailureBlocks(out) {
  const m = out.match(/(\d+)\s+found\s+\d+\s+unique failures/i);
  if (m) return Number(m[1]);
  return maxFailedCount(out);
}

// Cloudflare answers for a dead/rolling origin with its own edge error pages on
// these statuses; a block whose every response is one of them AND whose body is
// identifiably the Cloudflare error page is a deploy-window/load transient, not
// an app bug (issue #29). Origin 5xx (500/501/503 JSON, half-written streams)
// never matches: the body check requires the Cloudflare page.
const CF_EDGE_STATUSES = new Set([
  "502",
  "504",
  "520",
  "521",
  "522",
  "523",
  "524",
  "525",
  "526",
  "527",
  "530",
]);

// A fuzz burst from one egress IP reliably trips aggregate per-IP rate
// limiters (Traefik/nginx middleware). The resulting 429 carries whatever
// body the limiter emits (bare text, no Content-Type), so it leaks through
// content-type/schema-conformance checks as a blocking failure even though
// the app correctly throttled the fuzzer. A block whose EVERY response is
// 429 is rate-limiting, not an API-contract bug (issue #34). Blocks mixing
// 429 with other statuses still block.
function classifySchemathesis(out) {
  const failIdx = out.search(/={6,}\s*FAILURES\s*={6,}/);
  const summaryIdx = out.search(/={6,}\s*SUMMARY\s*={6,}/);
  if (failIdx === -1)
    return {
      preServlet: 0,
      edgeTransient: 0,
      cleanReject: 0,
      rateLimited: 0,
      blocking: 0,
      reconciled: false,
    };
  const section = out.slice(
    failIdx,
    summaryIdx === -1 ? out.length : summaryIdx,
  );
  // Blocks are delimited by underscore-ruled headers: "____ GET /path ____".
  const rawBlocks = section.split(/^_{3,}.*_{3,}$/m).slice(1);
  let preServlet = 0;
  let edgeTransient = 0;
  let cleanReject = 0;
  let rateLimited = 0;
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
    const allCfEdge =
      statuses.length > 0 && statuses.every((s) => CF_EDGE_STATUSES.has(s));
    // Two Cloudflare page shapes: the bare nginx-style page (`<center>cloudflare</center>`)
    // and the branded error page whose `<title>` is "<host> | 502: Bad gateway" — the
    // report often truncates the branded page before the word "cloudflare" appears.
    const cfBody = /cloudflare/i.test(block) || /\|\s*5\d\d:\s/.test(block);
    // positive_data_acceptance on an API that answered a structured RFC7807 4xx is
    // semantic validation the JSON Schema cannot express (unknown-id 400s, cross-field
    // rules) — informational, never blocking (issue #30). 5xx and non-problem bodies
    // (HTML error pages, empty bodies) stay blocking.
    const onlyRejectedValid = findingTypes.every(
      (f) => f === "API rejected schema-compliant request",
    );
    const problemJsonBody = /`\{"type":/.test(block);
    const allRateLimited =
      statuses.length > 0 && statuses.every((s) => s === "429");
    if (allRateLimited) rateLimited++;
    else if (onlyContentType && allHtml && all4xx) preServlet++;
    else if (allCfEdge && cfBody) edgeTransient++;
    else if (onlyRejectedValid && all4xx && problemJsonBody) cleanReject++;
    else blocking++;
  }
  const parsedTotal =
    preServlet + edgeTransient + cleanReject + rateLimited + blocking;
  const reportedTotal = reportedFailureBlocks(out) || -1;
  return {
    preServlet,
    edgeTransient,
    cleanReject,
    rateLimited,
    blocking,
    reconciled: parsedTotal > 0 && parsedTotal === reportedTotal,
  };
}

// The ERRORS section prints one underscore-ruled block per errored operation.
// A client-side read timeout there is the run's own fuzz storm saturating the
// backend (verified: the same endpoint answers in ~150ms outside the burst),
// not an API that never answers — non-blocking transient per issue #34.
// Connection refused/reset/DNS blocks stay blocking: those are origin deaths.
function timeoutErrorCount(out) {
  const errIdx = out.search(/={6,}\s*ERRORS\s*={6,}/);
  if (errIdx === -1) return 0;
  const rest = out.slice(errIdx).split("\n").slice(1);
  const endOffset = rest.findIndex((l) =>
    /^={5,}\s*[A-Z]+\s*={5,}$/.test(l.trim()),
  );
  const section = (endOffset === -1 ? rest : rest.slice(0, endOffset)).join(
    "\n",
  );
  const blocks = section.split(/^_{3,}.*_{3,}$/m).slice(1);
  return blocks.filter((b) => /timed out/i.test(b)).length;
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

  // Schemathesis 4 reports internal/network errors ("🚫 Network Error: read
  // timed out") as "N error(s)" in the final ruled summary line — the v3
  // wording "N errored" is gone, and errors are counted separately from
  // failures, so they must gate even when the failures branch also fires.
  const errors = erroredCount(out);
  if (errors > 0) {
    const timeouts = Math.min(timeoutErrorCount(out), errors);
    const blockingErrors = errors - timeouts;
    if (timeouts > 0) {
      record(
        "schemathesis",
        "info",
        `${timeouts} read-timeout(s) under the run's own fuzz load (self-inflicted transient, non-blocking — re-verify the endpoint outside the burst)`,
      );
    }
    if (blockingErrors > 0) {
      record(
        "schemathesis",
        "fail",
        `schemathesis reported ${blockingErrors} errored case(s) (network errors — the API never answered)`,
      );
    }
  }

  const total = maxFailedCount(out);
  if (total > 0) {
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
    const {
      preServlet,
      edgeTransient,
      cleanReject,
      rateLimited,
      blocking,
      reconciled,
    } = classifySchemathesis(out);
    const reconciledAny =
      preServlet + edgeTransient + cleanReject + rateLimited > 0;
    if (reconciled && reconciledAny) {
      if (preServlet > 0) {
        record(
          "schemathesis",
          "info",
          `${preServlet} pre-servlet container rejection(s) (text/html 4xx on malformed input — not app-fixable)`,
        );
      }
      if (edgeTransient > 0) {
        record(
          "schemathesis",
          "info",
          `${edgeTransient} Cloudflare edge 5xx transient(s) (deploy-window/load — re-verify on the settled origin)`,
        );
      }
      if (cleanReject > 0) {
        record(
          "schemathesis",
          "info",
          `${cleanReject} schema-compliant request(s) rejected with structured RFC7807 4xx (semantic validation the schema cannot express)`,
        );
      }
      if (rateLimited > 0) {
        record(
          "schemathesis",
          "info",
          `${rateLimited} rate-limited operation(s) (all responses 429 — the app throttled the fuzzer, not an API-contract bug)`,
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
  if (errors > 0) return;
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
    // run-zap.sh writes zap-skipped.txt when ZAP physically cannot run
    // (no Docker daemon — the in-cluster/portable-image case). Gating on the
    // never-produced report turned every such run into a permanent blocking
    // fail that masked real findings underneath it. Ref: issue #31.
    if (existsSync(`${REPORTS}/zap-skipped.txt`)) {
      const reason = readFileSync(`${REPORTS}/zap-skipped.txt`, "utf8").trim();
      record(
        "zap",
        "info",
        `ZAP skipped — ${reason}; zap-enabled=true has no effect here (mount a Docker socket, run ZAP via the GitHub Action path, or set zap-enabled=false)`,
      );
      return;
    }
    // run-zap.sh no-ops (exit 0, no zap-report.json) when openapi.json is
    // absent — that happens when schemathesis's spec download failed (or
    // schemathesis-enabled=false). That is a real problem worth surfacing,
    // but it is NOT "ZAP crashed after starting"; conflating the two makes
    // the failure mode harder to diagnose from the gate summary alone.
    // Ref: issue #23.
    if (!existsSync(`${REPORTS}/openapi.json`)) {
      record(
        "zap",
        "fail",
        "zap-report.json missing — ZAP was skipped because openapi.json is unavailable (likely a schemathesis spec-download failure, or schemathesis-enabled=false); check the schemathesis step",
      );
      return;
    }
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
