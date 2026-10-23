# CLAUDE.md

Claude Code instructions for the **ShipStatic n8n Community Node**.

**n8n-nodes-shipstatic** is the n8n community node for the ShipStatic static hosting platform: direct HTTP calls to the ShipStatic API, zero runtime dependencies, published to npm. **Maturity:** v2.x; the 2.x node speaks to the **3.x platform**. Deployments + Domains (15 operations), optional credentials, n8n Cloud verified.

**A passthrough node takes a major for a wire change its own code does not show.** The node passes the API's JSON through as item json, so a changed field meaning (a domain's `status` word, say) silently breaks an IF node branching on it. The version is the only warning such a workflow gets. Each major's breaks are listed here:

- **2.0.0: a domain's `status` is its standing** (`live`, `unlinked`, `unverified`, `paused`), not the DNS enum (`pending`, `partial`, `success`); the DNS fact moved to `verification`, joined by `verified`, `verifications` and `paused`. The node's own code did not change.

## Architecture

```
nodes/Shipstatic/
├── Shipstatic.node.ts     # Node definition + execute(): all 15 operations
├── api.ts                 # The API base URL: one fact, two readers
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
pnpm test --run     # All tests (the live tier skips without SHIP_API_URL)
pnpm coverage       # The suite plus the ratchet: what CI runs
pnpm typecheck      # tsc over nodes, credentials AND tests, 0 errors
pnpm lint           # Biome (the platform standard)
pnpm lint:n8n       # The n8n Cloud VERIFICATION ruleset, see "Two linters"
pnpm dev            # Dev mode with hot reload (icon won't show, see Known Gotchas)
```

## Core Patterns

### Direct HTTP: No SDK, No Dependencies

Every operation is a direct HTTP call to `https://api.shipstatic.com`. Zero runtime dependencies, required for n8n Cloud verification. The n8n layer handles:

- UI definition (resource/operation selectors, parameter fields)
- Credential retrieval → Bearer token header
- Routing by resource + operation → HTTP call via `httpRequestWithAuthentication`
- Binary data → FormData multipart deploy (using Web API globals)
- Response shaping (list fan-out; **acknowledgements pass through verbatim**)

### The sandbox contract, and what it costs

This is the ONE consumer of the platform that cannot import the facts it
depends on. `@n8n/eslint-plugin-community-nodes` enforces two rules that are
platform contracts rather than style:

- **`no-restricted-imports`**: any non-relative import in `nodes/` or
  `credentials/` is refused. It matches the import STATEMENT, so even
  `import type`, which provably erases, is rejected. `@shipstatic/types` is
  therefore a **devDependency the suite imports and the node restates**.
- **`no-restricted-globals`**: `process`, `globalThis`, `setTimeout`,
  `__dirname` and friends. n8n Cloud sandboxes community nodes away from these,
  so reading `process.env` at module load is a **ReferenceError before the
  node loads**. This is why the artifact has no `SHIP_API_URL` override.

**Where a restatement is forced, a fence compares the copies.**
`tests/contract.test.ts` holds every one: `API` against `DEFAULT_API`, `VIA`
against `DeploymentVia.N8N`, the README's durations against
`PUBLIC_DEPLOYMENT_TTL_SECONDS`, the operation catalogue against the node's own
`options` arrays, the `my.shipstatic.com/api-key` link against
`MY_API_KEY_URL`, `WireError` against `ErrorResponse`, the `Idempotency-Key`
header against `IDEMPOTENCY_KEY_CONSTRAINTS.HEADER`, the password range against
`PASSWORD_CONSTRAINTS`, the Files (JSON) grammar against `DEPLOY_FILE_GRAMMAR`,
the claim promise, the destructive-op hints, the credential shape, the README
contract, and the BUILT `dist/**/*.js` requiring nothing outside `n8n-workflow`
and node builtins. `n8n-node build` is a `tsc` transpile, not a bundle, so a
devDependency in a value position would install fine here and be
MODULE_NOT_FOUND for every user.

**Examined and REFUSED, so none is re-proposed:**

- **No codegen** deriving the ledger from types at build: for about ten
  scalars and two small tables, a fence that fails beats a generator plus a
  build stage plus a drift guard. Revisit if the ledger triples.
- **No `@shipstatic/types/wire` subpath**: the sandbox forbids the import
  regardless, and no second hand-rolled client exists.
- **`parseLabels` is not `deserializeLabels`**: UI comma-split with absence
  semantics against DB JSON-string with always-array semantics. Do not unify.
- **`errorType` stays this node's word** for the wire's `error` field, because
  n8n's UI owns the `error` key.
- **Two fences declined**: a `DEPLOY_FIELDS` row fence (a wrong field name
  fails every deploy on its first try, so drift is loud) and a
  credential-placeholder prefix fence (a prefix change is a deliberate
  platform-wide break, never drift).

### The two floors

