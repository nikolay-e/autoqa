const SECRET_QUERY_PARAMS = new Set([
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
]);

const TEXT_QUERY_SECRET_RE = new RegExp(
  `([?&](?:${[...SECRET_QUERY_PARAMS].join("|")})=)[^&\\s"'\`]+`,
  "gi",
);
const TEXT_AUTH_SECRET_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

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
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) {
      parsed.searchParams.set(name, "REDACTED");
      redacted = true;
    }
  }
  return redacted ? parsed.toString() : url;
}
