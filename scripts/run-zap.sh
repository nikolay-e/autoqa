#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/qa-reports

if [ -z "${QA_BASE_URL:-}" ] || [ ! -f /tmp/qa-reports/openapi.json ]; then
  echo "Skipping ZAP — QA_BASE_URL not set or openapi.json not found"
  echo "Hint: enable Schemathesis first (it downloads the spec) or provide openapi.json manually"
  exit 0
fi

TOKEN="${QA_AUTH_TOKEN:-}"

ZAP_ARGS=(
  -t /zap/wrk/openapi.json
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
docker run --rm \
  -v /tmp/qa-reports:/zap/wrk \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-api-scan.py "${ZAP_ARGS[@]}" 2>&1 | tee /tmp/qa-reports/zap.txt
