#!/usr/bin/env bash
# CI-agnostic orchestrator for the autoqa image.
#
# Mirrors the step order and per-tool gating of action.yml, but driven entirely
# by QA_* environment variables so it runs in any CI (GitLab, Forgejo Actions,
# Argo Workflows, plain `docker run`, local). Every tool is non-fatal; the final
# aggregate-gate is the only step whose exit code propagates — 0 pass / 1 fail.
#
# Keep this in sync with action.yml (the GitHub-native path). See QA.md.
set -uo pipefail

AUTOQA_HOME="$(cd "$(dirname "$0")/.." && pwd)"

# --- canonical inputs (QA_*), defaults mirror action.yml ----------------------
QA_URL="${QA_URL:-${QA_BASE_URL:-}}"
if [ -z "${QA_URL}" ]; then
  echo "FATAL: QA_URL (or QA_BASE_URL) is required" >&2
  exit 2
fi
export QA_BASE_URL="${QA_URL}"

: "${QA_OUTPUT_DIR:=/tmp/qa-reports}"
: "${QA_NO_SANDBOX:=false}"
export QA_NO_SANDBOX
: "${QA_CRAWLER_ENABLED:=true}"
: "${QA_BASELINE_ENABLED:=true}"
: "${QA_SCHEMATHESIS_ENABLED:=false}"
: "${QA_ZAP_ENABLED:=false}"
: "${QA_OBSERVATORY_ENABLED:=false}"
: "${QA_ARGOS_ENABLED:=false}"
: "${QA_AUTHZ_ENABLED:=false}"
: "${QA_MONKEY_ENABLED:=false}"

: "${QA_AUTH_MODE:=curl}"
: "${QA_CRAWLER_LOGIN_URL:=/login}"
: "${QA_CRAWLER_LOGIN_SELECTOR_USERNAME:=input[type=\"text\"], input[type=\"email\"]}"
: "${QA_CRAWLER_LOGIN_SELECTOR_PASSWORD:=input[type=\"password\"]}"
: "${QA_CRAWLER_LOGIN_SELECTOR_SUBMIT:=button[type=\"submit\"], button}"
: "${QA_CRAWLER_SEED_PAGES:=/}"
: "${QA_CRAWLER_MAX_PAGES:=50}"
: "${QA_CRAWLER_WAIT_MS:=2000}"
: "${QA_CRAWLER_FAIL_ON_VIOLATIONS:=true}"
: "${QA_BASELINE_FAIL_ON_NEW:=false}"
: "${QA_MECHANICAL_FAIL_ON_VIOLATIONS:=false}"
: "${QA_SCHEMATHESIS_FAIL_ON_VIOLATIONS:=true}"
: "${QA_SCHEMATHESIS_EXCLUDE_CHECKS:=ignored_auth,unsupported_method}"
: "${QA_ZAP_FAIL_ON_VIOLATIONS:=true}"
: "${QA_OBSERVATORY_FAIL_GRADE:=B}"
: "${QA_OBSERVATORY_FAIL_ON_VIOLATIONS:=true}"
: "${QA_AUTHZ_FAIL_ON_VIOLATIONS:=true}"
: "${QA_MONKEY_DURATION_MS:=300000}"
: "${QA_MONKEY_SEED:=1337}"
: "${QA_MONKEY_SEED_PAGES:=/}"
: "${QA_MONKEY_AVOID_TEXT:=logout,log out,sign out,signout,delete account,deactivate,remove account}"
: "${QA_MONKEY_FAIL_ON_VIOLATIONS:=false}"
: "${QA_MONKEY_CONSOLE_IGNORE:=${QA_CRAWLER_CONSOLE_IGNORE:-}}"

REPORTS="${QA_OUTPUT_DIR}"
mkdir -p "${REPORTS}/baseline" "${REPORTS}/screenshots"
export QA_REPORTS_DIR="${REPORTS}"

run_tool() {
  local name="$1"
  shift
  echo ""
  echo "==================== ${name} ===================="
  "$@" || echo "(${name} exited non-zero — continuing; the gate re-derives pass/fail)"
}

