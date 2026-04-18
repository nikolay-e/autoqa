#!/usr/bin/env bash
set -euo pipefail

if [ -z "${QA_AUTH_URL:-}" ] || [ -z "${QA_AUTH_BODY:-}" ]; then
  echo "Skipping auth — QA_AUTH_URL or QA_AUTH_BODY not set"
  exit 0
fi

echo "Authenticating against ${QA_AUTH_URL}..."

TOKEN=$(curl -sf -X POST "${QA_AUTH_URL}" \
  -H "Content-Type: application/json" \
  -d "${QA_AUTH_BODY}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('AccessToken', d.get('access_token', d.get('token', ''))))")

if [ -z "${TOKEN}" ]; then
  echo "ERROR: Failed to obtain auth token"
  exit 1
fi

echo "Auth token obtained"

mkdir -p /tmp/qa-reports
echo "${TOKEN}" > /tmp/qa-reports/.auth-token

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "QA_AUTH_TOKEN=${TOKEN}" >> "${GITHUB_ENV}"
fi
