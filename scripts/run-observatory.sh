#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/qa-reports

if [ "${QA_OBSERVATORY_ENABLED:-false}" != "true" ]; then
  echo "Skipping Observatory — QA_OBSERVATORY_ENABLED != 'true'"
  exit 0
fi

if [ -z "${QA_BASE_URL:-}" ]; then
  echo "Skipping Observatory — QA_BASE_URL not set"
  exit 0
fi

FAIL_GRADE="${QA_OBSERVATORY_FAIL_GRADE:-B}"
HOST=$(echo "${QA_BASE_URL}" | sed -E 's|^https?://||; s|/.*$||')

echo "Running MDN HTTP Observatory scan against ${HOST}..."
echo "Fail threshold: grade below ${FAIL_GRADE}"

OBS_JSON=/tmp/qa-reports/observatory.json
API="https://observatory-api.mdn.mozilla.net/api/v2/scan"

HTTP_CODE=$(curl -sS -o "${OBS_JSON}" -w '%{http_code}' \
  -X POST "${API}?host=${HOST}" \
  -H 'Accept: application/json' || echo "000")

if [ "${HTTP_CODE}" != "200" ]; then
  echo "Observatory API returned HTTP ${HTTP_CODE}"
  cat "${OBS_JSON}" 2>/dev/null || true
  echo "Treating as non-fatal — Observatory hosted service may be unavailable"
  # Marker so the gate can say "not covered" instead of silently passing —
  # observatory.json may exist (error payload) and read as "ran". Same
  # green-vs-unverified distinction as zap-skipped.txt (issue #31).
  echo "Observatory API HTTP ${HTTP_CODE}" > /tmp/qa-reports/observatory-skipped.txt
  rm -f "${OBS_JSON}"
  exit 0
fi

GRADE=$(python3 -c "import json; print(json.load(open('${OBS_JSON}')).get('grade',''))")
SCORE=$(python3 -c "import json; print(json.load(open('${OBS_JSON}')).get('score',''))")
PASSED=$(python3 -c "import json; print(json.load(open('${OBS_JSON}')).get('tests_passed',''))")
FAILED=$(python3 -c "import json; print(json.load(open('${OBS_JSON}')).get('tests_failed',''))")

echo "Grade: ${GRADE} · Score: ${SCORE} · Tests: ${PASSED} passed / ${FAILED} failed"

if [ -z "${GRADE}" ]; then
  echo "Observatory returned no grade (scan pending or unexpected payload)"
  echo "Treating as non-fatal — not failing the gate on a missing grade"
  echo "no grade in Observatory response (scan pending / unexpected payload)" > /tmp/qa-reports/observatory-skipped.txt
  exit 0
fi

rm -f /tmp/qa-reports/observatory-skipped.txt

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo ""
    echo "## AutoQA MDN HTTP Observatory"
    echo ""
    echo "Host: \`${HOST}\` · Grade: **${GRADE}** · Score: ${SCORE} · Threshold: ${FAIL_GRADE}"
    echo ""
    echo "Tests: ${PASSED} passed / ${FAILED} failed"
    echo ""
    DETAILS_URL=$(python3 -c "import json; print(json.load(open('${OBS_JSON}')).get('details_url',''))")
    if [ -n "${DETAILS_URL}" ]; then
      echo "[Full report](${DETAILS_URL})"
    fi
  } >> "${GITHUB_STEP_SUMMARY}"
fi

GRADES_ORDER="A+ A A- B+ B B- C+ C C- D+ D D- F"
grade_rank() {
  local g="$1"
  local i=0
  for x in $GRADES_ORDER; do
    if [ "$x" = "$g" ]; then
      echo "$i"
      return
    fi
    i=$((i + 1))
  done
  echo 99
}

CURRENT_RANK=$(grade_rank "${GRADE}")
THRESHOLD_RANK=$(grade_rank "${FAIL_GRADE}")

if [ "${CURRENT_RANK}" -gt "${THRESHOLD_RANK}" ]; then
  echo "FAIL: grade ${GRADE} is worse than threshold ${FAIL_GRADE}"
  exit 1
fi

echo "Observatory: grade ${GRADE} meets threshold ${FAIL_GRADE}"
