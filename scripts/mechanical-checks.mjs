// Phase 1.5 of the `/qa` Walkthrough Delta Pass.
//
// Reads pages captured by tools/crawler/crawl.js (PAGES_PATH, default
// /tmp/qa-reports/crawler-pages.json) and runs six deterministic
// property checks against user-visible text. Zero false positives by
// construction — these are property checks, NOT LLM rules. They cover
// defect classes vision LLMs are structurally blind to (mojibake,
// adjacent duplicates, filesystem leakage) and run before any vision
// pass so the LLM never wastes attention re-deriving them.
//
// Output: /tmp/qa-reports/mechanical-findings.json with the schema
//   [
//     { check: "M1", path, severity, evidence, sample }
//   ]
//
// Exit code is always 0 — findings are advisory; downstream gates
// (the `/qa` skill, autoqa user) decide what to do with them.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PAGES_PATH =
  process.env.QA_PAGES_PATH || "/tmp/qa-reports/crawler-pages.json";
const OUTPUT_PATH =
  process.env.QA_MECHANICAL_OUTPUT ||
  "/tmp/qa-reports/mechanical-findings.json";

if (!existsSync(PAGES_PATH)) {
  console.log(`mechanical-checks: ${PAGES_PATH} missing — skipping`);
  writeFileSync(OUTPUT_PATH, "[]");
  process.exit(0);
}

const pages = JSON.parse(readFileSync(PAGES_PATH, "utf8"));
const findings = [];

function push(check, path, severity, evidence, sample) {
  findings.push({ check, path, severity, evidence, sample });
}

// M1 — Unicode round-trip.
// Mojibake produced by mis-decoding UTF-8 as Latin-1 then re-encoding
// produces strings like "Ð¡ÐµÑ€Ð³ÐµÐ¹" instead of "Сергей". They are
// ASCII-valid so vision LLMs read them as "text", not "broken text".
// Heuristic: any visible string with ≥3 of the canonical mojibake
// prefix bytes (Ã, Ñ, Ð, Â) AND ≥1 character in the U+0080..U+024F
// range is almost certainly mojibake (FP'd by zero known correct
// strings in any language).
function looksLikeMojibake(s) {
  if (s.length < 3) return false;
  const mojibakePrefixCount = (s.match(/[ÃÑÐÂ]/g) || []).length;
  if (mojibakePrefixCount < 3) return false;
  // Real diacritics rarely cluster this densely; mojibake always does.
  return /[-ɏ]/.test(s);
}

// M2 — Tofu / replacement-glyph runs.
// ≥3 consecutive box / replacement glyphs (□ ▯ ◻ U+FFFD) in user-facing
// text. These appear when a font cannot render a codepoint OR a backend
// dumps unknown chars as placeholders. Real content does not contain runs
// of these glyphs. `#`, `?`, and `_` are intentionally excluded — emphatic
// punctuation ("Sure???"), markdown-ish `###`, fill-in fields ("Date: ____")
// and ASCII rules are all legitimate ASCII runs that would break zero-FP.
const TOFU_RUN = /[□▯◻�]{3,}/;

// M4 — Filesystem-artifact-in-title.
// Track titles dragged from filenames before ID3 tag was read. Heuristic:
// title starts with `<digits><sep>` AND ≥3 siblings in the same list
// share the pattern AND `<digits>` looks like a track number (1-99).
// The "siblings share pattern" guard prevents the rule from flagging
// real numeric-prefix titles (book chapters, etc).
const FS_TITLE_PREFIX = /^(\d{1,2})\s*[-._]\s*\S/;

// M5 — Placeholder regex.
// Verbatim text that should never reach a user screen. Each token
// chosen to be (a) zero collisions with real product copy and (b) a
// known LLM/SDK leakage pattern.
const PLACEHOLDER =
  /\b(lorem ipsum|TODO|FIXME|asdf{2,}|qwerty{2,}|<null>|undefined undefined|\[object Object\])\b/i;

