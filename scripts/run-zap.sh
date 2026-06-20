#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/qa-reports

if [ -z "${QA_BASE_URL:-}" ] || [ ! -f /tmp/qa-reports/openapi.json ]; then
  echo "Skipping ZAP — QA_BASE_URL not set or openapi.json not found"
  echo "Hint: enable Schemathesis first (it downloads the spec) or provide openapi.json manually"
  exit 0
fi

TOKEN="${QA_AUTH_TOKEN:-}"

# ZAP's OpenAPI importer aborts with "Unable to obtain any server URL from the
# definition" when the spec's `servers` is empty or relative (e.g. `[{"url":"/"}]`).
# Always rewrite to an absolute URL — schemathesis already does the same via --url.
# Falls back to QA_BASE_URL when QA_SCHEMATHESIS_BASE_URL is not set. Ref: issue #6.
ZAP_TARGET_URL="${QA_SCHEMATHESIS_BASE_URL:-${QA_BASE_URL}}"
ZAP_TARGET_URL="${ZAP_TARGET_URL%/}"
if command -v jq >/dev/null 2>&1; then
  jq --arg u "${ZAP_TARGET_URL}" '.servers = [{"url": $u}]' \
    /tmp/qa-reports/openapi.json > /tmp/qa-reports/openapi-zap.json
  ZAP_SPEC="/zap/wrk/openapi-zap.json"
else
  echo "warning: jq missing — passing original spec; ZAP may fail on relative servers"
  ZAP_SPEC="/zap/wrk/openapi.json"
fi

ZAP_ARGS=(
  -t "${ZAP_SPEC}"
  -f openapi
  -I
  -J /zap/wrk/zap-report.json
)

if [ -n "${TOKEN}" ]; then
  ZAP_ARGS+=(-z "-config replacer.full_list(0).enabled=true \
    -config replacer.full_list(0).matchtype=REQ_HEADER \
    -config replacer.full_list(0).matchstr=Authorization \
    -config replacer.full_list(0).replacement=\"Bearer ${TOKEN}\"")
fi

echo "Running OWASP ZAP..."
# ZAP image runs as uid 1000; GitHub runner workspace is owned by uid 1001.
# Make /tmp/qa-reports world-writable so ZAP can drop zap-report.json there.
chmod 777 /tmp/qa-reports
docker run --rm \
  -v /tmp/qa-reports:/zap/wrk \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py "${ZAP_ARGS[@]}" 2>&1 | tee /tmp/qa-reports/zap.txt
