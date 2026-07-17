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

The autoqa self-test on `example.com` exercises a narrow happy path (no auth, no OpenAPI, no ZAP, no AuthZ matrix, single seed page) plus a short **monkey** run (`monkey-enabled`, 15s, seed 1337) and an **image build/publish** job. Real defects in autoqa surface against the CONSUMER apps — Cloudflare interactions, login redirects, OpenAPI variants, ZAP container quirks, schemathesis edge cases, etc. A green self-test does NOT mean autoqa is healthy.

> **Two consumer surfaces (post-migration).** As of 2026-07-14 the only **GitHub Action** consumer (`uses: nikolay-e/autoqa@<sha>`) is **`hidden-gem`** (`post-deploy-qa.yml`, nightly `schedule` cron — `yay-tsa` dropped its GH workflow and moved fully to Argo). The **Argo Workflows** consumers run the **portable image** via gitops (a per-app `submit-autoqa` sensor trigger → the `autoqa` WorkflowTemplate, `ci/ci-platform/` in the gitops repo), NOT a `.github/workflows` pin. As of 2026-07-14 there are **10** of them — enumerate authoritatively from the sensors, never from memory (the set keeps changing): `grep -rl submit-autoqa ~/gitops/kubernetes/ci/ci-platform/sensor-*-image.yaml`. Current set: `andrii-bardakov-com`, `hidden-gem`, `life-as-code`, `lingua-quiz`, `nikolay-eremeev-com`, `pflegescore`, `tanyalytvyn-com`, `toy-projects`, `wealth-as-code`, `yay-tsa` (hidden-gem is on BOTH surfaces). For those, the run log is the Argo Workflow pod (`kubectl -n argo-workflows logs <app>-autoqa-<id>`), and "is it wired" is the gitops sensor/WorkflowTemplate, not a workflow-file grep.

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

   Note the `while IFS= read -r` loops: **zsh does not word-split unquoted `$files`** like bash, so a naive `for f in $files` iterates once over the whole blob and silently finds nothing. **As of 2026-07-14 this `.github/workflows` sweep only finds `hidden-gem`** — the only remaining GitHub-Action consumer. The 10 Argo consumers (see the two-surfaces note above) are enumerated from the gitops `submit-autoqa` sensors (`grep -rl submit-autoqa ~/gitops/kubernetes/ci/ci-platform/`), not from `gh`.

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
- Gates per tool: `crawler` (baseline-diff fresh count on PR; on push-to-main fresh findings only warn unless `baseline-fail-on-new=true` makes them fail that one run — alarm-once, the baseline update in the same run keeps the next run green; or any finding when baseline-enabled=false), `schemathesis` (schemathesis.txt `\d+ failed` — the MAX across all phase-summary lines; Schemathesis 4 prints one per phase (Examples/Coverage/Fuzzing/Stateful), so the first match under-counts and a leading `0 failed` phase would mask later failures entirely; errored cases gate separately via the v4 ruled summary line `N error(s)`), `zap` (`zap-report.json` alerts with `riskcode=3`), `mechanical` (P0 findings; default off — advisory), `observatory` (grade vs `observatory-fail-grade`), `authz` (`authz-matrix.json findings[].issues.length > 0`).
- The gate is the LAST step in the composite, after artifact upload, so reports always upload even when the gate fails.

## StandardFinding backbone + COMPLETE report