# --- auth (token shared with schemathesis / zap / authz) ----------------------
if [ -n "${QA_AUTH_URL:-}" ] && [ -n "${QA_AUTH_BODY:-}" ]; then
  GH_ENV_TMP="$(mktemp)"
  export GITHUB_ENV="${GH_ENV_TMP}"
  export QA_AUTH_PATH="${QA_AUTH_URL}"
  if [ "${QA_AUTH_MODE}" = "playwright" ]; then
    export QA_AUTH_API_PATH="${QA_AUTH_URL}"
    export QA_AUTH_LOGIN_PAGE="${QA_AUTH_LOGIN_PAGE:-${QA_CRAWLER_LOGIN_URL}}"
    export QA_AUTH_SELECTOR_USERNAME="${QA_CRAWLER_LOGIN_SELECTOR_USERNAME}"
    export QA_AUTH_SELECTOR_PASSWORD="${QA_CRAWLER_LOGIN_SELECTOR_PASSWORD}"
    export QA_AUTH_SELECTOR_SUBMIT="${QA_CRAWLER_LOGIN_SELECTOR_SUBMIT}"
    run_tool "auth (playwright)" node "${AUTOQA_HOME}/scripts/auth-playwright.mjs"
  else
    run_tool "auth (curl)" bash "${AUTOQA_HOME}/scripts/auth.sh"
  fi
  set -a
  # shellcheck disable=SC1090
  [ -s "${GH_ENV_TMP}" ] && . "${GH_ENV_TMP}"
  set +a
  unset GITHUB_ENV
  rm -f "${GH_ENV_TMP}"
fi

# --- API tools ----------------------------------------------------------------
if [ "${QA_SCHEMATHESIS_ENABLED}" = "true" ]; then
  export QA_OPENAPI_URL="${QA_OPENAPI_URL:-}"
  export QA_SCHEMATHESIS_BASE_URL="${QA_SCHEMATHESIS_BASE_URL:-}"
  export QA_SCHEMATHESIS_EXCLUDE_PATHS="${QA_SCHEMATHESIS_EXCLUDE_PATHS:-}"
  export QA_HTTP_BASIC_USERNAME="${QA_HTTP_BASIC_USERNAME:-}"
  export QA_HTTP_BASIC_PASSWORD="${QA_HTTP_BASIC_PASSWORD:-}"
  run_tool "schemathesis" bash "${AUTOQA_HOME}/scripts/run-schemathesis.sh"
fi

if [ "${QA_ZAP_ENABLED}" = "true" ]; then
  export QA_SCHEMATHESIS_BASE_URL="${QA_SCHEMATHESIS_BASE_URL:-}"
  run_tool "zap" bash "${AUTOQA_HOME}/scripts/run-zap.sh"
fi

if [ "${QA_OBSERVATORY_ENABLED}" = "true" ]; then
  export QA_OBSERVATORY_ENABLED QA_OBSERVATORY_FAIL_GRADE
  run_tool "observatory" bash "${AUTOQA_HOME}/scripts/run-observatory.sh"
fi

