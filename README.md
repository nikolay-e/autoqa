# AutoQA

Automated post-deploy quality assurance as a reusable GitHub Action.

> **Scope:** AutoQA is the **PR-blocking gate** in a three-layer quality story (gate + synthetic monitoring + real-user monitoring). It is not a replacement for Checkly or Sentry. See [`STRATEGY.md`](STRATEGY.md) for what is in and out of scope.

## Tools

| Tool                         | What it does                                                                                  | Default |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| **Playwright crawler**       | Pages, JS errors, broken links, network errors, axe WCAG2a/2aa, CSP + mixed-content listeners | on      |
| **Crawler baseline diff**    | Fails PRs only on **new** findings vs the cached `main` baseline                              | on      |
| **Mozilla HTTP Observatory** | Security-headers grade (CSP, HSTS, X-Frame-Options, SRI…)                                     | off     |
| **Schemathesis**             | Property-based API fuzzing against OpenAPI                                                    | off     |
| **OWASP ZAP**                | DAST scan against the same OpenAPI spec                                                       | off     |
| **Argos visual regression**  | Screenshots at 1440×900 + 375×667; PR diff review                                             | off     |
| **AuthZ matrix**             | Two-token BOLA / OWASP API1:2023 check on resource paths                                      | off     |
| **Monkey / chaos**           | Seeded random Playwright clicking/typing for a time budget; hunts crashes, uncaught JS, 5xx   | off     |

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

On a PR this fails only on **new** axe / JS / broken-link / network-error / CSP / mixed-content findings vs the last `main` baseline. On a push to `main` the baseline is overwritten. (When the baseline cache is cold — first run or a 7-day cache eviction — findings are not treated as new and the gate is skipped, not failed on the whole inventory.)

## Examples

### Public static site (crawler + Observatory)

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://example.com
    crawler-seed-pages: "/,/about,/blog"
    crawler-max-pages: "30"
    crawler-exclude-urls: "challenges.cloudflare.com,/cdn-cgi/"
    crawler-console-ignore: "font-size:0;color:transparent"
    observatory-enabled: "true"
    observatory-fail-grade: "B"
```

`crawler-exclude-urls` skips matching pages/script sources; `crawler-console-ignore`
drops console messages whose text or originating script URL matches any
comma-separated pattern (e.g. third-party bot-challenge noise).

`crawler-decorative-paths` (e.g. `/Images/`) downgrades 4xx network errors /
broken links on optional decorative assets from a blocking finding to
non-blocking info — for resources that are legitimately absent (404 is the
correct answer, the UI shows a placeholder) and whose per-item ids keep them
from settling into the baseline. Unlike `crawler-exclude-urls` it keeps them
visible in the report instead of dropping them silently.

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

`zap-rate-limited-paths` (e.g. `/api/auth/login`) downgrades a HIGH ZAP alert
from blocking to non-blocking info when **every** instance of that alert targets a
declared rate-limited / auth-gated path. ZAP's traditional report carries no
per-instance HTTP status, so a boolean-based SQLi alert whose differential is
really the limiter's 429/403 (the attack never reached the DB) otherwise reds the
gate. The alert still blocks if it also fires on an un-gated path, and an alert
with no instance data fails safe and stays blocking. Default empty — opt-in.

### Monkey / chaos UI test (try to break it)

```yaml
- uses: nikolay-e/autoqa@main
  with:
    url: https://your-app.com
    monkey-enabled: "true"
    monkey-duration-ms: "300000" # 5 minutes
    crawler-username: test # optional — monkey logs in first
    crawler-password: ${{ secrets.QA_PASSWORD_A }}
    monkey-fail-on-violations: "true" # opt in to blocking on serious findings
```

The monkey drives the real GUI with **seeded** random actions (clicks, fuzz-string
typing, key presses, selects, scrolling, back/forward) for the time budget, then
reports every crash, uncaught JS error, and 5xx it triggered. The run is reproducible:
the same `monkey-seed` replays the same action sequence, and the seed is printed in the
report so a crash can be reproduced. Safety rails keep it useful — it stays on the
app's origin, auto-dismisses dialogs, closes popups, and avoids `monkey-avoid-text`
controls (logout/delete by default) so it does not end the session early. It is
advisory by default; `console.error` and failed requests are always non-blocking info,
and only crashes / uncaught errors / 5xx block the gate (and only when
`monkey-fail-on-violations: "true"`).

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
- `monkey-findings.json` — seed, action count, and deduped chaos findings (when enabled)
- `screenshots/*.png` — visual regression captures
- `schemathesis.txt`, `zap.txt`, `zap-report.json`, `openapi.json` — when enabled

The crawler appends a markdown baseline-diff table to `$GITHUB_STEP_SUMMARY` on every run with baseline diff enabled (the default); the final gate appends its own summary on every run regardless.

## License

MIT
