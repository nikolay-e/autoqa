# QA — autoqa

Project-specific QA methodology learnings for this repo. Generic patterns live in the `/qa` skill.

> **Producer/consumer split:** this repo is the PRODUCER of the autoqa action. The
> `/qa` skill's **Autoqa Pin Bumping** rule is the CONSUMER side (bump the pinned
> SHA in every repo that `uses: nikolay-e/autoqa@<sha>`). They are complementary —
> fix the action here, then bump consumers there. See "Consumer-repo log sweep".

## Applicability matrix

| Standard QA step                    | Applies here? | Notes                                                                                                     |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| CI status / lint                    | ✅            | `gh run list --workflow=ci.yml`                                                                           |
| CD / ArgoCD                         | ❌            | This is a GitHub Action, not a deployed service                                                           |
| K8s logs / events                   | ❌            | No deployment                                                                                             |
| Backend smoke                       | ❌            | No backend                                                                                                |
| Browser QA (Playwright MCP) on prod | ❌            | No deployed UI                                                                                            |
| autoqa self-test                    | ✅            | The action's `ci.yml` runs `uses: ./` against example.com — this IS the autoqa pipeline running on itself |
| SonarCloud                          | ❌            | No project configured for `nikolay-e_autoqa`                                                              |
| Code review                         | ✅            | `git diff <prev-release>..HEAD`                                                                           |
| Test hygiene                        | n/a           | No unit/integration tests; the self-test job is the integration test                                      |
| Consumer-repo log sweep             | ✅            | MANDATORY — see "Consumer-repo log sweep" below                                                           |

## Consumer-repo log sweep (MANDATORY on every `/qa` autoqa pass)

The autoqa self-test on `example.com` only exercises a narrow happy path (no auth, no OpenAPI, no ZAP, no AuthZ matrix, single seed page). Real defects in autoqa surface in the `post-deploy-qa` jobs of the CONSUMER repos that pin `nikolay-e/autoqa@<sha>` — Cloudflare interactions, login redirects, OpenAPI variants, ZAP container quirks, schemathesis edge cases, etc. A green self-test does NOT mean autoqa is healthy.

**Every `/qa` pass on this repo MUST:**

1. Enumerate every consumer. **`gh search code` is LOSSY — do not trust it as the authoritative list** (its index missed `life-as-code` and `yay-tsa`, both real consumers, on 2026-06-20). The authoritative sweep lists ALL repos and greps each one's workflows directly:

   ```bash
   gh repo list nikolay-e --limit 200 --json name --jq '.[].name' | while IFS= read -r repo; do
     gh api "repos/nikolay-e/$repo/contents/.github/workflows" --jq '.[].name' 2>/dev/null | while IFS= read -r f; do
       [ -z "$f" ] && continue
       gh api "repos/nikolay-e/$repo/contents/.github/workflows/$f" --jq '.content' 2>/dev/null | base64 -d \
         | grep -q 'nikolay-e/autoqa@' && echo "$repo/$f"
     done
   done
   ```

   Note the `while IFS= read -r` loops: **zsh does not word-split unquoted `$files`** like bash, so a naive `for f in $files` iterates once over the whole blob and silently finds nothing. Current consumers (2026-06-20): `lingua-quiz`, `toy-projects`, `life-as-code`, `yay-tsa` (4 app repos) + autoqa's own self-test. `gh search code 'nikolay-e/autoqa@'` only returned 3 of them.

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

## mechanical-checks.mjs M1 invisible-char trap

- The mojibake guard at `scripts/mechanical-checks.mjs:53` uses `/[-ɏ]/` written as two raw Unicode chars (U+0080 .. U+024F) separated by a literal `-` in the source bytes. The U+0080 (PADDING CHARACTER) is invisible in most editors and **gets dropped if you paste the file content through a shell heredoc** — the resulting copy becomes `/[-ɏ]/` which matches only literal hyphen or U+024F. If editing this regex, work with the file via `Edit`/`Read` tools, never via `cat <<EOF`. Validate end-to-end with `node -e 'const re = require("fs").readFileSync("scripts/mechanical-checks.mjs","utf8").match(/return (\/\[.+?\]\/)/)[1]; console.log(eval("("+re+")").test("Ð¡ÐµÑ€Ð³ÐµÐ¹"))'` — should print `true`.

## Consumer-sweep triage: schemathesis text/html by status class

A consumer gate-fail of `schemathesis reported N failure(s)` is NOT automatically an autoqa bug — read the FAILURES block and split by status:

- **text/html 4xx** whose only finding is an undocumented content-type → a pre-servlet container rejection of malformed input (Tomcat/nginx/CDN URI parser), classified non-blocking by `classifySchemathesis`. Neither an app bug nor an autoqa bug.
- **text/html 5xx** (e.g. 502/500 on a malformed/binary body) → a REAL consumer resilience bug: the app must reject bad input with 400/422, not crash/sever the upstream into a 5xx. File it in the consumer repo, not here. The classifier deliberately keeps 5xx text/html blocking.

