#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { dirname } from "node:path";

const FINDINGS_PATH =
  process.env.CRAWL_FINDINGS_PATH || "/tmp/qa-reports/crawler-findings.json";
const BASELINE_DIR = process.env.QA_BASELINE_DIR || "/tmp/qa-reports/baseline";
const BASELINE_PATH = `${BASELINE_DIR}/baseline.json`;
const DIFF_PATH = `${process.env.QA_REPORTS_DIR || "/tmp/qa-reports"}/baseline-diff.json`;
const SUMMARY_PATH = process.env.GITHUB_STEP_SUMMARY || "";
const EVENT_NAME =
  process.env.GITHUB_EVENT_NAME || process.env.QA_EVENT_NAME || "";
const REF_NAME = process.env.GITHUB_REF_NAME || process.env.QA_REF_NAME || "";
const BASE_REF = process.env.GITHUB_BASE_REF || process.env.QA_BASE_REF || "";
const MAIN_BRANCHES = new Set(["main", "master"]);

const CATEGORIES = [
  ["jsErrors", "JS errors", (e) => e.error],
  [
    "axeViolations",
    "A11y violations",
    (e) => `[${e.impact}] ${e.id}: ${e.description}`,
  ],
  ["brokenLinks", "Broken links", (e) => `→ ${e.status}`],
  ["networkErrors", "Network errors", (e) => `${e.status} ${e.url}`],
  ["cspViolations", "CSP violations", (e) => e.message],
  ["mixedContent", "Mixed content", (e) => e.url],
];

function flatten(findings) {
  const out = [];
  for (const [key, label, summarize] of CATEGORIES) {
    for (const item of findings[key] || []) {
      out.push({
        category: key,
        label,
        path: item.path,
        fingerprint: item.fingerprint,
        summary: summarize(item),
      });
    }
  }
  return out;
}

function diff(current, baseline) {
  const baselineFps = new Set((baseline || []).map((f) => f.fingerprint));
  const currentFps = new Set(current.map((f) => f.fingerprint));
  const fresh = current.filter((f) => !baselineFps.has(f.fingerprint));
  const persistent = current.filter((f) => baselineFps.has(f.fingerprint));
  const fixed = (baseline || []).filter((f) => !currentFps.has(f.fingerprint));
  return { fresh, persistent, fixed };
}

function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.label)) map.set(item.label, []);
    map.get(item.label).push(item);
  }
  return map;
}

function renderTable(items, heading) {
  if (items.length === 0) return `### ${heading}\nNone.\n\n`;
  const grouped = groupByCategory(items);
  let md = `### ${heading} (${items.length})\n\n`;
  md += "| Category | Path | Finding |\n|---|---|---|\n";
  for (const [label, list] of grouped) {
    for (const item of list.slice(0, 50)) {
      const summary = (item.summary || "").replace(/\|/g, "\\|").slice(0, 160);
      md += `| ${label} | \`${item.path}\` | ${summary} |\n`;
    }
    if (list.length > 50) {
      md += `| ${label} | … | (${list.length - 50} more) |\n`;
    }
  }
  return md + "\n";
}

function writeSummary(content) {
  if (SUMMARY_PATH) {
    try {
      writeFileSync(SUMMARY_PATH, content, { flag: "a" });
    } catch (err) {
      console.log(`Failed to write step summary: ${err.message}`);
    }
  }
  console.log(content);
}

function main() {
  if (!existsSync(FINDINGS_PATH)) {
    console.log(`No findings at ${FINDINGS_PATH} — skipping baseline diff`);
    return;
  }

  const currentRaw = JSON.parse(readFileSync(FINDINGS_PATH, "utf8"));
  const current = flatten(currentRaw);

  let baseline = null;
  const baselineExists = existsSync(BASELINE_PATH);
  if (baselineExists) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
      if (!Array.isArray(baseline)) baseline = flatten(baseline);
    } catch (err) {
      console.log(`Baseline unreadable (${err.message}) — treating as empty`);
      baseline = [];
    }
  }

  const { fresh, persistent, fixed } = diff(current, baseline);

  const diffReport = {
    eventName: EVENT_NAME,
    refName: REF_NAME,
    baseRef: BASE_REF,
    baselinePresent: baselineExists,
    fresh,
    persistent,
    fixed,
  };
  mkdirSync(dirname(DIFF_PATH), { recursive: true });
  writeFileSync(DIFF_PATH, JSON.stringify(diffReport, null, 2));

  let md = "## AutoQA crawler — baseline diff\n\n";
  md += `Event: \`${EVENT_NAME || "local"}\` · ref: \`${REF_NAME || "?"}\` · baseline: ${baselineExists ? "present" : "absent (first run)"}\n\n`;
  md += `| Status | Count |\n|---|---|\n`;
  md += `| New | **${fresh.length}** |\n`;
  md += `| Persistent | ${persistent.length} |\n`;
  md += `| Fixed | ${fixed.length} |\n\n`;
  md += renderTable(fresh, "New findings");
  if (fixed.length > 0) md += renderTable(fixed, "Fixed findings");
  writeSummary(md);

  const isMainPush = EVENT_NAME === "push" && MAIN_BRANCHES.has(REF_NAME);
  if (isMainPush) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    copyFileSync(FINDINGS_PATH, BASELINE_PATH);
    console.log(`Baseline saved to ${BASELINE_PATH}`);
  }

  if (EVENT_NAME === "pull_request" && fresh.length > 0 && !baselineExists) {
    console.log(
      `No baseline cached (cold cache / first run) — ${fresh.length} finding(s) not treated as new; gate skipped`,
    );
  } else if (EVENT_NAME === "pull_request" && fresh.length > 0) {
    console.error(`FAIL: ${fresh.length} new crawler findings vs baseline`);
    process.exit(1);
  }

  if (!EVENT_NAME && fresh.length > 0 && !baselineExists) {
    console.log(
      `(local run) ${fresh.length} findings — no baseline to compare against`,
    );
  }
}

main();