- `lib/finding-schema.mjs` defines the one finding shape every tool normalizes into (`fingerprint`, `severity`∈critical/high/medium/low/info, `category`, `tool`, `url`, `locator`, `evidence[]`, `fix_hint`, `docs_url`, …). Dependency-free on purpose — a schema lib would be parity tax across the dual distribution (composite action + portable image) for a one-maintainer tool with checks this small.
- `scripts/normalize-findings.mjs` reads every per-tool artifact and emits one validated `findings.json`. **Lenient by default** (invalid finding → warned + dropped, never affects a consumer gate); `--strict` / `QA_FINDINGS_STRICT=true` makes the first invalid finding exit 1 — used by `selftest.mjs` so a converter regression fails autoqa's OWN CI. The contract is enforced against fixtures, not against consumers.
- Consumers extend without forking via `extra-findings-path` (`QA_EXTRA_FINDINGS`): a JSON array of custom StandardFindings, merged through the same validation.
- `scripts/generate-qa-report.mjs` turns `findings.json` into `qa-report.md` + `qa-report.json` (exec summary, scope/coverage incl. what-was-NOT-tested, findings grouped by severity with locator + fix_hint). **Always-on and never gates** — the gate stays the sole pass/fail authority; the report is the story a human reads. Both are wired `continue-on-error: true` in `action.yml` and via `run_tool` in `run-all.sh`, before the gate.
- `scripts/selftest.mjs` is the integration test (repo mandate: no unit tests). It drives the real gate + normalizer + report end-to-end against fixtures and runs in CI (`node scripts/selftest.mjs`). Note: the axe converter's `fix_hint`/`docs_url` come from `failureSummary`/`helpUrl`, which `crawl.js` only started capturing alongside this backbone — baselines captured by older crawler builds carry empty hints until re-seeded.

## CI lint coverage for new scripts

- When adding a new top-level script (e.g., `scripts/foo.mjs`), also add an explicit `node --check scripts/foo.mjs` line to `.github/workflows/ci.yml` `lint` job — prettier check alone won't catch a syntax error. The lint job's syntax-check steps are an opt-in list, not a glob. Anything under `lib/` needs a `node --check` line too.

## mechanical-checks.mjs M1 invisible-char trap

- The mojibake guard at `scripts/mechanical-checks.mjs:53` uses `/[-ɏ]/` written as two raw Unicode chars (U+0080 .. U+024F) separated by a literal `-` in the source bytes. The U+0080 (PADDING CHARACTER) is invisible in most editors and **gets dropped if you paste the file content through a shell heredoc** — the resulting copy becomes `/[-ɏ]/` which matches only literal hyphen or U+024F. If editing this regex, work with the file via `Edit`/`Read` tools, never via `cat <<EOF`. Validate end-to-end with `node -e 'const re = require("fs").readFileSync("scripts/mechanical-checks.mjs","utf8").match(/return (\/\[.+?\]\/)/)[1]; console.log(eval("("+re+")").test("Ð¡ÐµÑ€Ð³ÐµÐ¹"))'` — should print `true`.

## Consumer-sweep triage: schemathesis text/html by status class

A consumer gate-fail of `schemathesis reported N failure(s)` is NOT automatically an autoqa bug — read the FAILURES block and split by status:

- **text/html 4xx** whose only finding is an undocumented content-type → a pre-servlet container rejection of malformed input (Tomcat/nginx/CDN URI parser), classified non-blocking by `classifySchemathesis`. Neither an app bug nor an autoqa bug.
- **text/html 5xx** (e.g. 502/500 on a malformed/binary body) → a REAL consumer resilience bug: the app must reject bad input with 400/422, not crash/sever the upstream into a 5xx. File it in the consumer repo, not here. The classifier deliberately keeps 5xx text/html blocking.