Schemathesis 4.x reports auth-negative coverage (401 on auth-protected ops) as a separate `Authentication failed: N operations` notice, NOT inside the `N failed` count the gate parses — so documented 401s no longer red the gate (this closed #8; no autoqa code change was needed, the version behaviour already separates them).

## crawler-decorative-paths (resolves #11 part 1)

Opt-in gate input that downgrades 4xx network errors / broken links whose URL matches a pattern (e.g. `/Images/`) from blocking to non-blocking info. Solves the per-item-id case (`/Items/<id>/Images/Primary`) where every missing-asset URL is a unique fingerprint that never settles into the baseline and keeps surfacing as fresh. Default empty = zero behaviour change; consumers wire it in their autoqa `with:` block. Verified with synthetic baseline-diff + crawler-findings fixtures (baseline and non-baseline modes).

## ZAP HIGH false-positives (#7, RESOLVED via opt-in path allowlist)

The gate counts every `riskcode==3` ZAP alert as blocking. A boolean-based SQLi alert on a rate-limited (429) / auth-gated (403) endpoint is a FP — the differential ZAP saw is the limiter, not the DB. The `-J` traditional report does not carry per-instance HTTP status, so the gate cannot read the 429 directly. Resolved the same way #11 was: a deterministic opt-in path allowlist (`zap-rate-limited-paths`) instead of a flaky one-shot re-probe. `aggregate-gate.mjs gateZap` downgrades a HIGH alert from blocking to non-blocking `info` only when **every** `alert.instances[].uri` matches a declared path; an alert that also fires on an un-gated path still blocks, and an alert with no instance data fails safe (stays blocking). Default empty = zero behaviour change. Verified with synthetic `zap-report.json` fixtures (all-match → exit 0; mixed/empty-list/no-instances → exit 1). The rejected re-probe approach was flaky: the rate-limit window can reset between scan and re-probe, flipping a 429 to 200. Note: a consumer that runs its OWN duplicate `Gate on ZAP HIGH findings` step would defeat this fix (the duplicate ignores `zap-rate-limited-paths`). `yay-tsa` had exactly such a step; it was **removed** (2026-06-20) so the autoqa gate is the single owner of ZAP HIGH gating. Future consumers must not reintroduce a standalone `riskcode==3` gate — wire `zap-rate-limited-paths` into the autoqa `with:` block instead.

## .auth-token is write-only (latent, low-risk)

`auth.sh` and `auth-playwright.mjs` write the bearer token to `/tmp/qa-reports/.auth-token`, but nothing reads it — every consumer uses the `QA_AUTH_TOKEN` env var instead. It is not uploaded today (dotfile + `upload-artifact` v7 excludes hidden files by default), so there is no live leak, but it is a latent secret-on-disk that relies entirely on that default. Cleanup is safe but do NOT edit the auth scripts blind: the self-test runs against example.com with no auth, so a regression there would not be caught by CI.

## Portable image (`run-all.sh`) — parity with action.yml

`scripts/run-all.sh` is the container entrypoint and the CI-agnostic twin of
`action.yml`. The two MUST stay in lockstep:

- **Same step order, same per-tool gating.** When you add/reorder a tool or change
  an `if:` condition in `action.yml`, mirror it in `run-all.sh` (and the gate env
  block). They share the underlying `scripts/` + `tools/` — only the orchestration
  is duplicated (GH-native caching/UI vs. a plain bash loop).
- **Env interface:** action input `foo-bar` ⇒ image env `QA_FOO_BAR`. `run-all.sh`
  maps those canonical `QA_*` vars onto the per-tool env the scripts actually read
  (`CRAWL_*`, `MONKEY_*`, `QA_BASE_URL`, `QA_GATE_*`). Only `QA_URL` is required.
- **Auth token hand-off** outside GitHub: `run-all.sh` points `GITHUB_ENV` at a
  temp file, runs `auth.sh`/`auth-playwright.mjs` (which append `QA_AUTH_TOKEN=…`),
  then sources it — reusing the existing mechanism without faking other GitHub vars.
- **Baseline outside GitHub:** there is no `actions/cache`. `baseline-diff.mjs`
  reads `QA_EVENT_NAME`/`QA_REF_NAME`/`QA_BASE_REF` as fallbacks for the GitHub
  ones; the caller mounts a persistent volume at `QA_BASELINE_DIR`.
- **ZAP** is intentionally NOT bundled (research: DinD path-translation makes a
  sibling `docker run -v` resolve paths against the host daemon, so reports vanish;
  bundling needs a JRE + add-on drift). `run-zap.sh` skips with a notice when no
  Docker daemon is reachable. Run ZAP via the GitHub Action, a dedicated ZAP job,
  or a mounted host socket with a host-path report dir.
- **Base image tag MUST equal the `playwright` version in
  `tools/crawler/package-lock.json`** (`v<X.Y.Z>-jammy`) — browser binaries are
  pinned per release; a mismatch yields "browser executable doesn't exist." Bump
  both together. `npm ci` installs only the driver; browsers come from the base
  image (no `playwright install` in the Dockerfile).
- **schemathesis** lives in a venv (`/opt/venv`) on PATH — PEP-668-safe on jammy
  and a future noble bump.
- The image publishes to `ghcr.io/${{ github.repository }}` from the `image` job in
  `ci.yml` (buildx, `linux/amd64`, `main-<sha>` + `latest`, push only on `main`).

---

Generic QA patterns live in the `/qa` skill — do not duplicate here.
