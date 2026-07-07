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
