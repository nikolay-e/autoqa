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
EXCLUDE_PATHS="${QA_SCHEMATHESIS_EXCLUDE_PATHS:-}"
EXCLUDE_CHECKS="${QA_SCHEMATHESIS_EXCLUDE_CHECKS:-ignored_auth,unsupported_method}"

echo "Downloading OpenAPI spec from ${SPEC_URL}..."

CURL_ARGS=(
  -sf --connect-timeout 15 --max-time 60
  -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
)
if [ -n "${TOKEN}" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
fi

if ! curl "${CURL_ARGS[@]}" "${SPEC_URL}" -o /tmp/qa-reports/openapi.json; then
  echo "ERROR: failed to download OpenAPI spec from ${SPEC_URL}"
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

if [ -n "${TOKEN}" ]; then
  ST_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
fi

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
