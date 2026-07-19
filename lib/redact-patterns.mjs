// Single source of truth for the secret vocabulary shared by the two redaction
// last-lines-of-defense: the crawler scrubber (tools/crawler/redact.js, which
// keeps live tokens out of findings/reports) and the schemathesis events
// scrubber (scripts/redact-events.mjs, which keeps them out of the ndjson
// transport stream). Kept in one place so the query-param list and the
// Bearer/Basic regex cannot drift between the two channels — drift would let a
// secret leak on whichever channel was not updated. Dependency-free.

export const SECRET_QUERY_PARAMS = [
  "api_key",
  "apikey",
  "access_key",
  "token",
  "access_token",
  "auth_token",
  "refresh_token",
  "id_token",
  "key",
  "secret",
  "password",
  "passwd",
  "auth",
  "authorization",
  "session",
  "session_id",
  "sessionid",
  "sid",
  "sig",
  "signature",
];

export const SECRET_QUERY_PARAM_SET = new Set(SECRET_QUERY_PARAMS);

// Global-flagged regexes are used only via String.prototype.replace, which
// resets lastIndex before and after each call — safe to share instances.
export const BEARER_SECRET_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export const QUERY_SECRET_RE = new RegExp(
  `([?&](?:${SECRET_QUERY_PARAMS.join("|")})=)[^&\\s"'\`]+`,
  "gi",
);
