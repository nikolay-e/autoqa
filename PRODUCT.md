# Product audit log — intended vs actual

Append-only. Each finding: kind · severity · intent `quote@source` ↔ actual `quote@file:line` · acceptance observable.
Evidence gradient caps severity: human wrote it down → 🔴 available · only test → 🟡 · only code shape → 🔵.
External contract IS present here (README.md, STRATEGY.md, QA.md, action.yml input/output docs) — full audit, 🔴 in play.

---

## Run 2026-06-20 (commit 4ea6a7c)

Intent sources read in full: `README.md`, `STRATEGY.md`, `QA.md`, `action.yml` (input/output
descriptions). Report-file contract, action-output contract, and shipped-roadmap claims were
each swept and verified clean except where noted. Findings adversarially verified by two
scouts with concrete acceptance traces.

### must-have intent unmet (broken contract)

#### 🔴 AuthZ: "user B must get 401/403/404 … anything else fails the build" — code only fails on 2xx

- **Intent (written, two sources):**
  - `README.md:84` — "token A → 2xx, token B → 401/403/404, no token → 401/403/404. **Anything else fails the build.**"
  - `action.yml:131` — "For each: user A must get 2xx, **user B must get 401/403/404**, no-auth must get 401/403/404."
- **Actual** `scripts/run-authz-matrix.mjs:109,118` — user B is judged ONLY by the 2xx test:
  ```js
  const bolaLeak = bRes.status >= 200 && bRes.status < 300;
  ...
  if (bolaLeak) issues.push({ kind: "bola", ... });
  ```
  No-auth has BOTH the 2xx test AND an "anything-not-in-{401,403,404}" catch-all (`auth-weak`,
  `:128`), but there is **no `bola-weak` mirror** for user B — `ACCEPTABLE_FORBIDDEN` (`:19`) is
  consulted only for no-auth. So a 3xx (e.g. 302 leaking the resource) or 5xx to user B raises
  no issue and the build passes.
- **Acceptance:** resource path with A→200, B→500, no-auth→401 ⇒ build **must fail**; today it
  passes (`bolaLeak=false`, no `auth-weak` for B, `issues=[]` → verdict OK). Also B→302 passes.