# --- crawler + mechanical + baseline ------------------------------------------
if [ "${QA_CRAWLER_ENABLED}" != "false" ]; then
  export CRAWL_URL="${QA_URL}"
  export CRAWL_USERNAME="${QA_CRAWLER_USERNAME:-}"
  export CRAWL_PASSWORD="${QA_CRAWLER_PASSWORD:-}"
  export CRAWL_HTTP_BASIC_USERNAME="${QA_HTTP_BASIC_USERNAME:-}"
  export CRAWL_HTTP_BASIC_PASSWORD="${QA_HTTP_BASIC_PASSWORD:-}"
  export CRAWL_LOGIN_URL="${QA_CRAWLER_LOGIN_URL}"
  export CRAWL_LOGIN_SELECTOR_USERNAME="${QA_CRAWLER_LOGIN_SELECTOR_USERNAME}"
  export CRAWL_LOGIN_SELECTOR_PASSWORD="${QA_CRAWLER_LOGIN_SELECTOR_PASSWORD}"
  export CRAWL_LOGIN_SELECTOR_SUBMIT="${QA_CRAWLER_LOGIN_SELECTOR_SUBMIT}"
  export CRAWL_SEED_PAGES="${QA_CRAWLER_SEED_PAGES}"
  export CRAWL_MAX_PAGES="${QA_CRAWLER_MAX_PAGES}"
  export CRAWL_WAIT_MS="${QA_CRAWLER_WAIT_MS}"
  export CRAWL_EXCLUDE_URLS="${QA_CRAWLER_EXCLUDE_URLS:-}"
  export CRAWL_CONSOLE_IGNORE="${QA_CRAWLER_CONSOLE_IGNORE:-}"
  export CRAWL_ARGOS_ENABLED="${QA_ARGOS_ENABLED}"
  export CRAWL_NO_SANDBOX="${QA_NO_SANDBOX}"
  if [ "${QA_BASELINE_ENABLED}" = "true" ]; then
    export CRAWL_FAIL_ON_VIOLATIONS="false"
  else
    export CRAWL_FAIL_ON_VIOLATIONS="${QA_CRAWLER_FAIL_ON_VIOLATIONS}"
  fi
  export CRAWL_FINDINGS_PATH="${REPORTS}/crawler-findings.json"
  export CRAWL_PAGES_PATH="${REPORTS}/crawler-pages.json"
  export CRAWL_SCREENSHOT_DIR="${REPORTS}/screenshots"
  run_tool "crawler" node "${AUTOQA_HOME}/tools/crawler/crawl.js"

  export QA_PAGES_PATH="${REPORTS}/crawler-pages.json"
  export QA_MECHANICAL_OUTPUT="${REPORTS}/mechanical-findings.json"
  run_tool "mechanical-checks" node "${AUTOQA_HOME}/scripts/mechanical-checks.mjs"

  if [ "${QA_BASELINE_ENABLED}" = "true" ]; then
    export QA_BASELINE_DIR="${QA_BASELINE_DIR:-${REPORTS}/baseline}"
    run_tool "baseline-diff" node "${AUTOQA_HOME}/scripts/baseline-diff.mjs"
  fi

  if [ "${QA_ARGOS_ENABLED}" = "true" ]; then
    if [ -n "${QA_ARGOS_TOKEN:-}" ]; then
      ARGOS_TOKEN="${QA_ARGOS_TOKEN}" run_tool "argos" \
        npx --yes @argos-ci/cli@latest upload "${REPORTS}/screenshots"
    else
      echo "Skipping Argos upload — QA_ARGOS_ENABLED=true but QA_ARGOS_TOKEN is empty"
    fi
  fi
fi

# --- authz + monkey -----------------------------------------------------------
if [ "${QA_AUTHZ_ENABLED}" = "true" ]; then
  export QA_AUTHZ_ENABLED QA_AUTH_PATH="${QA_AUTH_URL:-}"
  export QA_AUTHZ_USER_A_BODY="${QA_AUTHZ_USER_A_BODY:-}"
  export QA_AUTHZ_USER_B_BODY="${QA_AUTHZ_USER_B_BODY:-}"
  export QA_AUTHZ_RESOURCE_PATHS="${QA_AUTHZ_RESOURCE_PATHS:-}"
  run_tool "authz-matrix" node "${AUTOQA_HOME}/scripts/run-authz-matrix.mjs"
fi

