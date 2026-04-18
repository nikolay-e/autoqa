#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/qa-reports

if [ -z "${QA_BASE_URL:-}" ] || [ -z "${QA_OPENAPI_URL:-}" ]; then
  echo "Skipping Schemathesis — QA_BASE_URL or QA_OPENAPI_URL not set"
  exit 0
fi

SPEC_URL="${QA_BASE_URL}${QA_OPENAPI_URL}"
TOKEN="${QA_AUTH_TOKEN:-}"
EXCLUDE_PATHS="${QA_SCHEMATHESIS_EXCLUDE_PATHS:-}"
EXCLUDE_CHECKS="${QA_SCHEMATHESIS_EXCLUDE_CHECKS:-ignored_auth,unsupported_method}"

echo "Downloading OpenAPI spec from ${SPEC_URL}..."

CURL_ARGS=(-sf)
if [ -n "${TOKEN}" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
fi

curl "${CURL_ARGS[@]}" "${SPEC_URL}" -o /tmp/qa-reports/openapi.json

ST_ARGS=(
  run /tmp/qa-reports/openapi.json
  --url "${QA_BASE_URL}"
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