- **Fix:** add the user-B mirror of `auth-weak` — fail when `bRes.status` is not in
  `{401,403,404}` (and not the owner's 2xx). Secondary: the `:121` detail says "expected
  403/404" while the contract says "401/403/404" — align the string.
- **Invariant touched by the fix:** the AuthZ JSON shape `authz-matrix.json findings[].issues[]`
  (README.md:126, gate keys on `issues.length` at `aggregate-gate.mjs`) — add a new `kind`, do
  not rename existing ones.

#### 🔴 `crawler-fail-on-violations` documented as "Ignored when baseline-enabled=true" — actually disables the baseline-fresh gate

- **Intent** `action.yml:64` — "Honored by the final gate step. **Ignored when baseline-enabled=true** (baseline diff governs instead)."
- **Actual** `aggregate-gate.mjs:39` `FAIL_ON.crawler` is fed from this input (`action.yml:360`),
  and the blocking filter `f.severity === "fail" && FAIL_ON[f.tool]` (`aggregate-gate.mjs:449-450`)
  applies in the baseline branch too — `gateCrawler` records the baseline-fresh finding as
  `severity:"fail", tool:"crawler"` (`:153-156`). So `FAIL_ON.crawler=false` strips fresh findings
  from `blocking`. `action.yml:287` only suppresses the _crawler's own_ exit under baseline mode;
  the final gate still honors the input. The doc's "ignored" is false for the half that matters.
- **Acceptance:** PR introducing a new broken link, `baseline-enabled=true` +
  `crawler-fail-on-violations=false` ⇒ gate exits 0 (green) despite a fresh finding. A consumer
  trusting the doc ("ignored, so safe to set false") silently neuters their gate — directly
  defeats STRATEGY's "Trust the gate" success metric.
- **Fix (decision required):** either (a) make the gate genuinely ignore the input in baseline
  mode — force `FAIL_ON.crawler=true` when `baseline-enabled` — matching the doc; or (b) change
  the doc to state the input still governs the baseline-fresh gate. (a) is the safer default.

### needs-a-human-answer (conflicts & under-specified)

#### 🟡 STRATEGY success metric "zero `continue-on-error: true`" contradicts the actual design (written-vs-written conflict)

- **Intent A (literal, now false)** `STRATEGY.md:45` — "**Trust the gate**: zero `continue-on-error: true`. A failing AutoQA step must always represent a real new finding."
- **Intent B (newer, explains why)** `QA.md:95-96` — "Every tool step in `action.yml` carries `continue-on-error: true` so one tool's crash never silently skips the rest. The fix is **not** to drop `continue-on-error` … `aggregate-gate.mjs` re-derives pass/fail."
- **Actual** `action.yml` — `continue-on-error: true` on 10 tool steps (`:197,207,229,241,249,265,272,296,305,328`).
- The sentence has split: half 1 ("zero continue-on-error") is literally false; half 2 ("a
  failing step = a real finding") is **preserved**, relocated into the always-run aggregate-gate.
  Product intent is honored; only the STRATEGY mechanism text is stale. **Surface, don't silently
  pick a winner.** Resolution is doc-only: rewrite `STRATEGY.md:45` to describe the aggregate-gate
  model per `QA.md`. **Acceptance:** STRATEGY no longer asserts a mechanism (zero continue-on-error)
  the code contradicts.

#### 🟡 README "appends a markdown diff table … on **every** run" — only when baseline-enabled

- **Intent** `README.md:130` — "The crawler also appends a markdown diff table to `$GITHUB_STEP_SUMMARY` on **every** run."
- **Actual** the diff table is written only inside `baseline-diff.mjs:139`, whose step is gated
  `if: … && inputs.baseline-enabled == 'true'` (`action.yml:303`). With `baseline-enabled=false`
  there is no baseline, hence no diff table (the always-run aggregate-gate writes a _different_
  "AutoQA — final gate" summary, not the diff table README promises).
- Low blast radius (baseline defaults on), and "diff table without a baseline" is logically
  empty — likely a wording imprecision rather than missing behavior. **Decision:** tighten the
  doc to "on every run with baseline diff enabled," or emit a stub summary when baseline is off.
  **Acceptance:** README's claim matches what a `baseline-enabled:false` run actually produces.

#### 🟡 README baseline enumeration omits **network errors**, which the baseline gate does block

- **Intent** `README.md:35` (and table `:12`) — "fails only on **new** axe / JS / broken-link / CSP / mixed-content findings" (five categories).
- **Actual** `baseline-diff.mjs:22-33` flattens **six** categories including `networkErrors`
  (`:30`), so a new 4xx subresource fails a PR. `action.yml:64` _does_ list "network errors" as
  gated, so the behavior is intended — `README.md:35`/`:12` under-list it.
- **Decision:** add "network-error" to the README enumeration (and the quick-start sentence), or
  confirm network errors should be excluded from the baseline gate. **Acceptance:** the README
  category list matches `CATEGORIES` in `baseline-diff.mjs`.

### maybe-scope (accidental behavior)

#### 🔵 Argos: `argos-enabled=true` with empty token captures screenshots then silently skips upload

- **Intent** `README.md:100-104` shows `argos-token` as required and says to create the repo to
  obtain it; `action.yml:117-118` documents the token but specifies no behavior when empty.
- **Actual** screenshots are still captured (`crawl.js:126`, `ARGOS_ENABLED` only checks
  `argos-enabled`), but the upload step is gated `&& inputs.argos-token != ''` (`action.yml:319`)
  with no warning when enabled+empty.
- No written intent requires a warning ⇒ 🔵 "is this intended?", not a requirement. **Acceptance:**
  run with `argos-enabled=true` and no token → decide whether a "skipping Argos upload — no token"
  log line should appear (today: green job, screenshots in artifact, zero diagnostic).

### do-not-change invariants (name them before any leverage/cleanup pass)

- **Action output names** `action.yml:137-158` (`report-path`, `pages-visited`, `js-errors`,
  `axe-violations`, `broken-links`, `csp-violations`, `mixed-content`) and the static
  `report-path: /tmp/qa-reports` — consumers read these; renaming breaks them.
- **Report filenames** `README.md:121-128` — all nine verified present and written by code
  (`crawler-findings.json`, `baseline-diff.json`, `observatory.json`, `authz-matrix.json`,
  `screenshots/*.png`, `schemathesis.txt`, `zap.txt`, `zap-report.json`, `openapi.json`). The
  Argos upload + any consumer artifact tooling depends on `screenshots/` path and these names.
- **baseline-diff exit semantics** `QA.md:77-78` — exit 1 ONLY on `pull_request` with fresh
  findings; `push` to main always exit 0 + overwrite. A "simplify" must not collapse the
  event-name branch.
- **Gate is the LAST composite step, after artifact upload** `QA.md:98` — reports must upload
  even when the gate fails.
- **Single-owner ZAP HIGH gating** `QA.md:123` — consumers must NOT reintroduce a standalone
  `riskcode==3` gate; the autoqa gate + `zap-rate-limited-paths` is the sole owner.

### Verified CLEAN (swept, no gap)

- Reports contract (9/9 filenames written by code) · Action outputs (6/6 emitted by
  `crawl.js:462-477`) · Shipped-roadmap claims (baseline diff, Observatory, CSP+mixed-content,
  Argos, AuthZ — all exist) · `observatory.json` written at `run-observatory.sh:22`.

---

## OPPORTUNITY (not a requirement) — ranked, severity-less, human is the gate

1. **OPPORTUNITY (not a requirement)** — Emit a one-line "skipping Argos upload — no token" /
   "running ZAP unauthenticated — no token" diagnostic when a tool is enabled but its required
   secret is empty. Anchor: the Argos silent-skip 🔵 above + `QA.md` consumer-sweep symptoms rely
   on log greps that today have nothing to grep. VERIFY(gate: owner wants the diagnostics).
2. **OPPORTUNITY (not a requirement)** — Carry the asset `url` onto broken-link findings so
   `crawler-decorative-paths` can downgrade decorative _broken links_, not only network errors.
   Anchor: `QA.md:117` decorative feature + the structural gap that `brokenLinks` findings have no
   URL to match. VERIFY(gate: owner wants brokenLinks decorative support).

---

## Resolution 2026-06-20 (same commit, fixes applied)

- 🔴 AuthZ "anything else fails" → `bola-weak` kind added (`run-authz-matrix.mjs`); detail string
  aligned to "401/403/404".
- 🔴 `crawler-fail-on-violations` "ignored under baseline" → `action.yml` now forces
  `QA_GATE_CRAWLER_FAIL=true` when `baseline-enabled=true`, so the input is genuinely ignored
  there (option a). Verified: baseline+fresh on a PR blocks regardless of the input.
- 🟡 STRATEGY "zero continue-on-error" → rewritten to the aggregate-gate model.
- 🟡 README "every run" summary → reworded (baseline-diff table = baseline-enabled; gate summary
  = always).
- 🟡 README enumeration → "network-error" added to both the tools table and the quick-start line.
- 🔵 Argos silent skip → upload step now runs when `argos-enabled` and prints
  "Skipping Argos upload — … argos-token is empty" instead of vanishing.
- OPPORTUNITY #1 (enabled-but-no-secret diagnostic) → implemented for Argos. #2 (brokenLinks
  decorative url) → dropped: decorative already matches broken-link `path`.

Do-not-change invariants listed above were all preserved (no output/report-name/exit-semantics
changes; AuthZ added a new `kind`, renamed none).
