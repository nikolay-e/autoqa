# Correctness audit log

Append-only. Each entry: severity · `file:line` · quote · why wrong · fix.
Severity: 🔴 wrong in normal use · 🟡 wrong in edge cases · 🔵 misleading name/comment.

---

## Run 2026-06-20 (commit 4ea6a7c)

Deterministic pre-checks first: `node --check` on all `.js`/`.mjs` (6 files, all OK),
`bash -n` + `shellcheck` on all `.sh` (4 files, clean, exit 0). No syntax/lint defects —
everything below is logic, not parse errors. Scope: crawler, gate aggregation, baseline
diff, AuthZ matrix, shell runners, action wiring.

### 🟡 Cold baseline cache fails a PR on the ENTIRE finding inventory, not just new findings

`scripts/baseline-diff.mjs:148`

```js
if (EVENT_NAME === "pull_request" && fresh.length > 0) {
  console.error(`FAIL: ${fresh.length} new crawler findings vs baseline`);
  process.exit(1);
}
```

When no baseline cache exists (`baselineExists === false` → `baseline` stays `null`),
`diff()` treats `(baseline || [])` as empty so **every** current finding becomes `fresh`.
The PR-fail branch has no `baselineExists` guard — unlike the local-run branch at `:153`
which correctly checks `&& !baselineExists`. GitHub Actions caches are branch-scoped and
evicted after 7 days, and a freshly-adopted repo has no `main` baseline yet, so a cold
cache is routine. README/CLAUDE claim the gate "fails PRs only on **new** findings"; here
it blocks the PR on the site's whole pre-existing finding set. **Fix:** guard `:148` with
`&& baselineExists`, emitting a visible "no baseline — gate skipped" notice (mirroring `:153`).

### 🟡 M2 tofu regex includes `?` and `#`, so emphatic punctuation / markdown trips a P0 check

`scripts/mechanical-checks.mjs:63` (comment `:56-62`)

```js
const TOFU_RUN = /[#?□▯�◻�]{3,}/;
// Real content does not contain runs like this
```