if [ "${QA_MONKEY_ENABLED}" = "true" ]; then
  export MONKEY_URL="${QA_URL}"
  export MONKEY_USERNAME="${QA_CRAWLER_USERNAME:-}"
  export MONKEY_PASSWORD="${QA_CRAWLER_PASSWORD:-}"
  export MONKEY_HTTP_BASIC_USERNAME="${QA_HTTP_BASIC_USERNAME:-}"
  export MONKEY_HTTP_BASIC_PASSWORD="${QA_HTTP_BASIC_PASSWORD:-}"
  export MONKEY_LOGIN_URL="${QA_CRAWLER_LOGIN_URL}"
  export MONKEY_LOGIN_SELECTOR_USERNAME="${QA_CRAWLER_LOGIN_SELECTOR_USERNAME}"
  export MONKEY_LOGIN_SELECTOR_PASSWORD="${QA_CRAWLER_LOGIN_SELECTOR_PASSWORD}"
  export MONKEY_LOGIN_SELECTOR_SUBMIT="${QA_CRAWLER_LOGIN_SELECTOR_SUBMIT}"
  export MONKEY_SEED_PAGES="${QA_MONKEY_SEED_PAGES}"
  export MONKEY_DURATION_MS="${QA_MONKEY_DURATION_MS}"
  export MONKEY_SEED="${QA_MONKEY_SEED}"
  export MONKEY_AVOID_TEXT="${QA_MONKEY_AVOID_TEXT}"
  export MONKEY_EXCLUDE_URLS="${QA_MONKEY_EXCLUDE_URLS:-}"
  export MONKEY_CONSOLE_IGNORE="${QA_MONKEY_CONSOLE_IGNORE}"
  export MONKEY_FAIL_ON_VIOLATIONS="${QA_MONKEY_FAIL_ON_VIOLATIONS}"
  export MONKEY_FINDINGS_PATH="${REPORTS}/monkey-findings.json"
  export MONKEY_NO_SANDBOX="${QA_NO_SANDBOX}"
  run_tool "monkey" node "${AUTOQA_HOME}/tools/crawler/monkey.js"
fi

# --- normalize + COMPLETE report (always-on, advisory — never gates) ----------
run_tool "normalize-findings" node "${AUTOQA_HOME}/scripts/normalize-findings.mjs"
run_tool "qa-report" node "${AUTOQA_HOME}/scripts/generate-qa-report.mjs"

# --- final gate (the only step whose exit code propagates) --------------------
echo ""
echo "==================== aggregate-gate ===================="
export QA_GATE_CRAWLER_ENABLED="${QA_CRAWLER_ENABLED}"
export QA_GATE_BASELINE_ENABLED="${QA_BASELINE_ENABLED}"
export QA_GATE_SCHEMATHESIS_ENABLED="${QA_SCHEMATHESIS_ENABLED}"
export QA_GATE_ZAP_ENABLED="${QA_ZAP_ENABLED}"
export QA_GATE_MECHANICAL_ENABLED="${QA_CRAWLER_ENABLED}"
export QA_GATE_OBSERVATORY_ENABLED="${QA_OBSERVATORY_ENABLED}"
export QA_GATE_AUTHZ_ENABLED="${QA_AUTHZ_ENABLED}"
export QA_GATE_MONKEY_ENABLED="${QA_MONKEY_ENABLED}"
if [ "${QA_BASELINE_ENABLED}" = "true" ]; then
  export QA_GATE_CRAWLER_FAIL="true"
else
  export QA_GATE_CRAWLER_FAIL="${QA_CRAWLER_FAIL_ON_VIOLATIONS}"
fi
export QA_GATE_BASELINE_FAIL_ON_NEW="${QA_BASELINE_FAIL_ON_NEW}"
export QA_GATE_CRAWLER_DECORATIVE_PATHS="${QA_CRAWLER_DECORATIVE_PATHS:-}"
export QA_GATE_SCHEMATHESIS_FAIL="${QA_SCHEMATHESIS_FAIL_ON_VIOLATIONS}"
export QA_GATE_ZAP_FAIL="${QA_ZAP_FAIL_ON_VIOLATIONS}"
export QA_GATE_ZAP_RATE_LIMITED_PATHS="${QA_ZAP_RATE_LIMITED_PATHS:-}"
export QA_GATE_MECHANICAL_FAIL="${QA_MECHANICAL_FAIL_ON_VIOLATIONS}"
export QA_GATE_OBSERVATORY_FAIL="${QA_OBSERVATORY_FAIL_ON_VIOLATIONS}"
export QA_GATE_AUTHZ_FAIL="${QA_AUTHZ_FAIL_ON_VIOLATIONS}"
export QA_GATE_MONKEY_FAIL="${QA_MONKEY_FAIL_ON_VIOLATIONS}"

node "${AUTOQA_HOME}/scripts/aggregate-gate.mjs"
