# AutoQA

Automated post-deploy quality assurance as a reusable GitHub Action.

## Tools

| Tool | What it does | Requires |
|------|-------------|----------|
| **Playwright Crawler** | Crawls pages, checks JS errors, broken links, axe accessibility (WCAG2a/2aa) | Node.js |
| **Schemathesis** | Property-based API fuzzing against OpenAPI spec | Python, OpenAPI spec |
| **OWASP ZAP** | Dynamic security scanning against OpenAPI spec | Docker, OpenAPI spec |

Each tool is optional — enable what you need.

## Quick Start

```yaml
# .github/workflows/post-deploy.yml
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: nikolay-e/autoqa@main
        with:
          url: https://your-app.com
```

## Examples

### Public static site (crawler only)

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://example.com
    crawler-seed-pages: '/,/about,/blog'
    crawler-max-pages: '30'
```

### App with login + API fuzzing + security scan

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://your-app.com
    auth-url: /api/auth/login
    auth-body: '{"username":"test","password":"${{ secrets.QA_PASSWORD }}"}'
    crawler-username: test
    crawler-password: ${{ secrets.QA_PASSWORD }}
    crawler-seed-pages: '/,/dashboard,/settings'
    schemathesis-enabled: 'true'
    openapi-url: /api/openapi.json
    zap-enabled: 'true'
```

## Inputs

See [`action.yml`](action.yml) for all available inputs and their defaults.

## Reports

All tools write reports to `/tmp/qa-reports/` and upload them as the `autoqa-reports` artifact (7-day retention).

## License

MIT
