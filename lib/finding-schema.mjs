// StandardFinding — the single contract every autoqa tool normalizes into.
//
// Before this existed, aggregate-gate carried one bespoke parser per tool and
// the report was a fragment pile (both tournaments named that failure #1). A
// finding is the unit of the COMPLETE report and the future gate: whatever a
// tool emits, a converter in normalize-findings.mjs turns it into this shape,
// validated here. Dependency-free on purpose — this repo ships as a portable
// image and a composite action; a schema library would be parity tax for a
// one-maintainer tool when the checks are this small.

export const SEVERITIES = ["critical", "high", "medium", "low", "info"];

// MDN HTTP Observatory grade scale, best→worst. Shared by the observatory
// normalizer and the aggregate gate so the scale is defined once node-side.
export const OBSERVATORY_GRADES = "A+ A A- B+ B B- C+ C C- D+ D D- F".split(
  " ",
);

export const CATEGORIES = [
  "accessibility",
  "security",
  "functional",
  "content",
  "api",
  "performance",
  "visual",
  "resilience",
];

const SEVERITY_RANK = Object.fromEntries(
  SEVERITIES.map((s, i) => [s, SEVERITIES.length - i]),
);

export function severityRank(severity) {
  return SEVERITY_RANK[severity] || 0;
}

const AXE_IMPACT_TO_SEVERITY = {
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low",
};

export function severityFromAxeImpact(impact) {
  return AXE_IMPACT_TO_SEVERITY[impact] || "medium";
}

// P0/P1 come from mechanical-checks; http status buckets from network probes.
export function normalizeSeverity(raw) {
  const s = String(raw || "").toLowerCase();
  if (SEVERITIES.includes(s)) return s;
  if (s === "p0") return "high";
  if (s === "p1") return "low";
  if (s === "serious") return "high";
  if (s === "moderate") return "medium";
  if (s === "blocker") return "critical";
  return "medium";
}

const REQUIRED_STRING_FIELDS = ["fingerprint", "severity", "category", "tool"];

// Returns an array of human-readable problems; empty array means valid.
export function validationErrors(finding) {
  const errs = [];
  if (finding === null || typeof finding !== "object") {
    return ["finding is not an object"];
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof finding[field] !== "string" || finding[field].length === 0) {
      errs.push(`missing/empty required string field: ${field}`);
    }
  }
  if (finding.severity && !SEVERITIES.includes(finding.severity)) {
    errs.push(
      `severity "${finding.severity}" not in [${SEVERITIES.join(", ")}]`,
    );
  }
  if (finding.category && !CATEGORIES.includes(finding.category)) {
    errs.push(
      `category "${finding.category}" not in [${CATEGORIES.join(", ")}]`,
    );
  }
  if (finding.evidence !== undefined && !Array.isArray(finding.evidence)) {
    errs.push("evidence must be an array when present");
  }
  return errs;
}

export function isValidFinding(finding) {
  return validationErrors(finding).length === 0;
}

// Fill optional fields so downstream (report, gate) can read them uniformly.
export function makeFinding(partial) {
  return {
    fingerprint: partial.fingerprint,
    tool: partial.tool,
    category: partial.category,
    severity: partial.severity,
    title: partial.title || "",
    url: partial.url || "",
    locator: partial.locator || "",
    evidence: partial.evidence || [],
    repro: partial.repro || "",
    fix_hint: partial.fix_hint || "",
    docs_url: partial.docs_url || "",
    check_version: partial.check_version || "",
  };
}