// Word-boundary form of NaN to avoid catching brand names that include
// "Nan" (e.g., place names). Used in M5 only.
const BARE_NAN = /(^|\s)NaN(\s|$|[.,;:!?])/;

for (const page of pages) {
  const {
    path,
    textNodes = [],
    headings = [],
    buttons = [],
    lists = [],
  } = page;
  const allUserText = [...textNodes, ...headings, ...buttons];

  // M1 — Unicode round-trip / mojibake
  for (const t of allUserText) {
    if (looksLikeMojibake(t)) {
      push(
        "M1",
        path,
        "P0",
        "looks like UTF-8 mis-decoded as Latin-1 (mojibake)",
        t.slice(0, 120),
      );
    }
  }

  // M2 — Tofu / replacement glyph runs
  for (const t of allUserText) {
    if (TOFU_RUN.test(t)) {
      push(
        "M2",
        path,
        "P0",
        "≥3 consecutive replacement/placeholder glyphs in visible text",
        t.slice(0, 120),
      );
    }
  }

  // M3 — Adjacent duplicate rows in lists/grids/tables
  for (const list of lists) {
    const items = list.items;
    for (let i = 0; i < items.length - 1; i++) {
      if (items[i] && items[i] === items[i + 1]) {
        push(
          "M3",
          path,
          "P1",
          `adjacent duplicate rows in <${list.selector}> at index ${i}`,
          items[i].slice(0, 120),
        );
        break; // one finding per list — don't spam if the whole list is duped
      }
    }
  }

  // M4 — Filesystem-artifact-in-title (digit-prefix dominates a list)
  for (const list of lists) {
    const items = list.items;
    if (items.length < 4) continue;
    const prefixed = items.filter((it) =>
      FS_TITLE_PREFIX.test(it.split("\n")[0]),
    );
    if (prefixed.length >= 4 && prefixed.length / items.length >= 0.5) {
      push(
        "M4",
        path,
        "P1",
        `≥50% of items in <${list.selector}> start with track-number-like prefix (filename leakage suspected)`,
        prefixed[0].slice(0, 120),
      );
    }
  }

  // M5 — Placeholder regex
  for (const t of allUserText) {
    if (PLACEHOLDER.test(t) || BARE_NAN.test(t)) {
      push(
        "M5",
        path,
        "P0",
        "placeholder / debug token shipped to user-facing UI",
        t.slice(0, 120),
      );
    }
  }

  // M6 — Mutual distinguishability within a list.
  // For each list, if any item appears verbatim ≥3 times, flag.
  // Catches data-layer degeneracy where a missing field collapses N
  // rows to "Unknown / Unknown / 0:00" repeating.
  for (const list of lists) {
    const counts = new Map();
    for (const it of list.items) {
      counts.set(it, (counts.get(it) || 0) + 1);
    }
    for (const [item, count] of counts) {
      if (count >= 3 && item.length >= 2) {
        push(
          "M6",
          path,
          "P1",
          `same exact item appears ${count}× in <${list.selector}> (data degeneracy)`,
          item.slice(0, 120),
        );
        break;
      }
    }
  }
}

writeFileSync(OUTPUT_PATH, JSON.stringify(findings, null, 2));

const bySeverity = findings.reduce((m, f) => {
  m[f.severity] = (m[f.severity] || 0) + 1;
  return m;
}, {});
console.log(
  `mechanical-checks: ${findings.length} findings (P0=${bySeverity.P0 || 0}, P1=${bySeverity.P1 || 0}) → ${OUTPUT_PATH}`,
);

if (findings.length > 0) {
  const byCheck = findings.reduce((m, f) => {
    (m[f.check] = m[f.check] || []).push(f);
    return m;
  }, {});
  for (const [check, list] of Object.entries(byCheck)) {
    console.log(`\n--- ${check} (${list.length}) ---`);
    for (const f of list.slice(0, 5)) {
      console.log(`  [${f.severity}] ${f.path}: ${f.evidence}`);
      console.log(`    sample: ${JSON.stringify(f.sample)}`);
    }
    if (list.length > 5) console.log(`  ... +${list.length - 5} more`);
  }
}
