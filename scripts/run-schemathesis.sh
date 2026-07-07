#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/qa-reports

if [ -z "${QA_BASE_URL:-}" ] || [ -z "${QA_OPENAPI_URL:-}" ]; then
  echo "Skipping Schemathesis — QA_BASE_URL or QA_OPENAPI_URL not set"
  exit 0
fi

if [[ "${QA_OPENAPI_URL}" =~ ^https?:// ]]; then
  SPEC_URL="${QA_OPENAPI_URL}"
else
  SPEC_URL="${QA_BASE_URL%/}${QA_OPENAPI_URL}"
fi
TOKEN="${QA_AUTH_TOKEN:-}"
BASIC_USERNAME="${QA_HTTP_BASIC_USERNAME:-}"
BASIC_PASSWORD="${QA_HTTP_BASIC_PASSWORD:-}"
EXCLUDE_PATHS="${QA_SCHEMATHESIS_EXCLUDE_PATHS:-}"
EXCLUDE_CHECKS="${QA_SCHEMATHESIS_EXCLUDE_CHECKS:-ignored_auth,unsupported_method}"

echo "Downloading OpenAPI spec from ${SPEC_URL}..."

CURL_ARGS=(
  -sf --connect-timeout 15 --max-time 60
  -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
)
if [ -n "${TOKEN}" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
elif [ -n "${BASIC_USERNAME}" ] && [ -n "${BASIC_PASSWORD}" ]; then
  CURL_ARGS+=(-u "${BASIC_USERNAME}:${BASIC_PASSWORD}")
fi

# A single transient network blip (edge hiccup, momentary connection reset) shouldn't fail the
# whole schemathesis+ZAP run — retry a few times with a short backoff before giving up.
DOWNLOAD_OK=false
for attempt in 1 2 3; do
  if curl "${CURL_ARGS[@]}" "${SPEC_URL}" -o /tmp/qa-reports/openapi.json; then
    DOWNLOAD_OK=true
    break
  fi
  echo "Attempt ${attempt}/3 failed to download OpenAPI spec from ${SPEC_URL}; retrying in 5s"
  sleep 5
done

if [ "${DOWNLOAD_OK}" != "true" ]; then
  echo "ERROR: failed to download OpenAPI spec from ${SPEC_URL} after 3 attempts"
  rm -f /tmp/qa-reports/openapi.json
  exit 1
fi

ST_BASE_URL="${QA_SCHEMATHESIS_BASE_URL:-${QA_BASE_URL}}"
ST_BASE_URL="${ST_BASE_URL%/}"

ST_ARGS=(
  run /tmp/qa-reports/openapi.json
  --url "${ST_BASE_URL}"
  --checks all
)

# Both auth styles ride the one Authorization header, so they are mutually
# exclusive — a Bearer token (app-level auth) wins over proxy-level Basic.
if [ -n "${TOKEN}" ]; then
  ST_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
elif [ -n "${BASIC_USERNAME}" ] && [ -n "${BASIC_PASSWORD}" ]; then
  BASIC_B64=$(printf '%s:%s' "${BASIC_USERNAME}" "${BASIC_PASSWORD}" | base64 | tr -d '\n')
  ST_ARGS+=(-H "Authorization: Basic ${BASIC_B64}")
fi

# Origin isn't a schema-declared header, so Schemathesis never sends one — any
# app that CSRF/Origin-gates mutating requests before checking auth then 403s
# on every POST/PUT/DELETE the fuzzer sends, masking the real auth/validation
# behavior behind a same-origin check a real browser client always satisfies.
# Send a realistic Origin so negative-auth checks (e.g. missing_required_header)
# exercise actual auth logic instead of universally tripping the CSRF gate.
# An Origin is scheme://host[:port] ONLY — a base URL with a path (e.g.
# https://host/api) is invalid and origin-locked CORS configs reject every
# request with 403 "Invalid CORS request", turning the whole run into noise.
ST_ORIGIN=$(echo "${ST_BASE_URL}" | grep -oE '^https?://[^/]+')
ST_ARGS+=(-H "Origin: ${ST_ORIGIN}")

if [ -n "${EXCLUDE_CHECKS}" ]; then
  ST_ARGS+=(--exclude-checks "${EXCLUDE_CHECKS}")
fi

IFS=',' read -ra PATHS <<< "${EXCLUDE_PATHS}"
for p in "${PATHS[@]}"; do
  p=$(echo "${p}" | xargs)
  if [ -n "${p}" ]; then
    ST_ARGS+=(--exclude-path "${p}")
  fi
done

echo "Running Schemathesis..."
st "${ST_ARGS[@]}" 2>&1 | tee /tmp/qa-reports/schemathesis.txt
