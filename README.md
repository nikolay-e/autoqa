# AutoQA

Automated post-deploy quality assurance as a reusable GitHub Action.

> **Scope:** AutoQA is the **PR-blocking gate** in a three-layer quality story (gate + synthetic monitoring + real-user monitoring). It is not a replacement for Checkly or Sentry. See [`STRATEGY.md`](STRATEGY.md) for what is in and out of scope.

## Tools

| Tool                          | What it does                                                                                          | Default           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| **Playwright crawler**        | Pages, JS errors, broken links, network errors, axe WCAG2a/2aa, CSP + mixed-content listeners         | on                |
| **Crawler baseline diff**     | Fails PRs only on **new** findings vs the cached `main` baseline                                      | on                |
| **Mechanical checks (M1–M6)** | Deterministic page-content assertions (mojibake, tofu, placeholder/FS-artifact text) on crawled pages | runs on, gate off |
| **Mozilla HTTP Observatory**  | Security-headers grade (CSP, HSTS, X-Frame-Options, SRI…)                                             | off               |
| **Schemathesis**              | Property-based API fuzzing against OpenAPI                                                            | off               |
| **OWASP ZAP**                 | DAST scan against the same OpenAPI spec                                                               | off               |
| **Argos visual regression**   | Screenshots at 1440×900 + 375×667; PR diff review                                                     | off               |
| **AuthZ matrix**              | Two-token BOLA / OWASP API1:2023 check on resource paths                                              | off               |
| **Monkey / chaos**            | Seeded random Playwright clicking/typing for a time budget; hunts crashes, uncaught JS, 5xx           | off               |

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

## Run as a Docker image (any CI)

AutoQA ships as both a GitHub Action **and** a self-contained image, so the same
pipeline runs in GitLab CI, Forgejo/Gitea Actions, Argo Workflows, or plain
`docker run` — anywhere a container runs.

```bash
docker run --rm \
  -e QA_URL=https://your-app.com \
  -e QA_MONKEY_ENABLED=true \
  -v "$PWD/qa-reports:/tmp/qa-reports" \
  ghcr.io/nikolay-e/autoqa:latest
```

The container runs every enabled tool in order and exits **0 (pass) / 1 (fail)** —
the one universal gate signal. Reports land in `QA_OUTPUT_DIR` (default
`/tmp/qa-reports`); mount it to collect artifacts.

**Env interface.** Most GitHub Action inputs map to an env var: `foo-bar` →
`QA_FOO_BAR` (`QA_URL` also accepts the alias `QA_BASE_URL`). Only `QA_URL` is
required; everything else mirrors the [`action.yml`](action.yml) defaults. Common
ones: `QA_URL`, `QA_OUTPUT_DIR`, `QA_CRAWLER_SEED_PAGES`, `QA_CRAWLER_MAX_PAGES`,
`QA_BASELINE_ENABLED`, `QA_SCHEMATHESIS_ENABLED`, `QA_OPENAPI_URL`,
`QA_OBSERVATORY_ENABLED`, `QA_AUTHZ_ENABLED`, `QA_MONKEY_ENABLED`,
`QA_MONKEY_DURATION_MS`, `QA_AUTH_URL` + `QA_AUTH_BODY` (auth),
`QA_CRAWLER_USERNAME` / `QA_CRAWLER_PASSWORD` (form login).

**Running as root (k8s / Argo / `docker run` as root):** set `QA_NO_SANDBOX=true`
so the crawler and monkey launch Chromium with `--no-sandbox --disable-dev-shm-usage`.
Without it, Chromium's sandbox fails as root and both browser tools crash.

**Baseline persistence.** Outside GitHub there is no `actions/cache`; mount a
persistent volume at `QA_BASELINE_DIR` (default `<output>/baseline`) and set
`QA_EVENT_NAME` (`push`/`pull_request`) + `QA_REF_NAME` (branch) so the baseline
seeds on `main` pushes and gates PRs on new findings only.

**ZAP** needs a Docker daemon (it runs the official `zaproxy` container); it is
skipped with a notice when none is available. Mount the host socket
(`-v /var/run/docker.sock:/var/run/docker.sock`, host-path report dir) or use the
GitHub Action path. Every other tool runs fully inside the image.

### CI snippets

```yaml
# GitLab CI
qa:
  image: ghcr.io/nikolay-e/autoqa:latest
  variables: { QA_URL: "https://your-app.com", QA_OUTPUT_DIR: "qa-reports" }
  script: ["/opt/autoqa/scripts/run-all.sh"]
  artifacts: { when: always, paths: ["qa-reports/"] }
```

```yaml
# Forgejo / Gitea Actions
jobs:
  qa:
    runs-on: docker
    container:
      image: ghcr.io/nikolay-e/autoqa:latest
      env: { QA_URL: https://your-app.com, QA_MONKEY_ENABLED: "true" }
    steps:
      - run: /opt/autoqa/scripts/run-all.sh
```

```yaml
# Argo Workflows (Chromium runs as root in-cluster → QA_NO_SANDBOX)
- name: autoqa
  container:
    image: ghcr.io/nikolay-e/autoqa:latest
    env:
      - { name: QA_URL, value: "https://your-app.com" }
      - { name: QA_NO_SANDBOX, value: "true" }
    volumeMounts: [{ name: reports, mountPath: /tmp/qa-reports }]
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
- `mechanical-findings.json` — M1–M6 mechanical property-check findings (P0/P1)
- `crawler-pages.json` — per-page text/structure capture (input to mechanical checks)
- `screenshots/*.png` — visual regression captures
- `schemathesis.txt`, `zap.txt`, `zap-report.json`, `openapi.json` — when enabled

The crawler appends a markdown baseline-diff table to `$GITHUB_STEP_SUMMARY` on every run with baseline diff enabled (the default); the final gate appends its own summary on every run regardless.

## License

MIT
