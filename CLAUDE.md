# autoqa

## Project Overview

Reusable post-deploy QA, distributed two ways from one codebase: a **composite GitHub Action** ([`action.yml`](action.yml)) and a **portable container image** (`ghcr.io/nikolay-e/autoqa`, built from [`Dockerfile`](Dockerfile), orchestrated by [`scripts/run-all.sh`](scripts/run-all.sh)) for GitLab / Forgejo Actions / Argo Workflows / `docker run`. Positioned as the **PR-blocking gate** in a 3-layer quality story (gate + synthetic monitoring + RUM); see [`STRATEGY.md`](STRATEGY.md).

Tools (all optional except crawler + baseline):

1. **Playwright crawler** — BFS page crawl with axe-core (WCAG 2 a/aa), JS errors, broken links, CSP + mixed-content listeners
2. **Crawler baseline diff** — cached on `main`, restored on PRs; fails PRs only on new findings
3. **Mozilla HTTP Observatory** — security-headers grade
4. **Schemathesis** — property-based OpenAPI fuzzing
5. **OWASP ZAP** — DAST against the OpenAPI spec
6. **Argos visual regression** — 1440×900 + 375×667 screenshots, PR diff review
7. **AuthZ matrix** — BOLA / OWASP API1:2023 two-token check
8. **Monkey / chaos** — seeded random Playwright GUI interaction for a time budget; reports crashes / uncaught JS / 5xx

## Tech Stack

- **Crawler / monkey**: Playwright + @axe-core/playwright. Node 22 on the GitHub Action path; the portable image runs Node from `mcr.microsoft.com/playwright:v1.59.1-jammy` (base tag pinned to the `playwright` lockfile version)
- **Node mjs scripts**: baseline diff, AuthZ matrix, mechanical checks, aggregate gate, Playwright auth
- **Schemathesis**: Python pip package
- **ZAP**: Docker image `ghcr.io/zaproxy/zaproxy:stable`
- **Observatory**: `npx @mdn/mdn-http-observatory`
- **Argos**: `npx @argos-ci/cli upload`
- **Action**: GitHub Actions composite action

## Structure

```
autoqa/
├── action.yml                       # Composite GitHub Action (GH-native path)
├── Dockerfile                       # Portable image (Playwright base + python venv)
├── STRATEGY.md                      # In-scope / non-goals positioning
├── tools/crawler/
│   ├── crawl.js                     # Playwright + axe + CSP + screenshots
│   ├── monkey.js                    # seeded chaos/monkey UI fuzzer (Playwright)
│   └── package.json
├── scripts/
│   ├── run-all.sh                   # CI-agnostic orchestrator (image entrypoint)
│   ├── auth.sh                      # Bearer token via /api auth
│   ├── run-schemathesis.sh
│   ├── run-zap.sh
│   ├── run-observatory.sh           # MDN HTTP Observatory
│   ├── auth-playwright.mjs          # Bearer token via Playwright login (Cloudflare/Akamai)
│   ├── baseline-diff.mjs            # Cache-restored diff, fails on new
│   ├── mechanical-checks.mjs        # Mechanical property checks (M1–M6)
│   ├── run-authz-matrix.mjs         # Two-token BOLA check
│   └── aggregate-gate.mjs           # Re-derives pass/fail from reports (gate authority)
└── .github/workflows/ci.yml         # Self-test (lint + self-test + image build/publish)
```

## Development

```bash
# Test crawler locally (no login, public site)
cd tools/crawler && npm install
CRAWL_URL=https://nikolay-eremeev.com CRAWL_MAX_PAGES=5 node crawl.js

# Test baseline diff with a synthetic baseline
echo '[]' > /tmp/qa-reports/baseline/baseline.json
node scripts/baseline-diff.mjs

# Test Observatory locally
QA_BASE_URL=https://nikolay-eremeev.com \
  QA_OBSERVATORY_ENABLED=true \
  QA_OBSERVATORY_FAIL_GRADE=F \
  bash scripts/run-observatory.sh
```

## Reports

All tools write to `/tmp/qa-reports/`:

- `crawler-findings.json` — fingerprinted crawler output
- `baseline/baseline.json` — cached baseline (per consumer repo, per branch)
- `baseline-diff.json` — new / persistent / fixed
- `observatory.json`, `authz-matrix.json`, `monkey-findings.json`
- `mechanical-findings.json`, `crawler-pages.json`
- `screenshots/*.png` for Argos
- `schemathesis.txt`, `zap.txt`, `zap-report.json`, `openapi.json`

## Usage

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://example.com
    crawler-seed-pages: "/,/about,/contact"
```

See [`action.yml`](action.yml) for all inputs and [`README.md`](README.md) for examples with auth, AuthZ matrix, and Argos.
