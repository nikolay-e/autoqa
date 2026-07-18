#!/usr/bin/env node
// Reads every per-tool artifact in QA_REPORTS_DIR and converts it into one
// validated StandardFinding[] at findings.json — the backbone the COMPLETE
// report (and, later, the gate) consumes instead of re-parsing each format.
//
// Two modes:
//   default (lenient): a finding that fails schema validation is warned about
//     and dropped; never affects a consumer's gate. Production-safe.
//   --strict (or QA_FINDINGS_STRICT=true): the first invalid finding exits 1.
//     Used by the self-test so a converter regression fails autoqa's OWN CI —
//     the contract is enforced against fixtures, not against consumers.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  makeFinding,
  validationErrors,
  normalizeSeverity,
  severityFromAxeImpact,
} from "../lib/finding-schema.mjs";

const REPORTS =
  process.env.QA_REPORTS_DIR || process.env.QA_OUTPUT_DIR || "/tmp/qa-reports";
const OUT_PATH = join(REPORTS, "findings.json");
const STRICT =
  process.argv.includes("--strict") ||
  (process.env.QA_FINDINGS_STRICT || "").toLowerCase() === "true";

function readJson(name) {
  const path = join(REPORTS, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.log(`normalize: ${name} unreadable (${err.message}) — skipping`);
    return null;
  }
}