**`n8n-workflow >= 1.83.0` is where the code compiles** (`NodeConnectionTypes`
is absent at 1.82.0); the suite cannot RUN there (no exports map), so the claim
is "compiles", not "passes". n8n 1.85.0 carries it: **n8n >= 1.85.0**.

**`engines.node` is `>=20.19`**: n8n 2.0.0's own `engines.node` and the
platform's published-package floor. A higher floor would exclude hosts the code
floor supports.

**Support is declared at n8n 2.x, narrower than what compiles, by decision.**
2.x is what the suite runs against and what n8n Cloud serves; claiming the
wider range would claim something untested. Do not "fix" the engines value
toward the compile floor.

**`peerDependencies` stays `"*"`.** It is what n8n's own scaffolding emits, and
a narrowed range may trip the verification scanner or the installer. The floor
lives in prose, knowingly. Reopen when a scan of a narrowed range passes.

### The verification ruleset is a MOVING contract: pin it, but walk the pin

`@n8n/node-cli` is exact-pinned (it emits the published tarball). It also
*carries* `@n8n/eslint-plugin-community-nodes`, the ruleset **n8n Cloud
verification is judged against**, an external contract that changes without
asking. Pinning the tool pins the contract, so a pin left alone stops being a
fence. **Treat every new error a bump surfaces as a verification finding, not
lint noise**, and confirm the tarball's file list is unchanged across the bump.
Two mechanisms hold this:

- **`renovate.json` carries a `packageRules` entry** setting
  `automerge: false` for `@n8n/node-cli`, with both reasons in the rule: it
  emits the published tarball, and it carries an external contract. A bump
  waits for a human.
- **`pnpm lint:n8n` runs `--max-warnings 0`**, so every rule the ruleset gains
  is blocking, whatever severity n8n ships it at.

