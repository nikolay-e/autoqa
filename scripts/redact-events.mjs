#!/usr/bin/env node
// Scrubs secrets from the schemathesis --report ndjson events file BEFORE it
// leaves the container (it uploads with the reports artifact / persists on the
// PVC). schemathesis --output-sanitize cleans the human report but NOT the
// transport-level events stream: the raw request Authorization header (the
// live Bearer token) lands there verbatim. Walk every JSON line, redact any
// sensitive-named key's value at any depth, and regex-scrub Bearer/Basic
// tokens and secret query params in remaining strings.
//
// STREAMING: a real run's events file is hundreds of MB (one event per test
// case, 7000+ cases) — readFileSync into one string throws ERR_STRING_TOO_LONG
// past ~512MB. Read line-by-line, write to a temp file, atomically replace.
// Unparseable lines are dropped (never emit a line we could not scrub).
import {
  createReadStream,
  createWriteStream,
  renameSync,
  existsSync,
} from "node:fs";
import { createInterface } from "node:readline";

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

const tmp = `${path}.scrubbed`;
const outStream = createWriteStream(tmp);
const rl = createInterface({
  input: createReadStream(path, "utf8"),
  crlfDelay: Infinity,
});

let kept = 0;
let dropped = 0;
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    outStream.write(JSON.stringify(scrub(JSON.parse(line), false)) + "\n");
    kept++;
  } catch {
    dropped++;
  }
});
rl.on("close", () => {
  outStream.end(() => {
    renameSync(tmp, path);
    console.log(
      `redact-events: scrubbed ${kept} event line(s)` +
        (dropped ? `, dropped ${dropped} unparseable` : ""),
    );
  });
});
rl.on("error", (err) => {
  console.error(`redact-events: read error — ${err.message}`);
  process.exit(1);
});