`???` ("Really???", "Sure???") and `###` in code blocks / `<pre>` / un-stripped rendered
markdown are ordinary user-facing text, yet match this P0 "tofu/replacement-glyph" rule.
The comment explicitly claims the opposite ("Real content does not contain runs like
this") — a 🔵 lie on top of the 🟡 false-positive. The workspace mandate for these
mechanical checks is zero-FP-by-construction; `?`/`#` break that. (Mechanical gate is
default-off — `QA_GATE_MECHANICAL_FAIL=false` — so today it surfaces as noise rather than a
wrong block, hence 🟡 not 🔴.) Also note the char class lists `�` (U+FFFD) twice — harmless
dup. **Fix:** drop `?` and `#`; keep only the box/replacement glyphs `□▯�◻`.

### 🟡 AuthZ: 3xx / 5xx responses fall into an unclassified gap for user B and no-auth probes

`scripts/run-authz-matrix.mjs:108-110`

```js
const ownerOk = aRes.status >= 200 && aRes.status < 300;
const bolaLeak = bRes.status >= 200 && bRes.status < 300;
const authBypass = noAuthRes.status >= 200 && noAuthRes.status < 300;
```

`probe()` uses `redirect: "manual"` (`:56`), so a 301/302/307 is returned verbatim. A
cross-tenant request that answers user B with a **302 to the resource / a signed URL** is
`< 300`-false → **not flagged as a BOLA leak**, and `ACCEPTABLE_FORBIDDEN` (`{401,403,404}`)
is consulted only for the no-auth weak-check (`:128`), never for B — so a 3xx to B is
neither leak, weak, nor ok: invisible. Symmetrically a legitimate 3xx→200 owner flow makes
`ownerOk` false → false `owner-access-broken`. **Fix:** classify explicitly for both B and
no-auth — `2xx`=leak, `401/403/404`=denied/ok, everything else (3xx, 5xx)=`inconclusive`/flag.

### 🟡 Crawler swallows ALL axe failures, so a systematic axe break looks identical to "no a11y violations"

`tools/crawler/crawl.js:267-269`

```js
} catch {
  // axe can fail on some pages
}
```

A per-page transient is fine to skip, but a systematic failure (CSP blocking axe's script
injection, a bad tag/config, an axe-core version mismatch) makes **every** page silently
record zero violations — a green run indistinguishable from a genuinely clean one. **Fix:**
count axe-failed pages and surface the count, so a 0-violation run on a broken setup is visible.

### 🟡 Crawler axe fingerprint includes `nodes[0].target`, causing spurious "new" findings on DOM reorder

`tools/crawler/crawl.js:256,264`

```js
const target = (violation.nodes[0]?.target || []).join(">>>");
...
fingerprint: fingerprint("axe", violation.id, target, path),
```

axe returns exactly one violation object per rule per page, so `(id, path)` already
uniquely identifies it. Folding in only the _first_ node's CSS selector makes the
fingerprint unstable to any DOM reordering — the same violation re-hashes and shows up as a
NEW finding in baseline-diff, falsely failing the PR (`baseline-diff.mjs:148`). The stored
`target` field (first node only, next to `nodes: N`) is also 🔵 misleading. **Fix:**
fingerprint on `(id, path)` only.

### 🟡 Crawler broken main-page is double-counted as both a brokenLink and a networkError

`tools/crawler/crawl.js:208-212` + `:232-238`

```js
page.on("response", (response) => {
  const status = response.status();
  ...
  if (status >= 400 && !isExcluded(url)) { networkFailures.push(...); }   // fires for the nav doc too
});
...
if (!response || response.status() >= 400) { results.brokenLinks.push(...); }
```

The `response` listener is attached before `page.goto`, so the top-level navigation's own
4xx/5xx is pushed to `networkErrors` AND the page is pushed to `brokenLinks`. The gate sums
both buckets (`aggregate-gate.mjs:182-191`), so one broken page counts twice toward `total`
and appears as two separate baseline-diff findings. **Fix:** in the `response` listener skip
the navigation document (`request.isNavigationRequest()` / compare `response.url()` to the
page URL).

### 🟡 Crawler login completion test is a substring check that breaks on SPA / `/login`-substring landings

`tools/crawler/crawl.js:95`

```js
await page.waitForURL((url) => !url.toString().includes(LOGIN_URL), {
  timeout: 30000,
});
```

`LOGIN_URL` defaults to `/login`. An SPA that authenticates without a URL change (token to
localStorage) never satisfies this → 30s timeout → false "login failed". A post-login
landing whose path still contains the substring (e.g. `/login-success`) also never
resolves. Today's consumers redirect away from `/login` so it works, but the check is
fragile. **Fix:** wait for an auth cookie / a post-login selector, or exact-match the
landing path rather than substring.

### 🟡 ZAP target keeps a trailing slash → schemathesis and ZAP target subtly different bases

`scripts/run-schemathesis.sh:36` vs `scripts/run-zap.sh:18` / `scripts/auth.sh:12`

```sh
# run-schemathesis.sh:36 — no %/ strip
ST_BASE_URL="${QA_SCHEMATHESIS_BASE_URL:-${QA_BASE_URL}}"
# run-zap.sh:18 — strips only the fallback, not the explicit value
ZAP_TARGET_URL="${QA_SCHEMATHESIS_BASE_URL:-${QA_BASE_URL%/}}"
```

`auth.sh` and the ZAP fallback strip the trailing slash with `%/`; schemathesis never does,
and ZAP doesn't strip an explicitly-set `QA_SCHEMATHESIS_BASE_URL`. A consumer passing
`schemathesis-base-url: https://host/api/` makes schemathesis/ZAP compose `https://host/api//notes`,
and a plain `url:` with a trailing slash splits the two tools onto different bases. **Fix:**
normalize once — apply `%/` to the resolved value in both scripts.

### 🟡 Observatory: HTTP 200 with an empty/pending grade fails the gate instead of being treated as transient

`scripts/run-observatory.sh:36` + `:60-78`

```sh
GRADE=$(python3 -c "import json; print(json.load(open('${OBS_JSON}')).get('grade',''))")
...
CURRENT_RANK=$(grade_rank "${GRADE}")   # "" matches nothing in GRADES_ORDER → default-worst rank
```

The async Observatory v2 API can return HTTP 200 with a "scan pending" body lacking `grade`.
`grade_rank("")` falls through to the worst rank, so `CURRENT_RANK > THRESHOLD_RANK` → `exit 1`,
failing the gate on a transient. Every other failure path in this script is deliberately
non-fatal (`exit 0` at `:8,:13,:33`); this one is inconsistent. **Fix:** if `GRADE` is empty,
log and `exit 0` like the non-200 branch.

### 🔵 Decorative-downgrade lists `brokenLinks` but can never match a broken-link's asset URL

`scripts/aggregate-gate.mjs:59,169` + `:136-138`, producer `tools/crawler/crawl.js:234-238`

```js
const DECORATIVE_CATEGORIES = new Set(["networkErrors", "brokenLinks"]);
...
const brokenLinks = (data.brokenLinks || []).filter((e) => !isDecorative("brokenLinks", e.url, e.path));
```

A broken-link finding is `{ path, status, fingerprint }` — there is **no `url` field**
(`e.url` is `undefined`), and `path` is the _page_ being crawled, not the decorative asset.
In the baseline branch the broken-link `summary` is `→ ${status}` (`baseline-diff.mjs:29`),
also URL-free. So `isDecorative` for `brokenLinks` can only match if the page path itself
contains the decorative substring — never the asset (`/Items/<id>/Images/Primary`) the
feature targets. The `networkErrors` half works (its summary embeds the URL), so the feature
isn't broken overall — but the `brokenLinks` membership is dead. **Fix:** carry the asset
`url` onto broken-link findings (and into the summary), or drop `brokenLinks` from
`DECORATIVE_CATEGORIES` and document the limitation.

### 🔵 Final-gate status column shows the FIRST finding's severity, mislabeling blocking runs as "info"

`scripts/aggregate-gate.mjs:442`

```js
const status = tFindings.length === 0 ? "ok" : tFindings[0].severity;
```

On the exact downgrade paths this codebase added, an `info` finding is recorded _before_ the
`fail` (ZAP: rate-limited info at `:351` then HIGH fail at `:359`; crawler: decorative info
then fresh fail). So the human-readable status column reads `info` while the gate actually
blocks. The verdict logic (`:449`, filters `severity === "fail"`) is correct, so only the
summary surface lies. **Fix:** show the worst severity, not `tFindings[0]`.

### 🔵 CSP detection over-matches: bare `Refused to <verb>` flags any console line with that phrase

`tools/crawler/crawl.js:39-40`

```js
const CSP_VIOLATION_PATTERN =
  /Refused to (load|connect|apply|execute|run|frame|create|send)|Content Security Policy directive/i;
```

The canonical Chromium CSP message always contains "...because it violates the following
Content Security Policy directive...". The bare `Refused to (verb)` alternation also matches
app logging like `console.log("Refused to send analytics (opted out)")`, producing a false
CSP finding. **Fix:** require the `Content Security Policy` half (or "because it violates")
to co-occur; drop the standalone `Refused to <verb>` branch.

### 🔵 `console.error` containing "Failed to load resource" is silently dropped as network noise

`tools/crawler/crawl.js:180`

```js
if (!text.includes("Failed to load resource")) {
```

Intended to drop the browser's own network-noise lines, but it also discards a genuine
`console.error("Failed to load resource bundle X")` from app code. **Fix:** anchor to the
canonical prefix `"Failed to load resource: the server responded with a status of"` rather
than a loose substring.

### 🔵 Auth token-field list diverges between the two auth modes

`scripts/auth.sh:42` vs `scripts/auth-playwright.mjs:81`

```python
print(d.get('AccessToken', d.get('access_token', d.get('token', ''))))   # curl mode: 3 fields
```

```js
token = data.AccessToken ?? data.access_token ?? data.token ?? data.jwt ?? ""; // playwright mode: +jwt
```

A backend returning `{"jwt": "..."}` authenticates under `auth-mode=playwright` but fails
under the default `auth-mode=curl` with "no AccessToken in response". **Fix:** align the
field list across both extractors.

### 🔵 `flatten()` re-scans CATEGORIES for a summarizer it already has in hand

`scripts/baseline-diff.mjs:37,44`

```js
for (const [key, label] of CATEGORIES) {       // third element (the summarize fn) dropped
  ...
  summary: CATEGORIES.find((c) => c[0] === key)[2](item),   // re-finds the same row
```

Resolves to the correct fn today, but if a duplicate `key` were ever added the `.find`
would pick the first, not the iterated row. **Fix:** destructure the fn —
`for (const [key, label, summarize] of CATEGORIES)` and call `summarize(item)`.

### Scout claims investigated and REJECTED (not bugs)

- **AuthZ "vacuous BOLA pass" when a resource is broken-for-everyone** — not a bug:
  `run-authz-matrix.mjs:113` pushes an `owner-access-broken` issue when `!ownerOk`, so a
  path that 404s for both A and B **fails** the gate (`issues.length > 0`), it does not pass
  silently. Token→probe mapping (`:104-106`) and the set logic are correct.
- **`.auth-token` uploaded as a CI artifact (secret leak)** — already triaged in
  `QA.md:125`: `upload-artifact` v7 excludes hidden files by default, so the dotfile is not
  uploaded; it is a write-only latent file, not a live leak.
- **baseline-diff `fresh`/`persistent`/`fixed` set difference inverted / gate blind** —
  verified correct at `baseline-diff.mjs:51-58`; fingerprints are stable sha1 of
  `(category, normalized message, path)` with no volatile fields.
- **ZAP `allInstancesRateLimited` suppresses real HIGH alerts** — the empty-instances
  fail-safe (`aggregate-gate.mjs:88`) and `.every` are correct; residual risk requires the
  consumer to opt in AND a truncated ZAP report, which the honest `-J`-limitation comment
  already discloses. Not logged as a defect.

---

## Resolution 2026-06-20 (same commit, fixes applied)

All findings above addressed in the working tree (verified: node --check, shellcheck,
prettier clean, live example.com self-test = deterministic 2 axe findings, gate scenarios):

- Cold-cache false-fail → `baseline-diff.mjs` carries `baselinePresent`; gate treats fresh as
  non-blocking `warn` when no baseline (`aggregate-gate.mjs gateCrawler`).
- M2 tofu `?`/`#` → removed; class now `/[□▯◻�]{3,}/` (tested: `□□□` yes, `???`/`###` no).
- AuthZ B 3xx/5xx gap → `bola-weak` mirror of `auth-weak` (B not in {401,403,404} → fail).
- axe `catch{}` → logs + `results.axeErrors[]` + report line.
- axe fingerprint → `(id, path)` only (verified sha1).
- broken-page double-count → response listener skips main-frame navigation.
- login substring → exact-path predicate (`pathname !== LOGIN_URL`).
- schemathesis/ZAP trailing slash → `%/` applied to resolved value in both.
- Observatory empty grade → `exit 0` (non-fatal).
- gate status column → worst severity, not first.
- `baseline-diff.flatten` → destructures the summarizer fn.
- CSP over-match → `/Content Security Policy/i`; `console.error` filter → `startsWith("Failed to load resource:")`.
- auth token fields → `jwt` added to `auth.sh` (aligned with auth-playwright).

DROPPED on re-examination (not bugs): decorative-`brokenLinks` "can never match" — a broken
link's `path` IS the 404'ing URL and `isDecorative` checks `path`/summary, so it matches; the
redundant `undefined` `e.url` arg is harmless. `normalizeJsError [a-f0-9]{8,}` decimal-eating —
intended hash normalization, acceptable.
