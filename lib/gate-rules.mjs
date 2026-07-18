// Registry of every gate-side downgrade/classification rule. Each entry is a
// standing decision to NOT block on a class of findings — an exception that
// must earn its keep. review_by is the date after which a silent rule (zero
// hits in the warehouse) is a removal candidate and a constantly-firing rule
// is a signal that a structural fix (dual vantage, fuzz hygiene) should
// replace the filter. rule ids are written into findings-log.ndjson by
// aggregate-gate.mjs so hit-counts are queryable via scripts/warehouse.mjs.
export const GATE_RULES = {
  "preservlet-4xx-html": {
    created: "2026-06-20",
    ref: "issues #8 #11",
    review_by: "2026-10-01",
    effect:
      "schemathesis text/html 4xx whose only issue is undocumented content-type -> info (pre-servlet container rejection)",
  },
  "cf-edge-transient": {
    created: "2026-07-14",
    ref: "issue #29",
    review_by: "2026-10-01",
    effect:
      "schemathesis block with all-CF-edge statuses and CF body -> info (deploy-window transient)",
  },
  "rfc7807-clean-reject": {
    created: "2026-07-14",
    ref: "issue #30",
    review_by: "2026-10-01",
    effect:
      "schemathesis positive_data_acceptance with structured RFC7807 4xx -> info (semantic validation)",
  },
  "rate-limited-429": {
    created: "2026-07-18",
    ref: "issue #34",
    review_by: "2026-10-18",
    effect:
      "schemathesis block whose every response is 429 -> info (infra limiter, not API contract)",
  },
  "fuzz-read-timeout": {
    created: "2026-07-18",
    ref: "issue #34",
    review_by: "2026-10-18",
    effect:
      "schemathesis errored case matching 'timed out' -> info (self-inflicted fuzz load); re-tighten after fuzz hygiene + internal vantage land",
  },
  "crawler-decorative-paths": {
    created: "2026-06-20",
    ref: "issue #11",
    review_by: "2026-10-01",
    effect:
      "crawler 4xx on consumer-declared decorative paths -> info (expected 404 assets)",
  },
  "zap-rate-limited-paths": {
    created: "2026-06-20",
    ref: "issue #7",
    review_by: "2026-10-01",
    effect:
      "ZAP HIGH alert whose every instance targets consumer-declared rate-limited paths -> info",
  },
  "zap-skipped-no-docker": {
    created: "2026-06-28",
    ref: "issue #31",
    review_by: "2026-10-01",
    effect: "missing zap-report.json with zap-skipped.txt marker -> info",
  },
  "observatory-skipped": {
    created: "2026-07-18",
    ref: "review pass (zap-skipped #31 pattern)",
    review_by: "2027-01-01",
    effect:
      "hosted Observatory API down / no grade -> info marker so green is distinguishable from unverified",
  },
  "baseline-alarm-once": {
    created: "2026-07-04",
    ref: "QA.md baseline design",
    review_by: "2026-12-01",
    effect:
      "NEW crawler findings on main push/schedule -> warn or single-run fail; baseline absorbs next run",
  },
};