**The tree carries exactly one suppression**: the themed-icon warning, inline
at the `icon` line with its reason and expiry ("The Themed-Icon Warning Is
Refused On The Merits", below). Inline rather than an `off` in
`eslint.config.mjs`, so the decision is visible where the icon is. The suite
switches `require-node-api-error` off for `tests/**` in `eslint.config.mjs`:
`NodeApiError` needs a live `INode`, and a fence reporting its own precondition
is not node runtime behaviour.

### `npm pkg set` deletes this package's most load-bearing field

`dependencies: {}` is half of how the zero-runtime-dependency contract is read
(the other half is `tests/contract.test.ts`'s artifact fence over the built
bytes). **Any `npm pkg set` on this manifest silently drops the empty
object**, because npm treats an empty collection as nothing to write. Edit this
manifest with a JSON reader that preserves it, or re-add the field and let the
suite confirm before you commit.

### No `prepare` script

The platform's other repos install the pre-commit hook with
`"prepare": "git config core.hooksPath scripts/githooks"`. **This repo may not
have it**: `prepare` is on the community-node ruleset's forbidden-lifecycle list
(with `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`,
`postprepare`), and that ruleset is the verification contract. `prepack` is NOT
on that list, so it builds the tarball. Enable the hook per clone:

```bash
git config core.hooksPath scripts/githooks
```

### Two linters, and only one of them is a linter

`pnpm lint` is Biome, the platform's one lint and format tool. `pnpm lint:n8n`
is eslint carrying the community-nodes plugin above. Both run in CI. Formatting
is Biome's alone.

**`pnpm lint:n8n` APPROXIMATES the verification contract; it is not that
contract.** `@n8n/scan-community-package` is what n8n runs, and it differs in
three ways:

- **`allowInlineConfig: false`.** Every `eslint-disable` in this repo is
  OVERRULED during the check that decides Cloud listing. **A rule you disagree
  with must be resolved in the CODE, not annotated away.**
- **It fails on `errorCount > 0` only.** Warnings appear in the report and do
  not fail it, which is what makes the themed-icon refusal survivable.
- **It lints twice**: the source it fetches from GitHub *by provenance
  attestation*, and the published tarball. The provenance is how the scanner
  finds the source, a second reason the trusted-publishing posture matters.

**The scan is the authority and needs a PUBLISHED version**, so it runs
outside CI. Run it on every release candidate:

```bash
npx @n8n/scan-community-package n8n-nodes-shipstatic@<version>
```

### Release

**Bump `version` in `package.json` and push. There is no tag ritual.** A
prerelease (`-` suffix) publishes to `beta` (from either branch, normally `development`), a stable one to
`latest` from `main`; the `npm-latest` environment admits `main` only, so
GitHub declines a stable publish off `development` before a step runs.
`.github/workflows/ci.yml` runs `test` → `version` → `publish` → `release` →
`notify`, the same file as `@shipstatic/ship`'s outside the `test` job.

- **The trusted-publisher registration names `ci.yml`**: renaming the file
  breaks publishing silently.
- **`--access` / `--provenance` live in `publishConfig`**, never on the command.
- **`prepack` builds**, so a tarball cannot carry a stale `dist` however it is
  produced.
- **A tag-driven release is refused.** A translated release model is owed only
  where the registry refuses the native one (the Marketplace forbids semver
  prereleases; an action has no registry). npm takes dist-tags, so nothing here
  owes one.

### The environment dimension lives in the harness

Every other platform surface derives its API URL from an environment variable.
This one cannot (the sandbox contract), so `nodes/Shipstatic/api.ts` is a plain
production constant, the single owner of the fact, read by both the node and
the credential's connection test. `tests/live.test.ts` substitutes that one
module to drive the same `execute()` against a non-production API:

```bash
SHIP_API_URL=https://api.<env> SHIP_TOKEN=ship-your-api-key pnpm test --run live
```

It skips unless `SHIP_API_URL` is set, so it never runs in CI.

### HTTP Layer: Two Helpers, Each With One Job

```
apiRequest(ctx, method, path, body?)         JSON + n8n credential-aware auth (every CRUD op)
uploadDeployment(ctx, formData, token?)      POST /deployments multipart, auth attached by hand
```

Both wrap transport errors in `NodeApiError` at the I/O boundary, the dominant idiom in n8n core nodes.

- **`apiRequest`** → `helpers.httpRequestWithAuthentication`, so n8n's credential system injects the Bearer header.
- **`uploadDeployment`** → `helpers.request`. The modern `httpRequest` did not handle multipart `FormData` when measured; the legacy `request` helper produces a working multipart upload, the same fallback n8n's own Slack, S3 and Google Drive nodes use. Auth is manual because deploy is the ONE operation with optional credentials, and the credential-aware helper cannot express "send this header only if a credential exists".

**This is a WATCHED refusal, not a permanent one.** `helpers.request` is
formally deprecated (`@deprecated Use .httpRequest instead` in
`n8n-workflow`'s `interfaces.d.ts`, as is `requestWithAuthentication`). It
works on current n8n 2.x, and n8n's own core nodes ride it, so removal would
break them first. The measurement behind "`httpRequest` can't do multipart" is
from 0.x of this node, so the refusal carries a named condition:

> **Re-measure `httpRequest` multipart against current n8n at the next
> maintenance window, and MANDATORILY before adopting any n8n 3.x, or on any
> changelog signal that the legacy helpers are being removed. If the modern
> helper handles multipart, migrate at leisure.**

Anonymity is granted **in band**: a credential-less `POST /deployments`
receives the public-account identity per request, and the response carries the
claim URL and expiry. The suite asserts a keyless deploy is exactly ONE request.

### Operations (15 total)

Operation names mirror the CLI/SDK/MCP resource verbs: get, list, set, delete, records, dns, share, validate, verify. **`delete`, never `remove`**, held by `tests/contract.test.ts`. The deploy operation's value is `upload` (the SDK method and MCP tool name) and its label is "Deploy" (the platform's human word for the act).

The node ships `version: 1` as a scalar. n8n's node-version machinery
(`version: [1, 2]`) is for migrating stored workflows across a change in the
node's own parameters; it is not used, by decision. Adopt it the first time a
change to the node's own parameters would break a stored workflow, since the
node now has users to migrate.

| #   | Resource   | Operation | HTTP Call                                              |
| --- | ---------- | --------- | ------------------------------------------------------ |
| 1   | Deployment | Deploy (`upload`) | `POST /deployments` multipart FormData (optional auth) |
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
| 15  | Account    | Whoami (`whoami`) | `GET /account`                                 |

### Naming: the decision rule, stated once

**The platform's idioms come first; the host is accommodated after.** Every
naming question here is a lookup against three clauses:

1. **Operation VALUES follow the platform's resource verbs, always.** They are
   the stored contract in a saved workflow *and* the tool grammar an agent
   reads (`usableAsTool` surfaces values, not labels).
2. **DISPLAY labels go to whichever word wins on host enforcement or audience
   clarity.** "Deploy" because it is the platform's own title for the act
   (`UPLOAD_TOOL_TITLE` is "Deploy Static Site"); "List" because it is the
   platform's verb and the community ruleset carries no get-many rule (adopt
   "Get Many" as display-only if n8n ever enforces it). "Whoami" follows its
   verb, since no platform title pulls the other way.
