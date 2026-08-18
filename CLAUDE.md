# CLAUDE.md

Claude Code instructions for the **ShipStatic n8n Community Node**.

**n8n-nodes-shipstatic** — n8n community node for the ShipStatic static hosting platform. Direct HTTP calls to the ShipStatic API — zero runtime dependencies. Published to npm. **Maturity:** v1.x — the 1.x node is the one that speaks to the **2.x platform**. Deployments + Domains (15 operations), optional credentials, n8n Cloud verified.

## Architecture

```
nodes/Shipstatic/
├── Shipstatic.node.ts     # Node definition + execute() — all 15 operations
├── api.ts                 # The API base URL — one fact, two readers
├── Shipstatic.node.json   # Codex metadata (categories, aliases)
└── shipstatic.svg         # Node icon (simplified logo, no SVG filters)

credentials/
└── ShipstaticApi.credentials.ts   # The one credential slot

tests/
├── Shipstatic.node.test.ts   # The node through a mock of n8n's helper contract
├── contract.test.ts          # Fences: restated platform facts, catalogue, README, artifact
├── wire.ts                   # Response fixtures, `satisfies`-checked against @shipstatic/types
└── live.test.ts              # The same execute() against a real API (opt-in)
```

## Quick Reference

```bash
pnpm build          # TypeScript → dist/ (uses n8n-node build)
pnpm test --run     # All tests (~250ms; the live tier skips without SHIP_API_URL)
pnpm coverage       # The suite plus the ratchet — what CI runs
pnpm typecheck      # tsc over nodes, credentials AND tests, 0 errors
pnpm lint           # Biome (the platform standard)
pnpm lint:n8n       # The n8n Cloud VERIFICATION ruleset — see "Two linters"
pnpm dev            # Dev mode with hot reload (icon won't show — see Known Gotchas)
```

## Core Patterns

### Direct HTTP — No SDK, No Dependencies

Every operation is a direct HTTP call to `https://api.shipstatic.com`. Zero runtime dependencies — required for n8n Cloud verification. The n8n layer handles:

- UI definition (resource/operation selectors, parameter fields)
- Credential retrieval → Bearer token header
- Routing by resource + operation → HTTP call via `httpRequestWithAuthentication`
- Binary data → FormData multipart deploy (using Web API globals)
- Response shaping (list fan-out; **acknowledgements pass through verbatim**)

### The sandbox contract, and what it costs

This is the ONE consumer in the constellation that cannot import the facts it
depends on. `@n8n/eslint-plugin-community-nodes` enforces two rules that are
platform contracts rather than style:

- **`no-restricted-imports`** — any non-relative import in `nodes/` or
  `credentials/` is refused. It matches on the import STATEMENT, so even
  `import type`, which provably erases, is rejected. `@shipstatic/types` is
  therefore a **devDependency the suite imports and the node restates**.
- **`no-restricted-globals`** — `process`, `globalThis`, `setTimeout`,
  `__dirname` and friends. n8n Cloud sandboxes community nodes away from these,
  so reading `process.env` at module load would be a **ReferenceError before the
  node loads**, taking every operation down. This is why there is no
  `SHIP_API_URL` override in the artifact, unlike every other platform consumer.

**Where a restatement is forced, a fence compares the copies** (root
`CLAUDE.md`, "The Constellation Law"). `tests/contract.test.ts` holds every one:
`API` against `DEFAULT_API`, `VIA` against `DeploymentVia.N8N`, the README's
durations against `PUBLIC_DEPLOYMENT_TTL_SECONDS`, the operation catalogue
against the node's own `options` arrays, the `my.shipstatic.com/api-key` link
against `MY_API_KEY_URL`, `WireError` against `ErrorResponse`, `SPA_CONFIG` /
`SHIP_JSON` against `SPA_DEFAULT_CONFIG` and its filename, the
`Idempotency-Key` header against `IDEMPOTENCY_KEY_CONSTRAINTS.HEADER`, the
password range against `PASSWORD_CONSTRAINTS`, the claim promise, the
destructive-op hints, the credential shape, the README contract — and, the
fence the manifest cannot be, the BUILT `dist/**/*.js` requiring nothing
outside `n8n-workflow` and node builtins. `n8n-node build` is a `tsc`
transpile, not a bundle, so a devDependency that reached a value position
would install fine here and be MODULE_NOT_FOUND for every user.

