#!/usr/bin/env node
// Scrubs secrets from the schemathesis --report ndjson events file BEFORE it
// leaves the container (it uploads with the reports artifact / persists on the
// PVC). schemathesis --output-sanitize cleans the human report but NOT the
// transport-level events stream: the raw request Authorization header (the
// live Bearer token) lands there verbatim. Walk every JSON line, redact any
// sensitive-named key's value at any depth, and regex-scrub Bearer/Basic
// tokens and secret query params in remaining strings. Fail-open on unparseable
// lines by dropping them (never emit a line we could not scrub).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const path = process.argv[2] || "/tmp/qa-reports/schemathesis-events.ndjson";
if (!existsSync(path)) process.exit(0);

const SECRET_KEY_RE =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api_key|apikey|token|access_token|refresh_token|id_token|password|passwd|secret|session|sessionid|sid|sig|signature)$/i;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const QUERY_RE =
  /([?&](?:api_key|apikey|access_key|token|access_token|auth_token|refresh_token|id_token|key|secret|password|passwd|auth|authorization|session|session_id|sessionid|sid|sig|signature)=)[^&\s"'`]+/gi;

function scrubString(s) {
  return s.replace(BEARER_RE, "$1 REDACTED").replace(QUERY_RE, "$1REDACTED");
}

function scrub(value, keyIsSecret) {
  if (typeof value === "string")
    return keyIsSecret ? "REDACTED" : scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, keyIsSecret));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = scrub(v, SECRET_KEY_RE.test(k));
    return out;
  }
  return value;
}

const outLines = [];
let dropped = 0;
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    outLines.push(JSON.stringify(scrub(JSON.parse(line), false)));
  } catch {
    dropped++;
  }
}
writeFileSync(path, outLines.join("\n") + (outLines.length ? "\n" : ""));
console.log(
  `redact-events: scrubbed ${outLines.length} event line(s)` +
    (dropped ? `, dropped ${dropped} unparseable` : ""),
);