3. **Host-owned mechanism words stay the host's**: `returnAll`, `limit`,
   `input`, `binaryPropertyName`. Where n8n enforces a word (its lint pins
   `returnAll`'s description sentence verbatim), the host has already won.

**A rename of an operation value is a `typeVersion`-grade break.**

**Audited and KEPT** (do not re-run the sweep): resource values (`deployment`/`domain`/`account`, the
constitution's entity names); all nine domain verbs and the deployment CRUD
verbs (byte-identical to MCP suffixes and SDK methods);
`labels`/`password`/`ttl`/`idempotencyKey`/`token`; the files grammar;
`errorType` beside n8n's owned `error` key; the credential type id
`shipstaticApi`.

**`spaDetect` is a positive match, not an oversight**: it is the published
option name (`DeploymentUploadOptions.spaDetect` in `@shipstatic/types`, and
the CLI's `--no-spa-detect`). On, the node sends `spa=true`; off, it sends
nothing. The option and the field (`DEPLOY_FIELDS.SPA`) are two names for two
layers, both the platform's own, and neither is renamed.

### Deploy: Three Input Modes

Deploy has an **Input** selector:

- **Binary Files** (default): reads files from binary data. Each input item
  becomes one file. Paths built from `binaryData.directory` +
  `binaryData.fileName`. **Common directory prefixes are stripped**: these
  paths carry an accident of where the files sat on a disk.
- **Text Content**: text + file name directly. Defaults to `index.html`, the
  home page every site needs: the platform refuses a deployment with no
  `index.html` at its root (the deploy rules in `@shipstatic/types`). The node
  does not check it; the refusal is relayed, and the deploy operation's
  description tells an agent first, fenced in `tests/contract.test.ts`. The
  File Name meets the same structural path check as the files grammar;
  binary paths stay exempt as machine-derived metadata.
- **Files (JSON)**: an array of `{ path, content, encoding? }`. The
  agent-native path, and the reason the selector exists: an AI Agent calling
  this node as a tool has **no channel for binary at all** ("How an AI Agent
  reaches this node", below).

Two consequences shape the field:

- **The resolved value is the main road.** n8n's `json` arm type-checks the
  VALUE, so an agent's array arrives already parsed. `JSON.parse` is the
  fallback for a hand-typed field.
- **The refusal names the array.** The host-side validator admits "a non-empty
  object OR a non-empty array", so an agent can send `{...}`. `null` is named
  as `null`, since `typeof null === 'object'`.

**The grammar's three divergences from the hosted MCP are DECIDED.** One shape
shared by two agent-facing surfaces is a contract only if both refuse the same
inputs:

| Behaviour | Decision |
|---|---|
| Path checks (empty, leading `/`, `\`, `.`/`..`, null byte) | **Mirrored** from the MCP's `validatePath`: fail before a wasted upload |
| base64 | **Structurally validated.** `Buffer.from(x,'base64')` NEVER throws; it silently discards anything outside the alphabet, so a payload the MCP refuses would deploy here as garbage bytes. Wrapped base64 is accepted; whitespace is transport, not garbage |
| Common-prefix stripping | **None in files mode.** These paths were WRITTEN, and the grammar promises "the site root is implied by these paths". Stripping stays binary-only, and a test pins it |

Structural validation of the node's OWN input format is the node's job;
PLATFORM POLICY (extensions, sizes, junk files) is the API's and relays
verbatim. That line permits the first two without contradicting "no
client-side prevalidation" below.

**Grammar ownership.** `{ path, content, encoding? }` with a `utf-8` default
is owned by `@shipstatic/types` (`DEPLOY_FILE_GRAMMAR`). The node keeps its own
literal table (the sandbox forbids the import), and `tests/contract.test.ts`
holds the copy to the owner and the field's description to the grammar.

All three modes use n8n's `request` helper with the `formData` option. Its field names are `DEPLOY_FORM`, held by `tests/contract.test.ts` to `DEPLOY_FIELDS` in `@shipstatic/types`. The formData includes:

- `files[]`: one File entry per item (or one from text content)
- `via`: always `"n8n"` (the `VIA` constant, fenced against `DeploymentVia.N8N`)
- `labels`: optional JSON array
- `password`: optional plaintext (6 to 128 chars); the API hashes it server-side
- `ttl`: optional lifetime in SECONDS, stringified (a multipart body is all
  strings; the API does the `Number()`)
- `spa`: `'true'` unless the toggle is off, and absent then. The platform
  asks the single-page question of a deploy that asks and writes the routing
  config itself; absence asks nothing

**TTL's absence rule is the one place the Labels pattern does NOT apply.**
`labels` and `password` are gated on TRUTHINESS: an empty string is absence of
intent. `ttl` is gated on KEY PRESENCE, so a `0` fed by an expression is
forwarded and the server refuses it with its own sentence. Swallowing it would
make this node a second validator of a range `TTL_CONSTRAINTS` owns, and would
show a deployment that never expires to someone who asked for one that expires
immediately. The field's `default: 3600` is what an unedited "Add Option" click
sends.

**A deploy is one request, by decision.** The node sends no manifest and no
digest; the API hashes what it receives. Sending a site in several requests is
the SDK's protocol, and restating it here would be a second copy of the SDK's
planner, upload loop and replay rule held by nothing but fences. The API's 413
for a site too large for one request is relayed as a sentence naming the CLI
(`npx @shipstatic/ship ./dist`). Expiry: n8n Cloud admits a dependency, and the
node takes the SDK.

**No build flags.** `/deployments` builds nothing, and the node never sets
`build` or `prerender`: those are reserved for the platform's first-party UI.
The single-page question is not a build, and the node asks it like every client
(`spa`, above). A `ship.json` among the user's files always wins.

### Deploy Auth: One Slot, Optional

The credential has **one field, `token`**, and it takes either platform
population: a `ship-` API key or a `deploy-` deploy token. The node never
inspects the prefix; the server classifies, with the same `classifyToken` the
SDK uses. The credential TYPE id stays `shipstaticApi`: it names the platform,
and renaming it would orphan every stored credential.

### The capability stays; the promotion goes

**Deploy tokens are accepted but not ADVERTISED anywhere in this node.** The
slot accepts either population, the server classifies, no code path blocks one,
and `tests/live.test.ts` deploys with a `deploy-` token every run.

**Every PROACTIVE surface names the API key alone**: the placeholder, the
credential description, the upgrade guard's message, the auth-gate hint for
credential-less account operations, and the README. These fire *before* a user
has a credential, and recommending one population is simpler than teaching a
taxonomy.

**Exactly one REACTIVE mention survives**: the credential test's 401 rule
message. It fires only for someone holding a deploy token who has just been
refused, and since the API does not tell that refusal apart from a bad
credential, it is the only place such a user learns the failure is by design.

The hosted MCP follows the same rule.

**Fenced by inversion.** `tests/contract.test.ts` pins that the placeholder,
the description, the BUILT node artifact and the README all do NOT contain
`DEPLOY_TOKEN.PREFIX` (the built artifact, because `tsc` strips the comments
that legitimately name the prefix). Re-promotion is therefore a deliberate
fence edit, never prose drifting back.

**Reversal condition:** when the platform starts promoting deploy tokens for
integrations, restore the two-population copy; the inverted fences go red the
moment it returns, asking whether it was meant.

Deploy attaches `Authorization` only when a token exists. Three boundary rules:

- **No credential ATTACHED is the anonymous door**, and it is the product.
  `getCredentials` throws; the deploy proceeds keyless.
- **A credential attached with an EMPTY slot is refused.** A credential created
  for the 0.x node stored its value under `apiKey`, which this node does not
  read, so an upgraded workflow arrives with a credential attached and an empty
  `token`. Deploying that anonymously would SUCCEED with a public, expiring
  deployment where the user expected a permanent one. **A wrong success is the
  worst failure this node has.** Attaching a credential in a UI is a deliberate
  act, unlike an unset env var.
- **Fail-closed anonymity**: a token that is present and rejected fails with a
  typed error. It never demotes the deploy to an anonymous one.

**The other 0.x migration guard is IMPOSSIBLE.** A 0.x text-mode workflow
stored `binaryData: false`, which this node does not declare, and
`getNodeParameters` iterates the DECLARED property array only, so the key is
never visited. That break stays loud by accident (the missing binary field
errors); the README's upgrade section and the release notes are the
mitigation.

**The credential test's documented limit.** `GET /account` is the connection
test, and a `deploy-` token FAILS it by design: deploy tokens are
deploy-scoped. Dropping the test or pointing it at `/ping` would trade a
truthful "this credential can use the whole node" signal for a vacuous
reachability blink. The field description and the 401 rule both say so, and
`tests/live.test.ts` observes it against a real API.

`handleDeploy` is extracted from `execute()` to keep `getCredentials` separate
from request logic.

### Global vs Per-Item Operations

`list` and `account.whoami` are **global**: their result doesn't depend on input items. They run **once** regardless of input item count, and the output's `pairedItem` traces back to *all* input items so n8n's data flow stays honest. Per-item operations (`get`, `set`, `delete`, `dns`, `share`, `validate`, `verify`) loop over input items, with `pairedItem: { item: i }`. A workflow piping 50 items into "list" must not fire 50 identical API calls; the `isGlobalOp` switch in `execute()` controls iteration count.

Deploy is a special case: it collects ALL input items into a single deployment and pairs the one output to all of them.

### Options Collections

Optional parameters are grouped into `type: 'collection'` fields named `options`, read via `this.getNodeParameter('options', i) as IDataObject`:

- **Deploy**: Idempotency Key, Labels, Password, Single-Page App Routing, TTL
- **Domain Set**: Deployment, Labels

### Return All / Limit: the walk

**The API paginates every list.** `ListOptions {limit, cursor}`; omitting
both returns the server's default first page; `cursor: null` is the entire
has-more signal. `returnAll` is a CONTRACT WORD in n8n's ecosystem: every core
node's `returnAll` walks pages, and n8n's lint rule
(`node-param-description-wrong-for-return-all`) enforces the sentence "Whether
to return all results or only up to a given limit" verbatim.

`fetchList()` is the walk, and **no page size appears in this repo**:

- `returnAll: true` → request with no `limit`, follow `cursor` until `null`.
- `returnAll: false` + `limit: N` → ask for what is still needed, and keep going
  if the server returned less. The server clamps silently at its own cap; the
  clamp is handled by CONTINUING, never by knowing the number.
- An empty page with a live cursor terminates the walk: out of contract, and
  looping on it would hang an n8n execution rather than fail it.

`listSearch` uses the same contract under n8n's name: **the cursor IS the
`paginationToken`**, so the dropdowns scroll through everything. Filtering
stays client-side and per page (the API has no filter query).

`cursor` is deliberately ABSENT from the item json: `returnAll`/`limit` is n8n's
pagination abstraction, and a cursor with no field to feed it back would be a
second, broken one.

**Audit a consumer API-first.** A missing feature is invisible in the code that
lacks it, so the inventory that finds one runs the API's contract against the
consumer's coverage, never the consumer against itself.

### Error Handling: the wire rides beside the message

`continueOnFail()` returns an error item; otherwise the node throws with
`itemIndex`. **The item is typed.** Clients branch on error type and status, never on
message strings, and this json feeds an IF node. So `error` stays the message
string (n8n's UI renders it) and the wire's own fields ride BESIDE it:

```
{ error: "Deployment not found", errorType: "not_found", status: 404, details?: … }
```

Captured by `readWireError()` at the two request helpers, before `NodeApiError`
wraps the failure, and read back at both `continueOnFail` sites via
`errorItem()`. n8n's helpers surface a non-2xx body in different places, so each
known shape is read and anything else is treated as ABSENT: **a transport
failure carries `error` alone**, since inventing an `errorType` would claim the
platform answered when nothing did. The MCP's `toErrorResult` takes the same
posture.

### The single-page question

The node asks it of every deploy by default, exactly as the CLI, both MCP
transports and the VS Code extension do: it sends `spa=true` unless the toggle
is off, and when the files are an app the API writes the routing config. So a
React build deployed from a workflow deep-links instead of serving 404s on
every route but `/`, for the users least equipped to know that `ship.json` is
the remedy, at no extra request. The node holds no copy of the config, the
classifier or its size bound.

### Option completeness

**Every public API route was enumerated and diffed against the node's fifteen
operations; all fifteen map to a live route.** Each uncovered route has a
verdict:

| Uncovered route | Verdict |
|---|---|
| `GET /deployments/:deployment/config` | **Refuse.** Neither the SDK nor either MCP exposes it. It serves the dashboard's config viewer; a workflow that wants the routing config has the `ship.json` it deployed |
| `GET /domains/:domain/propagation` | **Refuse.** No client exposes it. It backs the DNS-setup UI's live poll, a UI affordance; `verify` is the operation that advances state |
| `GET /labels` | **Refuse** for now: an open product call platform-wide, not an n8n gap |
| `POST/GET/DELETE /tokens*` | **Refuse**: a credential is configured by the human |
| `GET /ping`, `GET /limits` | **Refuse**: diagnostics, not workflow steps |
| `GET /account/consent`, `PUT /account/key`, `POST /account/claim`, `DELETE /account` | **Refuse.** Account *administration*, not automation. `PUT /key` mints a credential, `DELETE /account` is destructive-irreversible with no workflow use, and claiming is a human act on a one-time URL the deploy response already hands over |
| `GET /activities` | **Refuse.** An audit feed for the dashboard; a workflow wanting deployment state reads the deployment |
| First-party and operator routes | **Refuse by standing law**: they are not the node's surface. `/deployments` is the public contract |

**The node's surface is exactly the hosted MCP's fifteen**, two
independently maintained agent-facing surfaces landing on the same verbs.

Every other absence is a decision too:

- **No client-side prevalidation** of blocked extensions or junk files. Inputs
  are curated by upstream nodes, the API is the security boundary, and its
  messages relay through `NodeApiError` intact.
- **A keyless workflow in a tight loop meets the anonymous rate limit at the
  upload**, the node's one request; a keyless 429 gets the "add an API key"
  advice. The answer to "my deploys are rate limited" is an API key, not a node
  change.
- **No explicit deploy timeout.** n8n's own default applies and the deploy is
  bounded by the instance's `EXECUTIONS_TIMEOUT`: the helper is HOST-provided,
  and a hardcoded value would override a deliberate setting. **If a large
  deploy is reported timing out**, set `timeout` on the `uploadDeployment`
  request options, sized like the SDK's `DEFAULT_DEPLOY_TIMEOUT`.

### Labels

Labels are comma-separated strings in the UI, parsed to `string[]` by `parseLabels()`. Returns `undefined` for empty input (not empty array) to distinguish "not provided" from "clear all".

**Domain Set and Deployment Set share one merge rule:** if the user added the Labels option (key present in `options`), behaviour is "set" (`['a','b']` to replace, `[]` to clear). If not, the key is omitted and the API preserves existing labels, matching the merge-upsert contract on `PUT /domains/:name`.

### How an AI Agent reaches this node

Read from `n8n-workflow`'s shipped implementation (`from-ai-parse-utils.js`,
`constants.js`); the Files (JSON) mode rests on it.

**The agent's only channel into a node is `$fromAI()`, and it carries four
types: `string`, `number`, `boolean`, `json`.** A user (or n8n's auto-override,
marked `/*n8n-auto-generated-fromAI-override*/`) puts a
`$fromAI('key', 'description', 'type', default)` call into a parameter's
expression; n8n builds the tool schema the LLM sees from those calls.

1. **There is no binary channel in a tool invocation.** Binary reaches a node
   through input items, not parameters, so Binary Files mode is unreachable
   from a pure agent tool call.
2. **A `json` parameter arrives ALREADY PARSED.** `generateZodSchema` validates
   the *value* ("a non-empty object or a non-empty array"), so the files field
   must accept the resolved value as its PRIMARY path, not as defensive code.

### AI-Agent Hints in Operation Descriptions

`usableAsTool: true` means n8n's AI Agent exposes this node's operations to LLMs using the `description` strings as the tool catalogue. Descriptions stay terse for the dropdown, with **agent guidance appended** to the high-stakes ops:

- **Deploy** mentions the claim URL convention and the password-Options affordance. The claim promise is FENCED (`tests/contract.test.ts`): it is the only way a keyless deployment is ever kept.
- **Deployment Delete / Domain Delete** include "Confirm with the user before calling this — it cannot be undone." A fence in `tests/contract.test.ts` holds both.

The MCP servers carry no such sentences: there, confirmation is the `destructiveHint` annotation's job and the claim relay lives in the server's `instructions`. n8n has neither, so the descriptions are the only place the guidance can live, softly worded because n8n-driven agents typically pipe results downstream. If you add a destructive op, mirror this pattern.

## Testing

```bash
pnpm test --run     # All tests
pnpm coverage       # …plus the ratchet: 100 statements/functions/lines, 98.2 branches
```

The default tier mocks `helpers.request` and `helpers.httpRequestWithAuthentication`: no real HTTP calls. Two files sit beside it:

- **`tests/contract.test.ts`**: the fences (see "The sandbox contract"). They hold what a percentage cannot: restated platform values, the operation catalogue, the published README, and the built artifact's imports.
- **`tests/live.test.ts`**: the same `execute()` against a real API, opt-in via `SHIP_API_URL`. The only tier that observes the platform rather than the node's self-consistency: the claim/expiry pass-through, `via` landing, the deploy-token 401.

**The live tier has two credential halves, and each block skips
independently.** `SHIP_TOKEN`, an API key for the API under test read without
ever printing its value, unlocks the authenticated blocks; `SHIP_DEPLOY_TOKEN`
unlocks the deploy-token scope block. The deploy token is minted for the run
(`POST /tokens` with a short `ttl` and a label) and deleted when the run ends,
so no long-lived scratch credential accumulates. That does not contradict the "no `tokens`
operations" refusal: the refusal governs what an agent driving the node is
handed, and a harness creating a scoped, short-lived credential on a test
account and destroying it is a different act.

**Served HTML is rewritten in transit.** The platform adds an immutable-cache
buster to asset URLs, so a deployed `<img src="pixel.gif">` is served as
`pixel.gif?_ship=…`. Live tests assert CONTENT for HTML and byte equality only
for binaries, where nothing rewrites.

The branch ratchet is 98.2 for exactly the implicit `else` arms on the `operation` chains in `execute()`, unreachable because n8n only passes a value from the `options` array it rendered. Named in `vitest.config.ts`, not rounded away.

### Organization

Tests are organized by **implementation surface**, mirroring the file's top-down structure. New tests slot into the describe that owns the surface they exercise:

| Describe | Surface tested |
|---|---|
| `parseLabels` | Pure helper |
| `stripCommonPrefix` | Pure helper |
| `extractResourceLocatorValue` | Pure helper |
| `Deploy — authentication` | `handleDeploy` credential resolution + the anonymous door |
| `Deploy — file collection & formData` | `handleDeploy` file pipeline (binary/text, paths, payload) |
| `Deploy — SPA routing` | `handleDeploy` the `spa` field and its toggle |
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

1. **Identify the implementation surface** the new behaviour belongs to (HTTP helper? `handleDeploy` step? `execute()` routing? `listSearch`?).
2. **Add to the matching describe.** Don't create a new describe unless the surface itself is new.
3. **For new resources/operations**, add a single endpoint-shape test in the resource's describe (method + URL + body); add a per-item or global-fan-out test in `Global vs per-item iteration` if the iteration shape is non-trivial.

## Adding New Operations

1. Add operation entry to the relevant resource's `operation` options array (alphabetical order)
2. Add parameter fields with `displayOptions` to show/hide per operation
3. Add HTTP call in the `execute()` method's resource/operation routing via `apiRequest()`
4. List operations: fan out the array into separate n8n items
5. **Never fabricate a response.** The wire's acknowledgement IS the item json: `{ deployment, status: 'deleting' }`, `{ domain }`, `{ domain, hash }`. Never `{ success: true }`: a workflow engine is the caller most able to branch on structure, and a deployment delete is asynchronous (the site stays served until cleanup completes), which is exactly the state a workflow would wait on.
6. Add it to `CATALOGUE` in `tests/contract.test.ts` and to the README table; both are fenced.

## Known Gotchas

### Running a real n8n

- **n8n injects `__CUSTOM_API_CALL__`** into the resource and operation lists of
  any credentialed node. It is not ours, it is absent from our `options` arrays,
  and the catalogue fence is right to ignore it. Do not "fix" it.
- **`pnpm dlx n8n` cannot boot**: the SQLite driver is a native binding pnpm's
  dlx store does not build. Use `npx n8n@latest start`, with an isolated
  `N8N_USER_FOLDER` so a test install never touches your own `~/.n8n`.

### `pnpm dev` Does Not Render `file:` Icons

`n8n-node dev` creates a symlink that n8n's icon serving doesn't resolve. The icon always shows as the generic fallback in dev mode. **Works correctly when installed from npm.**

### The Themed-Icon Warning Is Refused On The Merits

`@n8n/community-nodes/icon-prefer-themed-variants` wants
`icon: { light, dark }`, and the `n8n-workflow` typing allows that form
(`Themed<IconFile>`). Neither the types nor a missing asset is the reason.

**The rule warns on SHAPE and cannot see content.** It fires on any string
icon; the problem it exists for is an icon with a transparent ground and dark
strokes, which vanishes on a dark canvas. This mark is a solid `#EE6723` tile
with white glyphs: it carries its own ground and renders identically either
way, so a themed pair would be two files differing in nothing. Nothing is owed
and no asset is pending.

**Expiry:** if the brand mark ever loses its tile (a transparent ground, or
glyphs that borrow the host's colour), the rule becomes correct and the pair is
owed that day.

The suppression sits inline at the `icon` line, the only one in the tree. The
verification scan ignores it (`allowInlineConfig: false`) and reports the
warning, which does not fail the scan.

### SVG Icon Requirements

No `<filter>`, `<clipPath>`, `<mask>`, `<style>`, or embedded CSS. n8n sanitizes SVGs and strips these.

### Dependabot alerts: read the scope column, not the count

- **Everything dev-scoped** arrives through `@n8n/node-cli` and its toolchain.
  It never reaches `dist/`, and `dist/` is the whole published artifact.
- **The "runtime"-scoped alerts** come from `n8n-workflow`, a
  **peerDependency**: the user's n8n instance provides it, at whatever version
  it carries, so there is nothing to patch here, and pinning it would dictate
  the host's internals. Narrowing the peer range would not change this.

The zero-dependency architecture makes the count irrelevant, and it is proven:
`dependencies: {}` on the registry and the artifact fence over the built bytes.
**The number will never reach zero and must not be chased.** The one real
maintenance action is keeping `@n8n/node-cli` current, as a deliberate bump.

### `n8n-node build` Sweeps the WHOLE Repo for `.png` / `.svg`

`@n8n/node-cli`'s `copyStaticFiles` globs `**/*.{png,svg}` across the entire
repository (ignoring only `dist` and `node_modules`) and copies every match into
`dist/`. So `pnpm coverage` (which writes `coverage/favicon.png`) followed by a
pack would ship coverage assets, and `prepack` makes a local `npm pack` a
sanctioned path.

**`files` enumerates the artifact** (`dist/credentials`, `dist/nodes`) instead
of sweeping `dist`. `tests/contract.test.ts` holds both halves: the exact
`files` value, and that every path the manifest declares as an entry point
(`main`, the `n8n` block) lives inside a shipped tree, so narrowing `files`
cannot publish a package whose own `n8n` block points at files it lacks.

### `~/.n8n/custom/` Needs a `package.json`

When manually installing, `npm init -y` first. Without it, npm installs into a parent directory.

## Resource Locator Pattern

`deployment` and `domain` use n8n's modern **`type: 'resourceLocator'`** with two modes each:

| Field | Modes | Notes |
|---|---|---|
| `deployment` (top-level + inner Options) | `list` (search the user's deployments), `id` (free-text hostname) | Powered by `methods.listSearch.searchDeployments` |
| `domain` (top-level, ALL domain ops) | `list` (search the user's domains), `name` (free-text, supports new domains for `set` / `validate`) | Powered by `methods.listSearch.searchDomains` |

Reading values in `execute()`:

```ts
// Top-level resource locators
const id = this.getNodeParameter('deployment', i, '', { extractValue: true }) as string;
const name = this.getNodeParameter('domain', i, '', { extractValue: true }) as string;

// Inner-collection resource locators: `extractValue` only works at the top
// level, so we unwrap manually via `extractResourceLocatorValue()`:
const linked = extractResourceLocatorValue(domainOptions.deployment);
```

`methods.listSearch.searchDeployments` (`GET /deployments`) and `searchDomains` (`GET /domains`) go through `httpRequestWithAuthentication`, return `INodeListSearchResult`, and share `searchPage()`: one page per call, the API's `cursor` returned as n8n's `paginationToken`, and a case-insensitive client-side `filter` over that page.

Both probe credentials first (`hasCredentials()`, no network request): without credentials, the usual state while a user wires up the node, they return `{ results: [] }` silently. **Once credentials exist, real failures (invalid key, API down, rate-limited) bubble up** to the n8n UI.

---

_This file provides Claude Code guidance. User-facing documentation lives in README.md._
