# AutoQA

Automated post-deploy quality assurance as a reusable GitHub Action.

> **Scope:** AutoQA is the **PR-blocking gate** in a three-layer quality story (gate + synthetic monitoring + real-user monitoring). It is not a replacement for Checkly or Sentry. See [`STRATEGY.md`](STRATEGY.md) for what is in and out of scope.

## Tools

| Tool                         | What it does                                                                  | Default |
| ---------------------------- | ----------------------------------------------------------------------------- | ------- |
| **Playwright crawler**       | Pages, JS errors, broken links, axe WCAG2a/2aa, CSP + mixed-content listeners | on      |
| **Crawler baseline diff**    | Fails PRs only on **new** findings vs the cached `main` baseline              | on      |
| **Mozilla HTTP Observatory** | Security-headers grade (CSP, HSTS, X-Frame-Options, SRI…)                     | off     |
| **Schemathesis**             | Property-based API fuzzing against OpenAPI                                    | off     |
| **OWASP ZAP**                | DAST scan against the same OpenAPI spec                                       | off     |
| **Argos visual regression**  | Screenshots at 1440×900 + 375×667; PR diff review                             | off     |
| **AuthZ matrix**             | Two-token BOLA / OWASP API1:2023 check on resource paths                      | off     |

Everything except the crawler + baseline diff is opt-in.

## Quick start

```yaml
# .github/workflows/post-deploy.yml
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: nikolay-e/autoqa@main
        with:
          url: https://your-app.com
```

On a PR this fails only on **new** axe / JS / broken-link / CSP / mixed-content findings vs the last `main` baseline. On a push to `main` the baseline is overwritten.

## Examples

### Public static site (crawler + Observatory)

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://example.com
    crawler-seed-pages: "/,/about,/blog"
    crawler-max-pages: "30"
    observatory-enabled: "true"
    observatory-fail-grade: "B"
```

### App with login + API fuzzing + ZAP + AuthZ

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://your-app.com
    auth-url: /api/auth/login
    auth-body: '{"username":"test","password":"${{ secrets.QA_PASSWORD_A }}"}'
    crawler-username: test
    crawler-password: ${{ secrets.QA_PASSWORD_A }}
    crawler-seed-pages: "/,/dashboard,/settings"
    schemathesis-enabled: "true"
    openapi-url: /api/openapi.json
    zap-enabled: "true"
    authz-enabled: "true"
    authz-user-a-body: '{"username":"alice","password":"${{ secrets.QA_PASSWORD_A }}"}'
    authz-user-b-body: '{"username":"bob","password":"${{ secrets.QA_PASSWORD_B }}"}'
    authz-resource-paths: "/api/users/me/notes/1,/api/users/me/notes/2"
```

For each `authz-resource-paths` entry the action expects: token A → 2xx, token B → 401/403/404, no token → 401/403/404. Anything else fails the build.

### Visual regression with Argos

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://your-app.com
    argos-enabled: "true"
    argos-token: ${{ secrets.ARGOS_TOKEN }}
```

Create the repo at <https://app.argos-ci.com/> first to obtain `ARGOS_TOKEN`. Free tier covers 5 000 screenshots/month.

### Disable baseline diff (fail on every finding)

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://your-app.com
    baseline-enabled: "false"
```

## Inputs

See [`action.yml`](action.yml) for all inputs and their defaults.

## Reports

All tools write to `/tmp/qa-reports/` and upload as the `autoqa-reports` artifact (7-day retention):

- `crawler-findings.json` — full crawler output with stable fingerprints
- `baseline-diff.json` — new / persistent / fixed summary
- `observatory.json` — Observatory grade + per-test breakdown
- `authz-matrix.json` — per-path A/B/no-auth status codes and issues
- `screenshots/*.png` — visual regression captures
- `schemathesis.txt`, `zap.txt`, `zap-report.json`, `openapi.json` — when enabled

The crawler also appends a markdown diff table to `$GITHUB_STEP_SUMMARY` on every run.

## License

MIT
