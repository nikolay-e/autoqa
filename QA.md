# QA — autoqa

Project-specific QA methodology learnings for this repo. Generic patterns live in the global QA skill.

## Applicability matrix

| Standard QA step                    | Applies here? | Notes                                                                                                     |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| CI status / lint                    | ✅            | `gh run list --workflow=ci.yml`                                                                           |
| CD / ArgoCD                         | ❌            | This is a GitHub Action, not a deployed service                                                           |
| K8s logs / events                   | ❌            | No deployment                                                                                             |
| Backend smoke                       | ❌            | No backend                                                                                                |
| Browser QA (Playwright MCP) on prod | ❌            | No deployed UI                                                                                            |
| autoqa self-test                    | ✅            | The action's `ci.yml` runs `uses: ./` against example.com — this IS the autoqa pipeline running on itself |
| SonarCloud                          | ❌            | No project configured for `nikolay-e_autoqa` (verified 2026-05-16)                                        |
| Code review                         | ✅            | `git diff <prev-release>..HEAD`                                                                           |
| Test hygiene                        | n/a           | No unit/integration tests; the self-test job is the integration test                                      |
| Consumer-repo log sweep             | ✅            | MANDATORY — see "Consumer-repo log sweep" below                                                           |

## Consumer-repo log sweep (MANDATORY on every `/qa` autoqa pass)

The autoqa self-test on `example.com` only exercises a narrow happy path (no auth, no OpenAPI, no ZAP, no AuthZ matrix, single seed page). Real defects in autoqa surface in the `post-deploy-qa` jobs of the CONSUMER repos that pin `nikolay-e/autoqa@<sha>` — Cloudflare interactions, login redirects, OpenAPI variants, ZAP container quirks, schemathesis edge cases, etc. A green self-test does NOT mean autoqa is healthy.

**Every `/qa` pass on this repo MUST:**

