# autoqa

## Project Overview

Reusable GitHub Action for automated post-deploy QA. Three tools in one action:

1. **Playwright Crawler** — BFS page crawl with axe-core accessibility (WCAG2a/2aa), JS error detection, broken links
2. **Schemathesis** — Property-based API fuzzing against OpenAPI spec
3. **OWASP ZAP** — Dynamic security scanning against OpenAPI spec

Each tool is optional — enable via action inputs.

## Tech Stack

- **Crawler**: Node.js, Playwright, @axe-core/playwright
- **Schemathesis**: Python pip package
- **ZAP**: Docker image `ghcr.io/zaproxy/zaproxy:stable`
- **Action**: GitHub Actions composite action

## Structure

```
autoqa/
├── action.yml              # Composite GitHub Action definition
├── tools/crawler/          # Playwright + axe-core crawler
│   ├── crawl.js
│   └── package.json
├── scripts/                # Shell wrappers for each tool
│   ├── auth.sh
│   ├── run-schemathesis.sh
│   └── run-zap.sh
└── .github/workflows/
    └── ci.yml              # Self-test
```

## Development

```bash
# Test crawler locally (no login, public site)
cd tools/crawler && npm install
CRAWL_URL=https://nikolay-eremeev.com CRAWL_MAX_PAGES=5 node crawl.js
```

## Usage

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://example.com
    crawler-seed-pages: '/,/about,/contact'
```

See `action.yml` for all inputs.
