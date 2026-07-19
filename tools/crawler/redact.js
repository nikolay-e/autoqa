import {
  SECRET_QUERY_PARAM_SET,
  QUERY_SECRET_RE,
  BEARER_SECRET_RE,
} from "../../lib/redact-patterns.mjs";

const TEXT_QUERY_SECRET_RE = QUERY_SECRET_RE;
const TEXT_AUTH_SECRET_RE = BEARER_SECRET_RE;

// For free-form text (console messages, page errors, page URLs used as
// locations): an app that logs its own failed fetch URL or auth header would
// otherwise carry the secret into findings, reports and step summaries.
export function redactTextSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(TEXT_QUERY_SECRET_RE, "$1REDACTED")
    .replace(TEXT_AUTH_SECRET_RE, "$1 REDACTED");
}

export function redactUrlSecrets(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let redacted = false;
  for (const name of parsed.searchParams.keys()) {
    if (SECRET_QUERY_PARAM_SET.has(name.toLowerCase())) {
      parsed.searchParams.set(name, "REDACTED");
      redacted = true;
    }
  }
  return redacted ? parsed.toString() : url;
}