1. Enumerate every consumer of `nikolay-e/autoqa` via `gh search code 'nikolay-e/autoqa@' --owner nikolay-e --json repository --jq '.[].repository.nameWithOwner' | sort -u`.
2. For each consumer: pull the most recent `post-deploy-qa` (or equivalent) CI log with `gh run list -R <repo> --workflow=ci.yml --limit 5` → `gh run view -R <repo> --job <id> --log`.
3. Grep each log for symptoms that originate in autoqa code (not in the consumer's app):
   - `Permission denied:.*zap-report` → autoqa ZAP container perms
   - `failed to download OpenAPI spec from .+https?://.+https?://` → autoqa URL concatenation bug
   - `QA_AUTH_TOKEN: [a-f0-9]{16,}` → autoqa token-masking bug
   - `Timeout 30000ms exceeded.*networkidle` → autoqa `waitUntil` choice
   - `Auth curl: exit=92` / `RST_STREAM` / `Cloudflare` 403 challenge → autoqa auth-mode fallback
   - Crawler exit 1 + green job conclusion → autoqa gate bug (issue #3 class)
   - `mechanical-checks: .+ findings` flagged on stable copy → mechanical-checks false-positive (autoqa bug)
4. **Every symptom traceable to autoqa is YOUR finding** even when surfaced in a consumer's log. Fix in this repo, push, then bump the pin in every affected consumer per the global skill's "Autoqa Pin Bumping" rule. If it cannot be fixed this session, `gh issue create -R nikolay-e/autoqa` with the consumer-log excerpt as reproduction.
5. Symptoms that are clearly the consumer's app problem (app 5xx, app's OpenAPI invalid, app's CSP headers misconfigured) are NOT autoqa findings — they get reported back to the consumer repo per the normal `/qa` flow, not handled here.

**Do not skip this step because the self-test is green.** The self-test catches autoqa regressions against `example.com`; the consumer sweep catches autoqa regressions against the real-world surface area (Cloudflare, OAuth, SPAs, OpenAPI, etc.) that the self-test cannot cover.

## Self-test target choice

- **Do not use Cloudflare-fronted sites** (`nikolay-eremeev.com`, anything behind Cloudflare bot protection) — Cloudflare returns 403 + a JS challenge to GitHub Actions runner IP ranges. Symptoms: `403` broken links, dozens of `TrustedHTML/TrustedScript` console errors from Cloudflare's challenge JS, CSP violations from the challenge's inline scripts.
- **Use `https://example.com`** for the self-test — IANA-maintained, no bot protection, deterministic 2 axe moderate findings (`landmark-one-main`, `region`) that form a stable baseline.
- Observatory grade `F` on `example.com` is expected — it has no security headers — so the self-test pins `observatory-fail-grade: 'F'`.

## Playwright `waitUntil` choice

- `waitUntil: 'networkidle'` is **unreliable on real sites** (Cloudflare, sites with analytics, websockets, keep-alive connections). It waits for 500ms of zero network activity that may never occur. Symptom: `page.goto: Timeout 30000ms exceeded` on plain pages.
- Use `waitUntil: 'load'` instead. The crawler's existing `await page.waitForTimeout(WAIT_MS)` (default 2000ms) gives SPA hydration time after navigation completes.

## Observatory tool choice

- The npm package `@mdn/mdn-http-observatory` (the only maintained CLI) declares `devEngines` requiring `npm >= 11.8.0`. Node 22.x ships npm 10.x, and Node 25.x locally has npm 11.6.2 — both fail with `EBADDEVENGINES`. `npx --yes` then runs without dependencies and silently exits 1 with no JSON output.
- **Use the hosted v2 API directly** instead: `POST https://observatory-api.mdn.mozilla.net/api/v2/scan?host=<host>` returns `{grade, score, tests_passed, tests_failed, details_url}` in a single round-trip — no install, no engine check. This is what `scripts/run-observatory.sh` does.

## Baseline diff behaviour

- `baseline-diff.mjs` only **exits 1** on `pull_request` events with new findings.
- `push` to `main` always exits 0 and **overwrites** the baseline — by design, since the merge has already happened.
- First push with no prior baseline → all findings are "new" but exit 0 (push event). Baseline gets seeded.
- Switching the self-test target site (e.g., `nikolay-eremeev.com` → `example.com`) appears as "32 fixed, 2 new" on the next push — expected; old findings disappear because they were on the old URL.

## v1 floating tag

- The major-version tag (`v1`) is force-moved on every patch release (`v1.0.0` → `v1.0.1` → …). Consumers writing `uses: nikolay-e/autoqa@v1` get the latest v1.x.
- Tag the immutable semver tag (`v1.0.X`) first, then force-move `v1` to the same commit, then `git push origin v1.0.X v1 --force` (force is only needed for `v1`, never the immutable tag).

## Pre-commit / formatting

- The CI's prettier check runs from repo root (`npx prettier --check "**/*.{js,mjs,json,yml,yaml,md}"`). Locally, run prettier the same way (`npx --prefix tools/crawler prettier --check ...` from repo root) — invoking from `tools/crawler` with `../../` globs confuses `.prettierignore` path matching.
- `.prettierignore` excludes `ANALYSIS_*.md` (transient `/think` artifacts) and `tools/crawler/qa-axe.mjs` (local scratch with creds, gitignored).
- Repo ships **no pre-commit hook**, so prettier violations land on `main` and only surface in CI. Run `npx prettier --write .` locally before committing any `.js/.mjs/.md` edit — the entire lint job is gated on prettier exit 0 and self-test is `needs: lint`, so one stray unformatted file freezes the whole pipeline.

## Composite `continue-on-error: true` and the final gate

- Every tool step in `action.yml` carries `continue-on-error: true` so one tool's crash never silently skips the rest. The cost: each tool's exit code is also swallowed, so a green CI used to ship 200 broken links, ZAP HIGH alerts, or schemathesis 5xx failures (issue #3).
- The fix is **not** to drop `continue-on-error` — that would prevent ZAP from running after a flaky schemathesis call. Instead, `scripts/aggregate-gate.mjs` re-derives pass/fail from the report files in `/tmp/qa-reports/` after all tools have run, and exits 1 when any enabled tool's `*-fail-on-violations` input is true and its report shows blocking content.
- Gates per tool: `crawler` (baseline-diff fresh count on PR, or any finding when baseline-enabled=false), `schemathesis` (schemathesis.txt grep `\d+ failed`), `zap` (`zap-report.json` alerts with `riskcode=3`), `mechanical` (P0 findings; default off — advisory), `observatory` (grade vs `observatory-fail-grade`), `authz` (`authz-matrix.json findings[].issues.length > 0`).
- The gate is the LAST step in the composite, after artifact upload, so reports always upload even when the gate fails.

## CI lint coverage for new scripts

- When adding a new top-level script (e.g., `scripts/foo.mjs`), also add an explicit `node --check scripts/foo.mjs` line to `.github/workflows/ci.yml` `lint` job — prettier check alone won't catch a syntax error. The lint job's syntax-check steps are an opt-in list, not a glob.

## mechanical-checks.mjs M1 regex literal

- The mojibake guard at `scripts/mechanical-checks.mjs:53` uses `/[-ɏ]/` written as two raw Unicode chars (U+0080 .. U+024F) separated by a literal `-` in the source bytes. The U+0080 (PADDING CHARACTER) is invisible in most editors and **gets dropped if you paste the file content through a shell heredoc** — the resulting copy becomes `/[-ɏ]/` which matches only literal hyphen or U+024F. If editing this regex, work with the file via `Edit`/`Read` tools, never via `cat <<EOF`. Validate end-to-end with `node -e 'const re = require("fs").readFileSync("scripts/mechanical-checks.mjs","utf8").match(/return (\/\[.+?\]\/)/)[1]; console.log(eval("("+re+")").test("Ð¡ÐµÑ€Ð³ÐµÐ¹"))'` — should print `true`.
