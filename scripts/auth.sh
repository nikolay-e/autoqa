#!/usr/bin/env bash
set -euo pipefail

if [ -z "${QA_AUTH_URL:-}" ] || [ -z "${QA_AUTH_BODY:-}" ]; then
  echo "Skipping auth — QA_AUTH_URL or QA_AUTH_BODY not set"
  exit 0
fi

echo "Authenticating against ${QA_AUTH_URL}..."

BASE_ORIGIN=$(echo "${QA_AUTH_URL}" | grep -oE '^https?://[^/]+')

RESPONSE_BODY=$(mktemp)
HTTP_CODE=$(curl -sS --max-time 30 -o "${RESPONSE_BODY}" -w "%{http_code}" \
  -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36" \
  -X POST "${QA_AUTH_URL}" \
  -H "Content-Type: application/json" \
  -H "Origin: ${BASE_ORIGIN}" \
  -d "${QA_AUTH_BODY}" || echo "000")

if [ "${HTTP_CODE}" != "200" ] && [ "${HTTP_CODE}" != "201" ]; then
  echo "ERROR: Auth POST returned HTTP ${HTTP_CODE}"
  echo "Response body (first 500 bytes):"
  head -c 500 "${RESPONSE_BODY}" || true
  echo
  rm -f "${RESPONSE_BODY}"
  exit 1
fi

TOKEN=$(python3 -c "import sys,json
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('AccessToken', d.get('access_token', d.get('token', ''))))
except Exception as e:
    sys.stderr.write(f'JSON parse error: {e}\n')
    sys.exit(1)" "${RESPONSE_BODY}")
rm -f "${RESPONSE_BODY}"

if [ -z "${TOKEN}" ]; then
  echo "ERROR: Failed to extract auth token from response"
  exit 1
fi

echo "Auth token obtained"

echo "::add-mask::${TOKEN}"

mkdir -p /tmp/qa-reports
echo "${TOKEN}" > /tmp/qa-reports/.auth-token

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "QA_AUTH_TOKEN=${TOKEN}" >> "${GITHUB_ENV}"
fi
