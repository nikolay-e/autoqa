#!/usr/bin/env bash
set -euo pipefail

if [ -z "${QA_AUTH_PATH:-}" ] || [ -z "${QA_AUTH_BODY:-}" ]; then
  echo "Skipping auth — QA_AUTH_PATH or QA_AUTH_BODY not set"
  exit 0
fi

if [[ "${QA_AUTH_PATH}" =~ ^https?:// ]]; then
  QA_AUTH_URL="${QA_AUTH_PATH}"
else
  QA_AUTH_URL="${QA_BASE_URL%/}${QA_AUTH_PATH}"
fi

echo "Authenticating against ${QA_AUTH_URL}..."

BASE_ORIGIN=$(echo "${QA_AUTH_URL}" | grep -oE '^https?://[^/]+')

RESPONSE_BODY=$(mktemp)
# Run curl tolerating non-2xx and transport-level failures (Cloudflare/Traefik
# occasionally sends RST_STREAM after the response, surfacing as curl exit 92
# or as a post-body read timeout). The body is already on disk by then —
# success depends on whether we can parse a token, not on curl's exit code.
# Disable set -e for the curl call to guarantee the exit code never propagates.
set +e
HTTP_CODE=$(curl -sS --connect-timeout 15 --max-time 45 --http1.1 \
  -o "${RESPONSE_BODY}" -w "%{http_code}" \
  -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36" \
  -X POST "${QA_AUTH_URL}" \
  -H "Content-Type: application/json" \
  -H "Origin: ${BASE_ORIGIN}" \
  -d "${QA_AUTH_BODY}" 2>/dev/null)
CURL_EXIT=$?
set -e
[ -z "${HTTP_CODE}" ] && HTTP_CODE="000"
echo "Auth curl: exit=${CURL_EXIT}, http_code=${HTTP_CODE}"

set +e
TOKEN=$(python3 -c "import sys,json
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('AccessToken', d.get('access_token', d.get('token', d.get('jwt', '')))))
except Exception:
    print('')" "${RESPONSE_BODY}" 2>/dev/null)
set -e

if [ -z "${TOKEN}" ]; then
  echo "ERROR: Auth failed (HTTP ${HTTP_CODE}, no AccessToken in response)"
  echo "Response body (first 500 bytes):"
  head -c 500 "${RESPONSE_BODY}" || true
  echo
  rm -f "${RESPONSE_BODY}"
  exit 1
fi
rm -f "${RESPONSE_BODY}"

echo "Auth token obtained"

echo "::add-mask::${TOKEN}"

mkdir -p /tmp/qa-reports
echo "${TOKEN}" > /tmp/qa-reports/.auth-token

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "QA_AUTH_TOKEN=${TOKEN}" >> "${GITHUB_ENV}"
fi
