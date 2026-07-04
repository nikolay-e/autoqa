#!/usr/bin/env node
// Always-on COMPLETE QA report. Consumes the normalized findings.json (the
// StandardFinding backbone) plus run context and emits qa-report.md +
// qa-report.json — the single human+machine deliverable both tournaments
// named as the missing piece. This NEVER sets a non-zero exit code: the gate
// (aggregate-gate.mjs) stays the sole pass/fail authority; this is the story
// a QA team reads, not the verdict.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES } from "../lib/finding-schema.mjs";

const REPORTS =
  process.env.QA_REPORTS_DIR || process.env.QA_OUTPUT_DIR || "/tmp/qa-reports";
const MD_PATH = join(REPORTS, "qa-report.md");
const JSON_PATH = join(REPORTS, "qa-report.json");
const STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY || "";

function readJson(name) {
  const path = join(REPORTS, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const findings = readJson("findings.json") || [];
const crawler = readJson("crawler-findings.json");

// A tool is "run" if its artifact is present; "available but off" otherwise.
const TOOLS = [
  [
    "Crawler + axe (a11y, JS, links, CSP)",
    existsSync(join(REPORTS, "crawler-findings.json")),
  ],
  [
    "Mechanical content checks (M1–M6)",
    existsSync(join(REPORTS, "mechanical-findings.json")),
  ],
  [
    "Schemathesis (API property fuzzing)",
    existsSync(join(REPORTS, "schemathesis.txt")),
  ],
  ["OWASP ZAP (DAST)", existsSync(join(REPORTS, "zap-report.json"))],
  ["MDN Observatory (headers)", existsSync(join(REPORTS, "observatory.json"))],
  ["AuthZ matrix (BOLA)", existsSync(join(REPORTS, "authz-matrix.json"))],
  ["Monkey (chaos UI)", existsSync(join(REPORTS, "monkey-findings.json"))],
];

const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, []]));
for (const f of findings) (bySeverity[f.severity] || bySeverity.info).push(f);

const counts = Object.fromEntries(
  SEVERITIES.map((s) => [s, bySeverity[s].length]),
);
const total = findings.length;

const NOW = process.env.QA_REPORT_TIMESTAMP || "";
const TARGET =
  process.env.QA_URL || process.env.QA_BASE_URL || process.env.CRAWL_URL || "";
const COMMIT = process.env.COMMIT_SHA || process.env.GITHUB_SHA || "";

function severityBadge(s) {
  return (
    { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" }[s] ||
    "⚪"
  );
}

function esc(text) {
  return String(text || "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

const lines = [];
lines.push("# AutoQA — complete report\n");
lines.push(
  `**Target:** ${TARGET || "(unknown)"}${COMMIT ? ` · **commit:** \`${COMMIT.slice(0, 12)}\`` : ""}${NOW ? ` · ${NOW}` : ""}\n`,
);

lines.push("## Executive summary\n");
lines.push(`${total} finding(s) across the tested surface.\n`);
lines.push("| Severity | Count |");
lines.push("|---|---|");
for (const s of SEVERITIES) {
  lines.push(`| ${severityBadge(s)} ${s} | ${counts[s]} |`);
}
lines.push("");

const blockingish = counts.critical + counts.high;
lines.push(
  blockingish > 0
    ? `**Assessment:** ${blockingish} high-or-critical finding(s) warrant attention before this is considered clean.\n`
    : "**Assessment:** no high or critical findings on the tested surface.\n",
);

lines.push("## Scope & coverage\n");
if (crawler) lines.push(`Pages crawled: **${crawler.pagesVisited ?? "?"}**.\n`);
lines.push("| Discipline | Ran |");
lines.push("|---|---|");
for (const [name, ran] of TOOLS) {
  lines.push(`| ${name} | ${ran ? "✅" : "— (off)"} |`);
}
lines.push("");
lines.push(
  "**Not covered** (by design — see STRATEGY.md): load/capacity, stateful business flows requiring fixtures, WARP-gated internal services, real-user monitoring. This is a black-box post-deploy surface sweep, not a full QA department.\n",
);

lines.push("## Findings by severity\n");
if (total === 0) {
  lines.push("None on the tested surface.\n");
} else {
  for (const s of SEVERITIES) {
    const list = bySeverity[s];
    if (list.length === 0) continue;
    lines.push(`### ${severityBadge(s)} ${s} (${list.length})\n`);
    lines.push("| Tool | Finding | Where | Fix hint |");
    lines.push("|---|---|---|---|");
    for (const f of list.slice(0, 50)) {
      const where = [f.url, f.locator].filter(Boolean).join(" ");
      const hint = f.fix_hint
        ? esc(f.fix_hint).slice(0, 160)
        : f.docs_url
          ? `[docs](${f.docs_url})`
          : "";
      lines.push(
        `| ${f.tool} | ${esc(f.title).slice(0, 160)} | \`${esc(where).slice(0, 80)}\` | ${hint} |`,
      );
    }
    if (list.length > 50) lines.push(`| … | (${list.length - 50} more) | | |`);
    lines.push("");
  }
}

const md = lines.join("\n");
writeFileSync(MD_PATH, md);
writeFileSync(
  JSON_PATH,
  JSON.stringify(
    {
      target: TARGET,
      commit: COMMIT,
      generatedAt: NOW,
      pagesCrawled: crawler?.pagesVisited ?? null,
      counts,
      total,
      coverage: TOOLS.map(([name, ran]) => ({ name, ran })),
      findings,
    },
    null,
    2,
  ),
);

if (STEP_SUMMARY) {
  try {
    writeFileSync(STEP_SUMMARY, md, { flag: "a" });
  } catch {
    /* summary is best-effort */
  }
}

console.log(`qa-report: ${total} finding(s) -> ${MD_PATH}, ${JSON_PATH}`);