**Examined and REFUSED, recorded so nobody re-proposes them:** no codegen —
deriving the ledger from types at build would make drift impossible instead of
red, but for ~10 scalars and two small tables a fence that fails beats a
generator plus a build stage plus a drift guard (revisit only if the ledger
triples). No `@shipstatic/types/wire` subpath — the sandbox forbids this node
importing it regardless, and no second hand-rolled client exists.
`parseLabels` is NOT types' `deserializeLabels` — different domains (UI
comma-split with absence semantics vs DB JSON-string with always-array
semantics); do not "unify" them. `errorType` stays this node's word for the
wire's `error` field — n8n's UI owns the `error` key; idiom, not drift. Two
fences were likewise DECLINED with the rule as the reason: a `DEPLOY_FIELDS`
row fence (loud, live-proven — a wrong field name fails every deploy on its
first try) and a credential-placeholder prefix fence (a prefix change is a
deliberate platform-wide break, never drift).

### The verification ruleset is a MOVING contract — pin it, but walk the pin

`@n8n/node-cli` is exact-pinned (the artifact-tool law: it emits the published
tarball). It also *carries* `@n8n/eslint-plugin-community-nodes`, which is the
ruleset **n8n Cloud verification is judged against** — an external contract that
changes without asking us. Pinning the tool therefore pins the contract, and a
pin left alone stops being a fence and becomes a souvenir.

**Measured 2026-08-18, and it is the sharpest instance of this the estate has.**
The pin sat at `0.23.1` while `latest` was `0.44.2` — 21 versions — which held
the verification plugin at `0.9.0` against a current `0.29.0`. **The ruleset had
gone from 56 rules to 176.** `pnpm lint:n8n` was green the whole time, against a
third of the contract it claimed to enforce. Bumping the pin turned up four
ERRORS that would plausibly have failed a Cloud verification submission:

- **`no-forbidden-lifecycle-scripts`** — `prepare` is banned outright in
  community node packages ("these scripts execute arbitrary code during
  installation"). The estate's git-hooks standard installs `core.hooksPath` via
  exactly that script, so this repo cannot carry it. See below.
- **`require-node-api-error` ×2** in `execute()` — both are RE-throws of errors
  already typed by `apiError`, so they carry inline disables naming that reason;
  re-wrapping would nest a typed error in itself and discard the `itemIndex`
  just attached.
- **`require-node-api-error`** in the suite — disabled for `tests/**` in
  `eslint.config.mjs`: `NodeApiError` needs a live `INode` to construct, and a
  fence reporting its own precondition is not node runtime behaviour.

One warning survives deliberately: **`icon-prefer-themed-variants`** wants the
`{ light, dark }` icon form. That is real work blocked on a dark brand SVG (a
design asset), not a code change — recorded, not suppressed.

**So: bump this pin on a schedule, not on a whim, and treat every new error it
surfaces as a verification finding rather than lint noise.** Renovate's grouped
devDep updates will offer it; do not auto-merge this one — read what the new
rules say. The bump is also proven safe for the artifact: the tarball's file
list is identical across `0.23.1` → `0.44.2`.

### No `prepare` script — the one place the estate's hook standard cannot reach

Root `CLAUDE.md`'s tooling standard installs the pre-commit hook with
`"prepare": "git config core.hooksPath scripts/githooks"`. **This repo may not
have it**: `prepare` is on the community-node ruleset's forbidden-lifecycle list
(with `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`,
`postprepare`), and that ruleset is the verification contract.

`prepack` is NOT on that list, so the tarball law is unaffected.

Enable the hook per clone, the same one-liner the super-repo root and
`integrations/action` already use for their own reasons:

```bash
git config core.hooksPath scripts/githooks
```

An existing clone keeps working — `core.hooksPath` lives in `.git/config` and
removing the script does not unset it.

### Two linters, and only one of them is a linter

`pnpm lint` is Biome — the platform's one lint + format tool. `pnpm lint:n8n` is
eslint carrying the community-nodes plugin above: the ruleset **n8n Cloud
verification is judged against**, a contract with an external party that happens
to ship as a plugin. Both run in CI. Formatting is Biome's alone.

### Release — the npm publish law, untranslated

**A branch push publishes. There is no tag ritual.** `development` → the `beta`
dist-tag, `main` → `latest`, exactly like `@shipstatic/ship`: the version picks
the channel (a `-` suffix → `beta`), the branch grants the right to use it, and
`npm-latest`'s `main`-only deployment branch policy is what refuses a stable
publish off an integration branch — GitHub declines the job before a step runs.
`.github/workflows/ci.yml` is the flagship's file byte-for-byte in the
`version` / `publish` / `release` / `notify` jobs; only `test` is this repo's.

**This repo was tag-driven until 2026-08-19, and the reason it no longer is
belongs here, because it is the kind of thing that gets re-proposed.** Releases
fired on `v*` from a second file (`npm-publish.yml`), which meant the law had to
be re-expressed clause by clause wherever the trigger broke it: a
`tag == "v" + package.json.version` assertion standing in for the branch, a
hand-rolled `merge-base` ancestry check standing in for the environment policy,
and a bespoke arm on `scripts/check-publish-law.sh` standing in for membership
of the fence. **None of it was ever owed.** `integrations/vscode` is tag-driven
because the Marketplace forbids semver prereleases; `integrations/action` is
tag-driven because the release IS the tag and there is no registry. This package
publishes to npm with dist-tags — nothing about its destination refuses the
native form, so the translation was cost with no matching property. It was
inherited from the neighbouring directories, not derived.

Converged at the only free moment: **zero tags had ever been pushed, zero
environments existed, and the pipeline had never once fired.** There was no
ritual to break and no consumer expectation to honour. The general rule, now in
root `CLAUDE.md`: a translation is a debt — before writing one, check whether
the repo actually owes it.

Consequences worth knowing: the trusted-publisher registration names **`ci.yml`**
(the filename is half the registration); `--access` / `--provenance` live in this
package's own `publishConfig`, never on the command; and `prepack` builds, so a
tarball cannot carry a stale `dist` however it is produced.

### The environment dimension lives in the harness

Every other platform surface derives its API URL from an environment variable.
This one cannot (see the sandbox contract), so `nodes/Shipstatic/api.ts` is a
plain production constant — the single owner of the fact, read by both the node
and the credential's connection test. `tests/live.test.ts` substitutes that one
module to drive the same `execute()` against a non-production API:

```bash
SHIP_API_URL=https://api.<env> SHIP_TOKEN=ship-your-api-key pnpm test --run live
```

It skips unless `SHIP_API_URL` is set, so it never runs in CI. `SHIP_DEPLOY_TOKEN`
unlocks the deploy-token scope block.

### HTTP Layer — Two Helpers, Each With One Job

```
apiRequest(ctx, method, path, body?)         JSON + n8n credential-aware auth (every CRUD op)
uploadDeployment(ctx, formData, token?)      POST /deployments multipart, auth attached by hand
```

Both wrap transport errors in `NodeApiError` at the I/O boundary so the rest of the node stays trivial — the dominant idiom in n8n core nodes.

**Why two?** Each uses the n8n helper that fits its job:
- **`apiRequest`** → `helpers.httpRequestWithAuthentication`. Most ops need n8n's credential system to inject the Bearer header.
- **`uploadDeployment`** → `helpers.request`. n8n's modern `httpRequest` does not reliably handle multipart `FormData` (proven across v0.5–0.6 of this node); the legacy `request` helper is the only path that produces a working multipart upload — same fallback Slack, S3, and Google Drive use for file uploads. Auth is manual because deploy is the ONE operation with optional credentials, and the credential-aware helper cannot express "send this header only if a credential exists".

**There was a third.** `fetchAgentToken` minted a short-lived token through `POST /tokens/agent` before every keyless deploy. The 2.x API deleted that endpoint, and the fix was a deletion rather than a port: anonymity is granted **in band** now — a credential-less `POST /deployments` receives the public-account agent identity per request, and the response carries the claim URL and expiry. The node's suite proves the deletion took by asserting a keyless deploy is exactly ONE request.

### Operations (15 total)

Operation names mirror the CLI/SDK/MCP resource verbs: get, list, set, delete, records, dns, share, validate, verify. **`delete`, never `remove`** — the 2026-07 rename swept the SDK (`delete()`), the CLI (`ship … delete`) and the MCP (`*_delete`); n8n was the last surface off it, and `tests/contract.test.ts` holds it there. The deploy verb diverges intentionally — n8n surfaces "Deploy" as the user-facing action (matching the `ship <path>` shortcut UX), while the CLI/SDK method and MCP tool are named `upload`. Same operation, different label.

The node ships `version: 1` as a scalar, and the non-use of n8n's node-version
machinery is a decision, not an omission: `version: [1, 2]` arrays are for
platforms with users to migrate, and 1.0 was a clean break for a handful of
users (the credential field renames, `remove` → `delete`, the anonymous-deploy
mechanism change) under the pre-launch clean-break law. Record the non-use,
don't build it.

| #   | Resource   | Operation | HTTP Call                                              |
| --- | ---------- | --------- | ------------------------------------------------------ |
| 1   | Deployment | Deploy    | `POST /deployments` multipart FormData (optional auth) |
| 2   | Deployment | Get       | `GET /deployments/{id}`                                |
| 3   | Deployment | List      | `GET /deployments` → fan out `.deployments`            |
| 4   | Deployment | Delete    | `DELETE /deployments/{id}` → `{deployment, status: 'deleting'}` (202) |
| 5   | Deployment | Set       | `PATCH /deployments/{id}` body `{labels}`              |
| 6   | Domain     | DNS       | `GET /domains/{name}/dns`                              |
| 7   | Domain     | Get       | `GET /domains/{name}`                                  |
| 8   | Domain     | List      | `GET /domains` → fan out `.domains`                    |
| 9   | Domain     | Records   | `GET /domains/{name}/records`                          |
| 10  | Domain     | Delete    | `DELETE /domains/{name}` → `{domain}` (200)            |
| 11  | Domain     | Set       | `PUT /domains/{name}` body `{deployment?, labels?}`    |
| 12  | Domain     | Share     | `GET /domains/{name}/share`                            |
| 13  | Domain     | Validate  | `POST /domains/validate` body `{domain: name}`         |
| 14  | Domain     | Verify    | `POST /domains/{name}/verify`                          |
| 15  | Account    | Get       | `GET /account`                                         |

### Deploy — Two Input Modes

Deploy has a **Binary File** toggle (matching the S3 node pattern):

- **Binary File ON** (default): reads files from binary data. Each input item becomes one file. Paths built from `binaryData.directory` + `binaryData.fileName`. Common directory prefixes are stripped for clean deployment URLs.
- **Binary File OFF**: takes text content + file name directly. Defaults to `index.html`. Single file deploy.

Both modes use n8n's `request` helper with the `formData` option — the same proven pattern used by Slack, S3, and Google Drive for multipart file uploads. The formData includes:

- `files[]` — one File entry per item (or one from text content)
- `checksums` — JSON array of MD5 hashes (via `node:crypto`)
- `via` — always `"n8n"` (the `VIA` constant; fenced against `DeploymentVia.N8N`)
- `labels` — optional JSON array
- `password` — optional plaintext (6–128 chars); the API hashes it server-side

**No server-processing flags.** `/deployments` is a pure file pipe — n8n never sets `spa`, `build`, or `prerender`. Those flags are reserved for first-party UI (`web/my`, `web/www`) routing through `/upload`. See `cloudflare/api/CLAUDE.md` "Endpoint Purity". For SPA routing, users include `ship.json` in their input files; the deployment serves it as-is.

### Deploy Auth — One Slot, Optional

The credential has **one field, `token`**, and it takes either platform
population: a `ship-` API key or a `deploy-` deploy token. The node never
inspects the prefix — the server classifies, with the same `classifyToken` the
SDK uses, so client and server cannot disagree on dispatch. The credential TYPE
id stays `shipstaticApi`: it names the platform, and renaming it would orphan
every stored credential.

Deploy attaches `Authorization` only when a token exists. Two boundary rules:

- **An empty field is absence of intent**, not a credential — it deploys
  anonymously rather than presenting a bare `Bearer `. Same normalization the
  SDK applies to an empty `SHIP_TOKEN`.
- **Fail-closed anonymity**: a token that is present and rejected fails with a
  typed error. It never demotes the deploy to an anonymous one under
  PUBLIC_ACCOUNT.

**The credential test's documented limit.** `GET /account` is the connection
test, and a `deploy-` token FAILS it — deploy tokens are deploy-scoped, and
`/account` is not their right. This is not a wart to route around: the API
refuses a deploy token at the auth boundary with a 401 **byte-identical to a
garbage credential** (`token_endpoint_not_allowed` is internal only), so no
probe could distinguish the two. Dropping the test or pointing it at `/ping`
would trade a truthful "this credential can use the whole node" signal for a
vacuous reachability blink. The field description and the 401 rule both say so,
and `tests/live.test.ts` observes it against a real API.

The `handleDeploy` function is extracted from `execute()` to keep credential
resolution (`getCredentials`) separate from request logic.

### Global vs Per-Item Operations

`list` and `account.get` are **global** — their result doesn't depend on input items. They run **once** regardless of input item count, and the output's `pairedItem` traces back to *all* input items so n8n's data flow stays honest. Per-item operations (`get`, `set`, `delete`, `dns`, `share`, `validate`, `verify`) loop over input items as usual, with `pairedItem: { item: i }`.

This matters: a workflow piping 50 items into "list" should not fire 50 identical API calls. The `isGlobalOp` switch in `execute()` controls iteration count.

Deploy is a special case — it collects ALL input items into a single deployment and pairs the one output to all of them.

### listSearch (Resource Locator Backends)

`deployment` and `domain` resource locators are populated by `methods.listSearch`:

- `searchDeployments` — `GET /deployments` via `httpRequestWithAuthentication`, returns `INodeListSearchResult`
- `searchDomains` — `GET /domains` via `httpRequestWithAuthentication`, returns `INodeListSearchResult`

Both accept an optional `filter` arg from the resource locator's search input and narrow results case-insensitively. Both probe credentials first (`hasCredentials()` helper). When credentials are absent — the typical state while a user is wiring up the node — they return `{ results: [] }` silently so the dropdown stays quiet. **Once credentials exist, real failures (invalid key, API down, rate-limited) bubble up** to the n8n UI rather than being swallowed. The probe never makes a network request.

### Options Collections

Optional parameters are grouped into `type: 'collection'` fields named `options`:

- **Deploy**: Labels, Password → accessed via `this.getNodeParameter('options', i) as IDataObject`
- **Domain Set**: Deployment, Labels → same pattern

### Return All / Limit — the walk

**The 2.x API paginates every list.** `ListOptions {limit, cursor}`; omitting
both returns the server's default first page; `cursor: null` is the entire
has-more signal. The 1.x API did not paginate, which is why this node used to
fetch once and slice — and why `Return All: true` silently stopped at the
server's default. `returnAll` is a CONTRACT WORD in n8n's ecosystem: every core
node's `returnAll` walks pages, and n8n's own lint rule
(`node-param-description-wrong-for-return-all`) enforces the sentence
"Whether to return all results or only up to a given limit" verbatim. The
phrase never needed fixing; the behaviour did.

`fetchList()` is the walk, and **no page size appears in this repo**:

- `returnAll: true` → request with no `limit`, follow `cursor` until `null`.
- `returnAll: false` + `limit: N` → ask for what is still needed, and keep going
  if the server returned less. The server clamps silently at its own cap; the
  clamp is handled by CONTINUING, never by knowing the number. Restating the
  cap here would give one fact two owners.
- An empty page with a live cursor terminates the walk — out of contract, and
  looping on it would hang an n8n execution rather than fail it.

`listSearch` uses the same contract under n8n's own name: `INodeListSearchResult`
carries `paginationToken`, and the listSearch signature receives it back on the
next call. **The cursor IS the pagination token**, so the dropdowns scroll
through everything instead of stopping at page one. Filtering stays client-side
and therefore per page — the API has no filter query.

`cursor` is deliberately ABSENT from the item json: `returnAll`/`limit` is n8n's
pagination abstraction, and handing a workflow a cursor it has no field to feed
back would be a second, broken one.

### Why this was invisible for a whole wave

The §0 break inventory scanned the node's code for stale calls — the mint, the
verbs, the credential — and caught every one. It could not catch pagination,
because **a missing feature is invisible in the code that lacks it**. Neither
could the live tier (the dev account holds fewer than one page) nor the typed
fixtures (they carry `cursor`; the node ignored it). The inventory that finds
this class runs the other direction: **the API's contract against the
consumer's coverage, never the consumer against itself.**

### Error Handling — the wire rides beside the message

Uses n8n's standard pattern: `continueOnFail()` returns an error item; otherwise
throws with `itemIndex` for precise attribution.

**The item is typed.** The platform's law is "clients branch on error type and
status, never on message strings", and a workflow engine is the caller MOST able
to obey it — this json feeds an IF node. So `error` stays the message string
(n8n's UI renders it) and the wire's own fields ride BESIDE it:

```
{ error: "Deployment not found", errorType: "not_found", status: 404, details?: … }
```

Captured by `readWireError()` at the two request helpers, before `NodeApiError`
wraps the failure, and read back at both `continueOnFail` sites via
`errorItem()`. n8n's helpers surface a non-2xx body in different places
depending on which of them threw, so each known shape is read and anything else
is treated as ABSENT — **a transport failure carries `error` alone**. Inventing
an `errorType` for a DNS failure would claim the platform answered when nothing
did. Same posture as the MCP's `toErrorResult`.

This was the failure-path mirror of returning delete acknowledgements verbatim,
and it was missed by the wave that fixed the success path.

### SPA parity

The SDK's deploy path runs `detectAndConfigureSPA` for the CLI, both MCP
transports and the VS Code extension. This node is direct HTTP, so without a
mirror a React build deployed from a workflow serves 404s on every route but
`/` — on the ONE surface whose users are least equipped to know that
`ship.json` is the remedy.

`detectSpa()` mirrors the SDK exactly: `POST /spa-check` (public, no credential
— verified anonymously against dev), and on `isSPA` append the restated
`SPA_CONFIG` as `ship.json`. It skips when the user shipped their own config,
skips when `index.html` is absent or over 100KB, and **continues silently on
any failure** — detection is an enhancement, never a gate on the deploy. The
append happens BEFORE formData is built so the config's checksum rides along;
after it, the API would reject the deploy for a length mismatch.

### Option completeness

Every absence is a decision, recorded — the MCP's section, translated:

- **No `tokens` operations.** The MCP's reasoning verbatim: a credential is
  configured by the human, never minted by the agent that would then hold it.
- **No `ping` / `limits` operations.** Diagnostics, not workflow steps.
- **No `GET /labels` operation.** An open product call platform-wide, not an
  n8n-specific gap.
- **No client-side prevalidation** of blocked extensions or junk files. Inputs
  here are curated by upstream nodes, the API is the security boundary, and its
  messages relay through `NodeApiError` intact. A second validator would be a
  second owner of the rules.
- **No `spa` / `build` / `prerender` flags.** `/deployments` is a pure file
  pipe; those belong to first-party UI through `/upload`. (SPA *detection* is
  different — it appends a file, it does not ask the server to process one.)
- **SPA detection degrades silently for heavy KEYLESS use, by design.**
  `/spa-check` charges an anonymous caller the public write bucket (its AI tier
  costs real money) and exempts a credentialed one — which is why `detectSpa`
  presents the token when there is one. A credential-less workflow deploying in
  a tight loop will eventually get a 429 on the pre-flight; it is swallowed, so
  the deploy still succeeds and only the routing config stops being added.
  Discovered empirically while running the live tier repeatedly. If someone
  reports "SPA routing works sometimes", this is it — and the answer is an API
  key, not a node change.
- **No explicit deploy timeout.** The node passes none, so n8n's own default
  applies and the deploy is bounded by the operator's `EXECUTIONS_TIMEOUT`.
  This is deliberate: the SDK needed `DEFAULT_DEPLOY_TIMEOUT` because it drives
  `fetch` and had to choose a number, whereas the helper here is HOST-provided
  and a hardcoded value would override a deliberate operator setting. **If a
  large deploy is ever reported timing out**, that is the thing to re-check —
  set `timeout` on the `uploadDeployment` request options, sized like the SDK's
  (30s cannot carry 50MB over a slow link).

### Labels

Labels are comma-separated strings in the UI, parsed to `string[]` by `parseLabels()`. Returns `undefined` for empty input (not empty array) to distinguish "not provided" from "clear all".

**Domain Set vs Deployment Set merge semantics:** both use the same rule — if the user added the Labels option (key present in `options`), behavior is "set" (`['a','b']` to replace, `[]` to clear). If they didn't add Labels at all, the key is omitted from the request body and the API preserves existing labels. This matches the merge-upsert contract on `PUT /domains/:name`.

### AI-Agent Hints in Operation Descriptions

`usableAsTool: true` means n8n's AI Agent feature exposes this node's operations to LLMs using the `description` strings as the tool catalog. We deliberately keep descriptions terse for the dropdown UX, but **append agent guidance** to the high-stakes ops:

- **Deploy** mentions the claim URL convention and the password-Options affordance. The claim promise is FENCED (`tests/contract.test.ts`) — it is the only way a keyless deployment is ever kept, so an edit that drops it fails the suite.
- **Deployment Delete / Domain Delete** include "Confirm with the user before calling this — it cannot be undone." A fence in `tests/contract.test.ts` holds both.

This is the n8n-side equivalent of MCP's `You MUST confirm` and `always show the URL/claim` agent hints. The MCP wording is more imperative because MCP-driven agents typically converse with end-users; n8n-driven agents typically pipe results downstream, so the wording is softer. If you add a destructive op, mirror this pattern.

## Testing

```bash
pnpm test --run     # All tests (~250ms)
pnpm coverage       # …plus the ratchet: 100 statements/functions/lines, 98.2 branches
```

The default tier mocks `helpers.request` and `helpers.httpRequestWithAuthentication` — no real HTTP calls. Two files sit beside it:

- **`tests/contract.test.ts`** — the fences (see "The sandbox contract"). They hold what a percentage cannot: restated platform values, the operation catalogue, the published README, and the built artifact's imports.
- **`tests/live.test.ts`** — the same `execute()` against a real API, opt-in via `SHIP_API_URL`. It is the only tier that can observe the platform rather than the node's self-consistency, and it is what proved the `/tokens/agent` deletion, the claim/expiry pass-through, `via` landing in the database, and the deploy-token 401.

The branch ratchet is 98.2 for exactly the implicit `else` arms on the `operation` chains in `execute()`, unreachable because n8n only ever passes a value from the `options` array it rendered. Named in `vitest.config.ts`, not rounded away.

### Organization

Tests are organized by **implementation surface**, mirroring the file's top-down structure. New tests slot into the describe that owns the surface they exercise:

| Describe | Surface tested |
|---|---|
| `parseLabels` | Pure helper |
| `stripCommonPrefix` | Pure helper |
| `extractResourceLocatorValue` | Pure helper |
| `Deploy — authentication` | `handleDeploy` credential resolution + the anonymous door |
| `Deploy — file collection & formData` | `handleDeploy` file pipeline (binary/text, paths, MD5, payload) |
| `Deploy — SPA routing` | `handleDeploy` SPA detection + the `ship.json` append |
| `Deploy — idempotency` | `handleDeploy` `Idempotency-Key` threading |
| `Deploy — error handling` | `handleDeploy` failure paths (empty files, rejected token, rate limit, continueOnFail trace) |
| `Deployment operations` | `execute()` routing for the Deployment resource |
| `Domain operations` | `execute()` routing for the Domain resource (incl. set merge-upsert semantics) |
| `Auth gate for non-deploy operations` | `execute()` credential gate |
| `Global vs per-item iteration` | `execute()` list/account run-once + list controls (returnAll/limit) |
| `Pagination` | `fetchList()` cursor walk (returnAll / limit / empty-page termination) |
| `Error handling — NodeApiError & continueOnFail` | `execute()` per-item error wrapping |
| `listSearch — credential probe & filtering` | `methods.listSearch` (resource locator backends) |
| `listSearch — pagination` | `searchPage()` `paginationToken` threading |

### Adding new coverage

1. **Identify the implementation surface** the new behavior belongs to (HTTP helper? `handleDeploy` step? `execute()` routing? `listSearch`?).
2. **Add to the matching describe.** Don't create a new describe unless the surface itself is new.
3. **For new resources/operations**, add a single endpoint-shape test in the resource's describe (method + URL + body); add a per-item or global-fan-out test in `Global vs per-item iteration` if the iteration shape is non-trivial.

## Adding New Operations

1. Add operation entry to the relevant resource's `operation` options array (alphabetical order)
2. Add parameter fields with `displayOptions` to show/hide per operation
3. Add HTTP call in the `execute()` method's resource/operation routing via `apiRequest()`
4. List operations: fan out the array into separate n8n items
5. **Never fabricate a response.** The wire's acknowledgement IS the item json — `{ deployment, status: 'deleting' }`, `{ domain }`, `{ domain, hash }`. The old doctrine here was "void operations: return `{ success: true }`", and it was the platform's "state, not boolean" anti-pattern with a WORKFLOW ENGINE as its consumer: the caller most able to branch on structure, handed the least. A deployment delete is asynchronous — the site stays served until cleanup completes — and `success: true` threw exactly the state a workflow would want to wait on.
6. Add it to `CATALOGUE` in `tests/contract.test.ts` and to the README table; both are fenced.

## Known Gotchas

### `pnpm dev` Does Not Render `file:` Icons

`n8n-node dev` creates a symlink that n8n's icon serving doesn't resolve. The icon always shows as the generic fallback in dev mode. **Works correctly when installed from npm.**

### SVG Icon Requirements

No `<filter>`, `<clipPath>`, `<mask>`, `<style>`, or embedded CSS. n8n sanitizes SVGs and strips these.

### Dependabot Reports ~58 Alerts And Zero Of Them Ship

Measured 2026-08-18: 1 critical, 25 high, 28 moderate, 4 low on the default
branch. **The correct response is to read the scope column, not the count.**

- **Everything dev-scoped** — including the critical (`handlebars`, JS injection
  via AST type confusion) — arrives through `@n8n/node-cli` →
  `@n8n/ai-node-sdk` → `@n8n/ai-utilities` → langchain. That is the build
  toolchain. It never reaches `dist/`, and `dist/` is the whole published
  artifact.
- **The three "runtime"-scoped alerts** (`lodash` ×2, `form-data`) come from
  `n8n-workflow`, which is a **peerDependency**. Dependabot scores peers as
  runtime. We do not ship it — the user's n8n instance provides it, at whatever
  version that instance carries — so there is nothing to patch here. Pinning it
  would mean this node dictating the host's own internals.

The zero-dependency architecture is what makes the count irrelevant, and it is
PROVEN rather than asserted: `dependencies: {}` on the registry, and
`tests/contract.test.ts`'s artifact fence showing the built bytes require
nothing but `n8n-workflow` and `node:crypto`.

**So this number will never reach zero and must not be chased.** The one real
maintenance action is keeping `@n8n/node-cli` current — exact-pinned by the
artifact-tool law, so it moves as a deliberate bump, not a range resolution.
Narrowing the `n8n-workflow` peer range would not change any of this.

### `n8n-node build` Sweeps the WHOLE Repo for `.png` / `.svg`

`@n8n/node-cli`'s `copyStaticFiles` globs `**/*.{png,svg}` across the entire
repository — ignoring only `dist` and `node_modules` — and copies every match
into `dist/`. It is how the node and credential icons get built, and it does not
distinguish them from anything else.

So `pnpm coverage` (which writes `coverage/favicon.png` and
`coverage/sort-arrow-sprite.png`) followed by a pack put those two files in the
published tarball. **The tarball's contents depended on which untracked
directories happened to exist at build time** — measured 2026-08-19, and made to
matter by `prepack`, which turns a local `npm pack` into a sanctioned path.

The fix is in the manifest, not the build: `files` enumerates the artifact
(`dist/credentials`, `dist/nodes`) instead of sweeping `dist`. A stray asset can
still land in `dist/` and now cannot ship — and `dist/package.json` and
`dist/tsconfig.tsbuildinfo` stopped shipping with it. `tests/contract.test.ts`
holds both halves: the exact `files` value, and that every path the manifest
declares as an entry point (`main`, the `n8n` block) lives inside a shipped
tree — because narrowing `files` without that second check could publish a
package whose own `n8n` block points at files it does not contain.

The old assertion was `expect(PKG.files).toEqual(['dist'])` under the name
"ships nothing but dist/". It stated a value where an invariant belonged, and
the value it stated was the one that let the sweep through.

### `~/.n8n/custom/` Needs a `package.json`

When manually installing, `npm init -y` first. Without it, npm installs into a parent directory.

## Resource Locator Pattern

`deployment` and `domain` use n8n's modern **`type: 'resourceLocator'`** with two modes each:

| Field | Modes | Notes |
|---|---|---|
| `deployment` (top-level + inner Options) | `list` (search the user's deployments), `id` (free-text hostname) | Powered by `methods.listSearch.searchDeployments` |
| `domain` (top-level, ALL domain ops) | `list` (search the user's domains), `name` (free-text — supports new domains for `set` / `validate`) | Powered by `methods.listSearch.searchDomains` |

Reading values in `execute()`:

```ts
// Top-level resource locators
const id = this.getNodeParameter('deployment', i, '', { extractValue: true }) as string;
const name = this.getNodeParameter('domain', i, '', { extractValue: true }) as string;

// Inner-collection resource locators — `extractValue` only works at the top
// level, so we unwrap manually via `extractResourceLocatorValue()`:
const linked = extractResourceLocatorValue(domainOptions.deployment);
```

`searchDeployments` / `searchDomains` share `searchPage()`: one page per call, the API's `cursor` returned as n8n's `paginationToken` so the dropdown scrolls through everything, and a client-side filter over that page (the API has no filter query). Both use the same `hasCredentials()` probe as the rest of the node — silent empty results when the user hasn't configured credentials yet, real errors surface once they have.

---

_This file provides Claude Code guidance. User-facing documentation lives in README.md._