Schemathesis 4.x reports auth-negative coverage (401 on auth-protected ops) as a separate `Authentication failed: N operations` notice, NOT inside the `N failed` count the gate parses — so documented 401s no longer red the gate (this closed #8; no autoqa code change was needed, the version behaviour already separates them). Verified live on the yay-tsa sweep 2026-06-21: a 71-operation `Authentication failed` block sat in WARNINGS while the gate counted only the one real failure.

**Cloudflare `52x` handling was REVERSED by #29 (2026-07-14, commit `e133303`) — the 2026-06-21 "never downgrade" rule below is history, kept for context.** Original position (yay-tsa sweep 2026-06-21, filed `yay-tsa#252`): a 52x on malformed input is the origin-crash-on-bad-input case we want to catch, so no classifier downgrade. What changed: single-replica consumers running autoqa on the push webhook race their own ~40s rollout window, and every such run recorded CF edge-error pages as blocking failures with zero real defects (issue #29) — the false-positive rate beat the crash-catching value. Current behavior: `classifySchemathesis` downgrades a failure block to informational `edgeTransient` only when **every** response status in the block is a CF edge status (502/504/52x/530) AND the body is identifiably Cloudflare's own error page (`cloudflare` text or the `NNN: <reason>` title). Origin 5xx with non-CF bodies (JSON, half-written streams) still block. The residual risk — an origin that crashes into a CF 520 on malformed input is now info, not fail — is accepted; the finding still appears in the report as an edge-transient info line, so it is visible, just not gating. Covered by selftest Phase 3.

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
  `ci.yml` (buildx + QEMU, `linux/amd64,linux/arm64`, `main-<sha>` + `latest`, push only on `main`).

## CI `image` job — docker/\* action pins

- The `image` job pins five `docker/*` actions (`setup-qemu`, `setup-buildx`,
  `login`, `metadata`, `build-push`). GitHub raises a **"Node.js 20 is deprecated …
  forced to run on Node.js 24"** annotation for any version still on the node20
  runtime. Bump the pinned SHA to the latest **node24** release on each `/qa` pass
  (the `v-major` releases that say "Node 24 as default runtime" in their notes:
  qemu `v4`, buildx `v4`, login `v4`, metadata `v6`, build-push `v7`). These majors
  are drop-in (node24 + internal ESM refactor + removal of deprecated inputs we
  don't use). Bumped 2026-06-21 → annotation cleared. Keep the `# <tag>` comment on
  each pin (SonarCloud `new_security_hotspots_reviewed` requires SHA-pins).
- **`Failed to save: Unable to reserve cache with key docker.io--tonistiigi--binfmt-…`**
  on `setup-qemu` is **benign** — a binfmt-image cache reservation race, harmless on
  every multi-arch run. Do not chase it.
- Each `/qa` pass re-checks all five pins individually against `gh api repos/<action>/releases/latest`
  even when the previous pass cleared the node24 annotation — patch releases land
  between passes (e.g. `setup-qemu-action` v4.1.0 → v4.2.0, 2026-07-01, deps-only bump).

## Reading Argo Workflows consumer logs when the pod is already GC'd

`podGC: { strategy: OnWorkflowSuccess }` in the cluster's workflow-controller config
deletes pods immediately on success, so `kubectl -n argo-workflows logs <wf-name>`
fails with "not found" for anything but a currently-`Running` workflow — and there is
no `argo` CLI installed to fall back on. `archiveLogs: true` means the log is still
retrievable from the configured S3 (in-cluster MinIO) artifact repo:

```bash
kubectl -n argo-workflows get wf <name> -o jsonpath='{.status.nodes}' | grep -A3 '"s3"'
# → key: <wf-name>/<wf-name>/main.log

kubectl -n argo-workflows get secret argo-artifacts-minio -o jsonpath='{.data.accesskey}' | base64 -d
kubectl -n argo-workflows get secret argo-artifacts-minio -o jsonpath='{.data.secretkey}' | base64 -d
kubectl -n minio port-forward svc/minio 19000:9000 &
brew install minio-mc   # one-time
mc alias set argologs http://localhost:19000 <accesskey> <secretkey>
mc cp argologs/argo-workflows-artifacts/<wf-name>/<wf-name>/main.log ./out.log
```

This is how the 8-Argo-consumer sweep pulled logs for workflows whose pods had
already been garbage-collected (only currently-`Running` workflows have a live pod
to `kubectl logs` directly).

## Consumer sweep found a real app bug, not an autoqa bug (worked as designed)

2026-07-01 sweep: `tanyalytvyn-com-autoqa-gzzng` showed `monkey` gate status `fail`
(12 serious findings, all `http-5xx` on `/js/script.js` returning 502 site-wide,
confirmed live with a direct `curl`). This is squarely a consumer-app production bug,
not an autoqa symptom — filed `tanyalytvyn-com#26` and moved on, per the sweep's own
rule 5 ("clearly the consumer's app problem... NOT autoqa findings").

## diffctx over-dump: correct file list, wrong granularity (distinct from #65)

`diffctx . --diff <range>` correctly scoped `changed_files` to the 5 files `git diff
--stat` reported, but emitted each file's FULL current content as a single "changed"
fragment instead of the actual hunk(s) — 18k tokens for a 65-line diff. This is a
different bug than the already-tracked #65 (which pulls in _unrelated_ files); here
the file selection was right and the per-file granularity was wrong. Filed
`diffctx#91`. Narrowed the review with `git diff <range> -- <file>` per file per the
gate's fallback procedure.

## Shared working directory across concurrent `/qa` sessions

This machine runs one clone of `~/autoqa`. A concurrent `/qa` session on a _different_
repo (`yay-tsa`) traced a ZAP bare-origin bug back to autoqa mid-run, fixed it here
(commit `b874675`), pushed, and filed+closed `autoqa#18` — all while this session's
own consumer sweep was still in progress. `git log`/`git status` captured at session
start can go stale if another agent is committing into the same physical directory;
re-`fetch`/`git log` before assuming the local HEAD snapshot is still current,
especially mid-sweep when consumer logs are being read concurrently with fixes
landing.

**2026-07-05 recurrence:** mid-sweep, `yay-tsa`'s autoqa pin had already moved from
`426f577` to `9e4a383` by a concurrent session before this one got to the bump step —
and `yay-tsa`'s working tree had unrelated uncommitted feature work (`DownloadButton.tsx`,
`offline.store.ts`, `GlobalSearchBar.tsx`, `client-telemetry.ts`). Staged and committed
ONLY the pin-bump file (`git add .github/workflows/ci.yml`, never `-A`) to avoid
committing someone else's in-progress work; those files were still unstaged after push.
Same pattern hit `gitops` — `git push` was rejected (remote had 14 new Image-Updater
`build: automatic update of ...` commits); `git fetch` + `git rebase origin/main` (no
conflicts, disjoint files) resolved it cleanly. **Rule of thumb:** on a multi-repo bump
step, always `git fetch`/`git status` immediately before touching a shared repo, stage
by explicit filename, and rebase-not-merge on a push rejection when the remote-only
commits are known-disjoint (bot/automation commits) from your change.

## gateZap: distinguish "ZAP skipped" from "ZAP crashed" (closes #23)

`aggregate-gate.mjs`'s `gateZap` treated a missing `zap-report.json` as one message
regardless of cause. `run-zap.sh` itself no-ops (exit 0, no report) when
`openapi.json` is absent — which happens when schemathesis's spec download failed,
or `schemathesis-enabled=false` while `zap-enabled=true`. That is a real, worth-
surfacing problem, but conflating it with "ZAP started and crashed" made the gate
summary alone insufficient to diagnose which one happened. Fix: `gateZap` now checks
whether `openapi.json` exists before reporting the generic crash message; if it
doesn't, the message names the precondition instead. Covered by a new `selftest.mjs`
Phase 2 (both branches). Ref: `run-schemathesis.sh`'s retry fix (`1b23874`) already
closed the transient-network half of the original report; this closes the remaining
gate-clarity half.

## Argo consumers pin the IMAGE in gitops — bump it alongside the yay-tsa action pin

The 8 Argo consumers run `ghcr.io/nikolay-e/autoqa:main-<40hex>` pinned in
`gitops/kubernetes/ci/ci-platform/workflow-templates/autoqa.yaml` (ONE pin for all of
them), not a `.github/workflows` SHA. After fixing autoqa, the consumer-side bump is
therefore TWO edits: the yay-tsa workflow pin (`nikolay-e/autoqa@<sha>`) AND the gitops
WorkflowTemplate image tag. 2026-07-07: the template still pinned `main-c1cece6…` (the
broken-Origin commit) two days after the fix shipped — the image pin is the easier one
to forget. Verify the tag exists first: `docker manifest inspect ghcr.io/nikolay-e/autoqa:main-<sha>`.

## MinIO sweep: per-app prefix listing beats full-bucket find

`mc find` on the whole artifacts bucket is slow (2min+) and returns no timestamps.
Faster per-consumer latest-log lookup: `mc ls -r "argologs/argo-workflows-artifacts/<app>-autoqa" | grep main.log | sort | tail -1`
(prefix-scoped recursion, real mtimes, lexicographic date sort works). The `argologs`
mc alias points at `localhost:19000` — start `kubectl -n minio port-forward svc/minio 19000:9000`
first, or every `mc` call fails with exit 1. Note
`toy-projects` never produces `toy-projects-autoqa-*` workflows — its sensor submits
per-sub-app `vocontrol-autoqa-*` and `touch-typing-autoqa-*`; sweep those prefixes.

## Reported URLs are redacted at capture time (api_key leak class)

yay-tsa's public post-deploy-qa log printed the QA session's `?api_key=<hex>` verbatim
in the monkey report table. `tools/crawler/redact.js` now masks known secret query
params (api_key/token/password/…) in crawler network/mixed findings and monkey
request-failed / http-5xx messages before they are stored. Fingerprints hash the
pathname only, so baselines are unaffected. When sweeping consumer logs, a raw
`api_key=`/`token=` hex value in an autoqa report is a regression of this fix.

## Local test servers + spawnSync do not mix (selftest-http-basic)

`selftest-http-basic.mjs` starts its Basic-auth HTTP server on the SAME process that
drives the crawler. `spawnSync` blocks the parent event loop, so the server stops
accepting connections and every `page.goto` times out at 60s — the failure looks like
a crawler bug but is a frozen test harness. Any future selftest that pairs an in-process
server with a child process must use async `spawn` + await close.

## `.playwright-mcp/` browser-session debris in repo root

A Playwright MCP browser session (opened directly against this repo's working
directory, not the tool's usual `~/.playwright-mcp` home-dir jail) left untracked
`page-*.yml` / `console-*.log` scratch files in the repo root. These are not
gitignored by default and broke `npx prettier --check "**/*.{js,mjs,json,yml,yaml,md}"`
locally (though never committed, so CI was unaffected). Added `.playwright-mcp/` to
`.gitignore` and deleted the stray directory. If a local prettier run reports
failures only under `.playwright-mcp/`, this is why — not a real formatting bug.

## Baseline was push-only — schedule/cron consumers never persisted one (fixed 2026-07-14)

`action.yml`'s `Save crawler baseline` gated on `github.event_name == 'push'` and
`baseline-diff.mjs` only overwrote the baseline on `isMainPush`. A consumer whose
only autoqa runs are cron (`schedule`, e.g. hidden-gem's nightly post-deploy-qa)
therefore NEVER saved a baseline: every night logged `Cache not found for input
keys` → `baseline: absent (first run)` → all findings "new, not blocking" — the
baseline gate was permanently inert and the report cried "N NEW" forever. Fix:
both sides now treat `schedule` and `workflow_dispatch` on main/master as
baseline-updating, and the save key gained a `-${{ github.run_id }}` suffix
(GitHub caches are immutable — a nightly re-run on the same SHA could never
re-reserve the old key; restore-keys prefix matching picks the newest). Symptom
to grep for in consumer logs: `Cache not found for input keys` on every run of a
cron-only consumer. Covered by selftest Phase 3.

## Schemathesis 4 counts errors as "N error", not v3's "N errored"

The v4 report separates **failures** (assertion blocks) from **errors** (network
errors / read timeouts, `🚫` ERRORS section), and the only machine-countable
error total is the final ruled line (`== 3 failures, 1 error, 3 warnings in
637.34s ==`). The gate's old `(\d+)\s+errored` regex matched neither, so errored
cases were silently un-gated — a real 10s read-timeout DoS finding on yay-tsa
(`GET /v1/recommend/search?limit=77508`, filed yay-tsa#288) sailed through a
"green" schemathesis gate. `erroredCount()` now reads the v4 ruled summary line
(v3 wording kept as fallback) and errors gate independently of the
failures/classifier branch. Covered by selftest Phase 3.

## Monkey: net::ERR_ABORTED request-failures are navigation noise

A yay-tsa monkey run recorded 209 unique findings, ~all `request-failed …
net::ERR_ABORTED` — the browser cancelling its own in-flight requests when the
monkey navigates away mid-load (standard SPA behavior), drowning the handful of
real console-error findings. `monkey.js` now drops `net::ERR_ABORTED`
request-failures at capture time. Real network failures (DNS, reset, refused,
CORS console errors, 5xx responses) are unaffected.

## Monkey recorded findings from off-origin pages (fixed 2026-07-14)

The monkey's `framenavigated` guard walks back after wandering off-origin, but
every listener (`pageerror`, `console-error`, `request-failed`, `http-5xx`)
kept recording while the foreign page was loading — a hidden-gem run attributed
~45 request-failures to `en.wikipedia.org` pages. Same origin-boundary
semantics the crawler got in issue #27: `record()` now drops findings whose
page URL is off-origin (the `off-origin-nav` breadcrumb itself stays).

## run-zap.sh: Docker check must precede the openapi.json check (fixed 2026-07-14)

Only the no-Docker branch writes `zap-skipped.txt` (the #31 non-blocking
marker). With the openapi check first, a portable-image consumer with
`zap-enabled=true`, no Docker AND no spec exited before the marker was
written, so `gateZap` blocked with the misleading "check the schemathesis
step" message. No Docker dominates: ZAP can never run there regardless of the
spec, so that check now runs first.

## Rerunning a GC'd/failed Argo autoqa workflow manually

The sensors only fire on image events, so to reproduce a flaky consumer run:
`kubectl -n argo-workflows get wf <name> -o json | jq '{apiVersion, kind, metadata: {generateName: "<app>-autoqa-", namespace: "argo-workflows", labels: (.metadata.labels | with_entries(select(.key | startswith("workflows.argoproj.io") | not)))}, spec}' | kubectl create -f -`
— the spec is just `workflowTemplateRef` + `arguments` + `serviceAccountName`,
so the copy reruns the current template (including its current image pin).
**Strip the `workflows.argoproj.io/*` labels**: a completed workflow carries
`workflows.argoproj.io/completed: "true"`, and a copy created with it is
silently ignored by the controller forever (no status, no pod, no events).

## OOMKilled consumer runs: correlate with the TARGET app build, not the autoqa image

2026-07-14: yay-tsa autoqa runs OOMKilled (exit 137) at the WorkflowTemplate's
3Gi limit, 2/2 against app build `main-8c07a90`, while the run against the
previous app build `main-53bfd48` finished the full pipeline at the same limit
with an effectively identical autoqa image (same schemathesis v4.21.10). The
kill landed in DIFFERENT phases (schemathesis once, mid-crawl once) — gradual
Chromium memory growth against the heavier app, not one hungry autoqa step.
Verdict: consumer-app finding (filed `yay-tsa#291`) + gitops mitigation
(limit 3Gi → 6Gi). When a consumer autoqa run OOMs, first diff the app SHA the
runs targeted (`Waiting … to serve main-<sha7>` in the log header) before
suspecting an autoqa regression.

## axe-core dies on control chars in attribute values (upstream)

`img[alt=" \f¼"]` (raw form-feed U+000C in the alt, garbage data on
pflegescore's feed) makes axe-core's `generateSelector` emit an unescaped —
therefore invalid — attribute selector; `Element.matches` throws and the WHOLE
page's axe audit fails (`axe failed on /feed.html: … is not a valid selector`).
Verified: `CSS.escape` on the value fixes it. Upstream: `dequelabs/axe-core#5204`;
consumer data bug: `pflegescore#1`. When a consumer log shows `axe failed on
<page>` with "not a valid selector", inspect the page's attribute values for
control characters — it's data, not the crawler.

## Native confirm() dialogs on consumer pages stall the crawler login

wealth-as-code's /login pops a native `confirm("Доступна новая версия.
Обновить?")` version-update prompt (filed as Forgejo `wealth-as-code#1`).
Playwright auto-dismisses dialogs when no handler is attached, but a
version-check that fires `confirm()` + `location.reload()` loops can still stall
selector waits. If a consumer's crawler login times out waiting for a selector
that exists on manual inspection, check for native dialogs first
(`browser_handle_dialog` shows them in Playwright MCP).

---

Generic QA patterns live in the `/qa` skill — do not duplicate here.