function readText(name) {
  const path = join(REPORTS, name);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function fp(...parts) {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

const converters = [
  function crawler(add) {
    const data = readJson("crawler-findings.json");
    if (!data) return;
    for (const e of data.axeViolations || []) {
      add({
        fingerprint: e.fingerprint || fp("axe", e.id, e.path, e.target),
        tool: "crawler-axe",
        category: "accessibility",
        severity: severityFromAxeImpact(e.impact),
        title: `${e.id}: ${e.description || ""}`.trim(),
        url: e.path,
        locator: e.target || "",
        evidence: [`${e.nodes || 1} node(s) affected`],
        fix_hint: e.failureSummary || "",
        docs_url: e.helpUrl || "",
        check_version: "axe-core",
      });
    }
    for (const e of data.jsErrors || []) {
      add({
        fingerprint: e.fingerprint || fp("js", e.path, e.error),
        tool: "crawler-js",
        category: "functional",
        severity: "high",
        title: "Uncaught JS error",
        url: e.path,
        evidence: [String(e.error || "").slice(0, 300)],
      });
    }
    for (const e of data.networkErrors || []) {
      add({
        fingerprint: e.fingerprint || fp("net", e.path, e.status, e.url),
        tool: "crawler-network",
        category: "functional",
        severity: Number(e.status) >= 500 ? "high" : "medium",
        title: `Subresource ${e.status}`,
        url: e.path,
        evidence: [`${e.status} ${e.url}`],
      });
    }
    for (const e of data.brokenLinks || []) {
      add({
        fingerprint: e.fingerprint || fp("broken", e.path, e.status),
        tool: "crawler-links",
        category: "functional",
        severity: "medium",
        title: `Broken page ${e.status}`,
        url: e.path,
        evidence: [`navigation returned ${e.status}`],
      });
    }
    for (const e of data.cspViolations || []) {
      add({
        fingerprint: e.fingerprint || fp("csp", e.path, e.message),
        tool: "crawler-csp",
        category: "security",
        severity: "medium",
        title: "CSP violation",
        url: e.path,
        evidence: [String(e.message || "").slice(0, 300)],
      });
    }
    for (const e of data.mixedContent || []) {
      add({
        fingerprint: e.fingerprint || fp("mixed", e.path, e.url),
        tool: "crawler-mixed",
        category: "security",
        severity: "high",
        title: "Mixed content on HTTPS page",
        url: e.path,
        evidence: [e.url],
      });
    }
  },

  function mechanical(add) {
    const data = readJson("mechanical-findings.json");
    if (!Array.isArray(data)) return;
    for (const e of data) {
      add({
        fingerprint: fp("mech", e.check, e.path, e.evidence),
        tool: "mechanical",
        category: "content",
        severity: normalizeSeverity(e.severity),
        title: `${e.check}: ${e.evidence || ""}`.trim(),
        url: e.path,
        evidence: [e.sample ? String(e.sample).slice(0, 200) : e.evidence].map(
          String,
        ),
        check_version: e.check,
      });
    }
  },

  function observatory(add) {
    const data = readJson("observatory.json");
    if (!data || !data.grade) return;
    const grade = String(data.grade);
    const rank = "A+ A A- B+ B B- C+ C C- D+ D D- F".split(" ").indexOf(grade);
    const bMinus = "A+ A A- B+ B B- C+ C C- D+ D D- F".split(" ").indexOf("B-");
    if (rank === -1 || rank <= bMinus) return;
    const severity = grade.startsWith("F")
      ? "high"
      : grade.startsWith("D")
        ? "medium"
        : "low";
    add({
      fingerprint: fp("obs", grade),
      tool: "observatory",
      category: "security",
      severity,
      title: `Security-headers grade ${grade}`,
      evidence: [
        `score ${data.score ?? "?"}, ${data.tests_failed ?? "?"} test(s) failed`,
      ],
      docs_url: data.details_url || "",
    });
  },

  // One finding PER OPERATION block so fingerprints survive "one fix — one
  // disappearance" (Phase-5 verification needs per-operation granularity; a
  // single run-wide fingerprint can never disappear incrementally). Falls back
  // to a run-wide count finding when the ruled sections are absent, counting
  // the MAX across phase lines — a leading "0 failed" phase must not mask
  // later failing phases (same bug the gate fixed in maxFailedCount).
  function schemathesis(add) {
    const out = readText("schemathesis.txt");
    if (!out) return;
    let emitted = 0;
    for (const { header, kind } of [
      { header: /={6,}\s*FAILURES\s*={6,}/, kind: "failure" },
      { header: /={6,}\s*ERRORS\s*={6,}/, kind: "error" },
    ]) {
      const idx = out.search(header);
      if (idx === -1) continue;
      const rest = out.slice(idx).split("\n").slice(1);
      const end = rest.findIndex((l) =>
        /^={5,}\s*[A-Z]+\s*={5,}$/.test(l.trim()),
      );
      const section = (end === -1 ? rest : rest.slice(0, end)).join("\n");
      const parts = section.split(/^_{3,}\s*(.+?)\s*_{3,}$/m);
      for (let i = 1; i < parts.length; i += 2) {
        const op = parts[i].trim();
        const block = parts[i + 1] || "";
        const types = [...block.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());
        const klass =
          kind === "error"
            ? /timed out/i.test(block)
              ? "read-timeout"
              : "network-error"
            : types[0] || "failure";
        add({
          fingerprint: fp("schemathesis", op, kind, klass),
          tool: "schemathesis",
          category: "api",
          severity: klass === "read-timeout" ? "medium" : "high",
          title: `${op}: ${klass}`,
          url: op.split(/\s+/)[1] || "",
          evidence: block
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 6),
        });
        emitted++;
      }
    }
    if (emitted > 0) return;
    let maxFailed = 0;
    for (const m of out.matchAll(/(\d+)\s+failed/gi))
      maxFailed = Math.max(maxFailed, Number(m[1]));
    const err = out.match(/(\d+)\s+error(?:ed|s)?\b/i);
    const n = maxFailed || (err && Number(err[1])) || 0;
    if (!n) return;
    add({
      fingerprint: fp("schemathesis", maxFailed ? "failed" : "errored"),
      tool: "schemathesis",
      category: "api",
      severity: "high",
      title: `Schemathesis: ${n} ${maxFailed ? "failed" : "errored"} case(s)`,
      evidence: out
        .split("\n")
        .filter((l) => /^_{3,}|FAILED|Server error|\[\d{3}\]/.test(l))
        .slice(0, 8),
    });
  },

  // One finding per (alert, instance pathname) — a run-wide fp(name,riskcode)
  // collapses distinct endpoints into one fingerprint that only disappears
  // when EVERY endpoint is fixed. Alerts with no instance data keep the
  // alert-level fingerprint (fail-safe, same as gateZap).
  function zap(add) {
    const data = readJson("zap-report.json");
    if (!data) return;
    for (const site of data.site || []) {
      for (const alert of site.alerts || []) {
        const rc = Number(alert.riskcode);
        if (rc < 1) continue;
        const severity = rc >= 3 ? "high" : rc === 2 ? "medium" : "low";
        const title = `${alert.name} (${alert.riskdesc || ""})`.trim();
        const byPath = new Map();
        for (const inst of alert.instances || []) {
          if (!inst.uri) continue;
          let pathname = inst.uri;
          try {
            pathname = new URL(inst.uri).pathname;
          } catch {
            /* keep raw uri */
          }
          if (!byPath.has(pathname)) byPath.set(pathname, []);
          byPath.get(pathname).push(inst.uri);
        }
        if (byPath.size === 0) {
          add({
            fingerprint: fp("zap", alert.name, alert.riskcode),
            tool: "zap",
            category: "security",
            severity,
            title,
            evidence: [],
          });
          continue;
        }
        for (const [pathname, uris] of [...byPath.entries()].slice(0, 20)) {
          add({
            fingerprint: fp("zap", alert.name, alert.riskcode, pathname),
            tool: "zap",
            category: "security",
            severity,
            title,
            url: pathname,
            evidence: uris.slice(0, 3),
          });
        }
      }
    }
  },

  function authz(add) {
    const data = readJson("authz-matrix.json");
    if (!data) return;
    for (const f of data.findings || []) {
      for (const issue of f.issues || []) {
        const critical = issue.kind === "bola" || issue.kind === "auth-bypass";
        add({
          fingerprint: fp("authz", f.path, issue.kind),
          tool: "authz",
          category: "security",
          severity: critical ? "critical" : "high",
          title: `AuthZ ${issue.kind}`,
          url: f.path,
          evidence: [
            issue.detail || "",
            `A:${f.userA} B:${f.userB} none:${f.noAuth}`,
          ].filter(Boolean),
        });
      }
    }
  },

  function monkey(add) {
    const data = readJson("monkey-findings.json");
    if (!data) return;
    for (const f of data.findings || []) {
      add({
        fingerprint: f.fingerprint || fp("monkey", f.kind, f.where, f.message),
        tool: "monkey",
        category: "functional",
        severity: f.serious ? "high" : "info",
        title: `Monkey ${f.kind} ×${f.count || 1}`,
        url: f.where,
        evidence: [String(f.message || "").slice(0, 200)],
        repro: `replay with MONKEY_SEED=${data.seed}`,
      });
    }
  },

  // Escape hatch: a consumer's own custom checks can drop a JSON array of
  // (partial) StandardFindings at QA_EXTRA_FINDINGS to join the report/gate
  // without forking the core. They pass through the same validation as built-ins.
  function extra(add) {
    const path = process.env.QA_EXTRA_FINDINGS;
    if (!path || !existsSync(path)) return;
    let list;
    try {
      list = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.log(`normalize: QA_EXTRA_FINDINGS unreadable (${err.message})`);
      return;
    }
    for (const f of Array.isArray(list) ? list : []) {
      add({
        ...f,
        fingerprint: f.fingerprint || fp("extra", f.tool, f.title, f.url),
        tool: f.tool || "custom",
      });
    }
  },
];

const findings = [];
let dropped = 0;

function add(partial) {
  const finding = makeFinding(partial);
  const errs = validationErrors(finding);
  if (errs.length > 0) {
    const msg = `normalize: invalid finding from ${partial.tool}: ${errs.join("; ")}`;
    if (STRICT) {
      console.error(msg);
      process.exit(1);
    }
    console.log(msg + " — dropped");
    dropped++;
    return;
  }
  findings.push(finding);
}

for (const convert of converters) {
  try {
    convert(add);
  } catch (err) {
    const msg = `normalize: converter ${convert.name} threw: ${err.message}`;
    if (STRICT) {
      console.error(msg);
      process.exit(1);
    }
    console.log(msg + " — skipped");
  }
}

// Deduplicate by fingerprint (a finding can surface in more than one artifact).
const seen = new Set();
const deduped = findings.filter((f) => {
  if (seen.has(f.fingerprint)) return false;
  seen.add(f.fingerprint);
  return true;
});

writeFileSync(OUT_PATH, JSON.stringify(deduped, null, 2));
console.log(
  `normalize: ${deduped.length} finding(s) -> ${OUT_PATH}` +
    (dropped ? ` (${dropped} dropped as invalid)` : ""),
);
