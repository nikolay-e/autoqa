#!/usr/bin/env node
// Queryable findings warehouse over findings-log.ndjson files emitted by
// aggregate-gate.mjs. Dependency-free by design (same dual-distribution parity
// rule as lib/finding-schema.mjs); volumes are hundreds of rows/day, so the
// store is the NDJSON itself and queries run in-process. For ad-hoc SQL, the
// same files import into sqlite3 in one command (see QA.md).
//
// Usage:
//   node scripts/warehouse.mjs rule-hits       [--days 30] <ndjson...>
//   node scripts/warehouse.mjs fingerprint-age             <ndjson...>
//   node scripts/warehouse.mjs fp-rate         [--days 30] <ndjson...>
import { readFileSync } from "node:fs";
import { GATE_RULES } from "../lib/gate-rules.mjs";

function loadRows(files) {
  const seen = new Set();
  const rows = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        console.error(`skipping unparseable line in ${file}`);
      }
    }
  }
  return rows;
}

function withinDays(row, days) {
  if (!days) return true;
  const ts = Date.parse(row.ts || "");
  return Number.isFinite(ts) && Date.now() - ts <= days * 86400000;
}

function parseArgs(argv) {
  const files = [];
  let days = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") days = Number(argv[++i]) || 0;
    else files.push(argv[i]);
  }
  return { files, days };
}

function table(header, rowsOut) {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rowsOut.map((r) => String(r[i]).length)),
  );
  const fmt = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rowsOut) console.log(fmt(r));
}

function ruleHits(rows, days) {
  const byRule = new Map();
  for (const r of rows) {
    if (r.kind !== "gate" || !r.rule_id || !withinDays(r, days)) continue;
    const entry = byRule.get(r.rule_id) || {
      hits: 0,
      consumers: new Set(),
      last: "",
    };
    entry.hits++;
    entry.consumers.add(r.consumer);
    if (r.ts > entry.last) entry.last = r.ts;
    byRule.set(r.rule_id, entry);
  }
  const out = [];
  for (const [id, meta] of Object.entries(GATE_RULES)) {
    const e = byRule.get(id);
    const overdue = meta.review_by < new Date().toISOString().slice(0, 10);
    const flag =
      !e && overdue
        ? "SILENT+OVERDUE"
        : !e
          ? "silent"
          : overdue
            ? "OVERDUE"
            : "";
    out.push([
      id,
      e ? e.hits : 0,
      e ? [...e.consumers].sort().join(",") : "-",
      e ? e.last.slice(0, 10) : "-",
      meta.review_by,
      flag,
    ]);
  }
  for (const [id, e] of byRule) {
    if (!GATE_RULES[id])
      out.push([
        id,
        e.hits,
        [...e.consumers].join(","),
        e.last.slice(0, 10),
        "-",
        "UNREGISTERED",
      ]);
  }
  out.sort((a, b) => b[1] - a[1]);
  table(["rule_id", "hits", "consumers", "last_hit", "review_by", "flag"], out);
}

function fingerprintAge(rows) {
  const byKey = new Map();
  // Latest run per consumer comes from kind:"run" rows — a fully green run
  // emits no finding rows, and without it a fingerprint fixed by that run
  // would still read as live.
  const latestRun = new Map();
  for (const r of rows) {
    if (r.kind !== "run" && r.kind !== "finding") continue;
    if ((latestRun.get(r.consumer) || "") < r.ts)
      latestRun.set(r.consumer, r.ts);
  }
  for (const r of rows) {
    if (r.kind !== "finding" || !r.fingerprint) continue;
    const key = `${r.consumer} ${r.fingerprint}`;
    const e = byKey.get(key) || {
      consumer: r.consumer,
      fingerprint: r.fingerprint,
      tool: r.tool,
      severity: r.severity,
      first: r.ts,
      last: r.ts,
      runs: 0,
    };
    e.runs++;
    if (r.ts < e.first) e.first = r.ts;
    if (r.ts > e.last) e.last = r.ts;
    byKey.set(key, e);
  }
  const out = [...byKey.values()]
    .map((e) => ({
      ...e,
      live: e.last === latestRun.get(e.consumer),
      ageDays: Math.round(
        (Date.parse(e.last) - Date.parse(e.first)) / 86400000,
      ),
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.ageDays - a.ageDays)
    .slice(0, 40);
  table(
    ["consumer", "tool", "severity", "fingerprint", "age_d", "runs", "live"],
    out.map((e) => [
      e.consumer,
      e.tool,
      e.severity,
      e.fingerprint.slice(0, 16),
      e.ageDays,
      e.runs,
      e.live ? "yes" : "no",
    ]),
  );
}

function fpRate(rows, days) {
  const byTool = new Map();
  for (const r of rows) {
    if (r.kind !== "gate" || !withinDays(r, days)) continue;
    const e = byTool.get(r.tool) || { total: 0, downgraded: 0, blocking: 0 };
    e.total++;
    if (r.rule_id && r.severity === "info") e.downgraded++;
    if (r.blocking) e.blocking++;
    byTool.set(r.tool, e);
  }
  table(
    ["tool", "gate_rows", "rule_downgraded", "blocking", "downgrade_share"],
    [...byTool.entries()].map(([tool, e]) => [
      tool,
      e.total,
      e.downgraded,
      e.blocking,
      e.total ? `${Math.round((100 * e.downgraded) / e.total)}%` : "0%",
    ]),
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const { files, days } = parseArgs(rest);
if (!cmd || files.length === 0) {
  console.error(
    "usage: warehouse.mjs <rule-hits|fingerprint-age|fp-rate> [--days N] <findings-log.ndjson...>",
  );
  process.exit(1);
}
const rows = loadRows(files);
if (cmd === "rule-hits") ruleHits(rows, days);
else if (cmd === "fingerprint-age") fingerprintAge(rows);
else if (cmd === "fp-rate") fpRate(rows, days);
else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
