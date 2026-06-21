# AutoQA — Strategy

## Elevator pitch

AutoQA is the **PR-blocking gate** in a three-layer quality story:

| Layer                    | What it answers                          | Tool                        |
| ------------------------ | ---------------------------------------- | --------------------------- |
| **Gate** (this project)  | "Did the change introduce a new defect?" | `nikolay-e/autoqa`          |
| **Synthetic monitoring** | "Is the site up right now from $REGION?" | Checkly, Datadog Synthetics |
| **Real-user monitoring** | "What broke for an actual user?"         | Sentry, PostHog             |

If you only run a gate, you find regressions but miss outages. If you only run synthetics, you find outages but ship regressions. AutoQA owns the first layer — nothing else.

## Mission

Make post-deploy regression detection a single composite GitHub Action — **and a portable container image** that runs the same pipeline in any CI (GitLab, Forgejo/Gitea Actions, Argo Workflows, plain `docker run`) — that one engineer can adopt in fifteen minutes and trust to fail the build only on **new** problems, never on background noise.

## In scope

- Playwright crawler with axe-core (WCAG 2 a/aa), JS errors, broken links, CSP / mixed-content listeners
- Schemathesis property-based OpenAPI fuzzing
- OWASP ZAP DAST against the same OpenAPI
- MDN HTTP Observatory security-headers scan
- Visual regression via Argos (screenshots at 1440×900 and 375×667)
- AuthZ two-token matrix for BOLA (OWASP API1:2023) on caller-supplied resource paths
- Baseline diff: cached on `main`, restored on PRs, fail only on **new** findings
- Monkey / chaos UI tester: **seeded** (reproducible) random Playwright interaction for a time budget, hunting crashes / uncaught JS / 5xx — opt-in, advisory by default

## Non-goals

The following are explicitly out of scope. Use the linked tool instead:

| Need                                                 | Use this                                                                                                             | Why not AutoQA                                                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Continuous uptime monitoring from multiple regions   | [Checkly](https://www.checklyhq.com/), [Datadog Synthetics](https://www.datadoghq.com/product/synthetic-monitoring/) | A CI gate fires once per deploy; synthetics fire every minute.                                                                                                                  |
| Real-user JavaScript-error capture with stack traces | [Sentry](https://sentry.io/)                                                                                         | Real users hit code paths a crawler never reaches.                                                                                                                              |
| Core Web Vitals as a pass/fail gate                  | [CrUX](https://developer.chrome.com/docs/crux) / RUM                                                                 | Lab CWV on a shared GitHub runner against a CDN measures jitter, not code ([Lighthouse variability](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md)). |
| WARP-gated / private services                        | (run from inside the network)                                                                                        | The hosted GitHub runner cannot reach them.                                                                                                                                     |
| Load and capacity testing                            | [k6 Cloud](https://k6.io/cloud/), [Artillery](https://artillery.io/)                                                 | A single CI runner caps around 1–2 k RPS — not a real load test.                                                                                                                |
| Mutation testing of frontend code                    | [Stryker](https://stryker-mutator.io/)                                                                               | Hours of runtime — wrong tool for a post-deploy gate.                                                                                                                           |
| LLM-driven autonomous exploratory testing            | [browser-use](https://github.com/browser-use/browser-use)                                                            | Non-deterministic and slow; the **seeded** monkey/chaos tester covers the random-interaction niche reproducibly, and the BFS crawler covers reachable surface.                  |

## Success metrics

1. **Trust the gate**: a failing AutoQA run must always represent a real new finding. Every tool step runs under `continue-on-error: true` so one tool's crash never skips the rest; a single final `aggregate-gate` step then re-derives pass/fail from the report files and is the only step that can fail the build.
2. **Adoption friction**: a downstream repo can enable AutoQA with one `uses:` line and one input (`url:`); every other input is opt-in.
3. **Signal-to-noise**: on a PR with no regressions, baseline diff reports zero new findings.
4. **Runtime**: full default run (crawler + baseline diff) completes within 5 minutes for a 10-page seed list.

## Roadmap

- **Now (shipped):** baseline diff, Mozilla Observatory, CSP + mixed-content listeners, Argos screenshots, AuthZ matrix, seeded monkey/chaos UI tester, portable container image (`ghcr.io/nikolay-e/autoqa`) for non-GitHub CI
- **Next:** sitemap-driven seed discovery, SPA route capture via `framenavigated`, sticky PR comment with diff summary
- **Maybe:** Playwright project matrix (chromium + webkit + mobile-chrome) gated behind a `browsers:` input

## Adjacent tools — when to reach for them instead of AutoQA

| If you want…                     | Reach for                                                                                       | Notes                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| API security beyond Schemathesis | [Akto OSS](https://github.com/akto-api-security/akto)                                           | Heavier (dashboard + Mongo), 1000+ tests including BOLA                                |
| Visual regression for Storybook  | [Lost Pixel](https://github.com/lost-pixel/lost-pixel), [Chromatic](https://www.chromatic.com/) | Argos here is for deployed-URL screenshots                                             |
| CVE / misconfig sweep            | [Nuclei](https://github.com/projectdiscovery/nuclei)                                            | Pattern-matcher; templates skew WordPress/PHP — low signal on small Node/Svelte stacks |
| SBOM-vs-running-image            | [Syft](https://github.com/anchore/syft) + [Grype](https://github.com/anchore/grype)             | Runs against the deployed container, not from a CI gate                                |
