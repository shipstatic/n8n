# CLAUDE.md

Claude Code instructions for the **ShipStatic n8n Community Node**.

**n8n-nodes-shipstatic** — n8n community node for the ShipStatic static hosting platform. Direct HTTP calls to the ShipStatic API — zero runtime dependencies. Published to npm. **Maturity:** v0.7.x — Deployments + Domains (15 operations), optional credentials, n8n Cloud verified.

## Architecture

```
nodes/Shipstatic/
├── Shipstatic.node.ts     # Node definition + execute() — all 15 operations
├── Shipstatic.node.json   # Codex metadata (categories, aliases)
└── shipstatic.svg         # Node icon (simplified logo, no SVG filters)

credentials/
└── ShipstaticApi.credentials.ts   # API key credential type
```

## Quick Reference

```bash
pnpm build          # TypeScript → dist/ (uses n8n-node build)
pnpm test --run     # All tests (~200ms)
pnpm dev            # Dev mode with hot reload (icon won't show — see Known Gotchas)
```

## Core Patterns

### Direct HTTP — No SDK, No Dependencies

Every operation is a direct HTTP call to `https://api.shipstatic.com`. Zero runtime dependencies — required for n8n Cloud verification. The n8n layer handles:

- UI definition (resource/operation selectors, parameter fields)
- Credential retrieval → Bearer token header
- Routing by resource + operation → HTTP call via `httpRequestWithAuthentication`
- Binary data → FormData multipart deploy (using Web API globals)
- Response shaping (list fan-out, void → `{ success: true }`)

### HTTP Layer — Three Helpers, Each With One Job

```
apiRequest(ctx, method, path, body?)         JSON + n8n credential-aware auth (every CRUD op)
fetchAgentToken(ctx)                         POST /tokens/agent — bootstrap for unauthenticated deploys
uploadDeployment(ctx, authorization, fd)     POST /deployments multipart with manual Bearer
```

All three wrap transport errors in `NodeApiError` at the I/O boundary so the rest of the node stays trivial — the dominant idiom in n8n core nodes.

**Why three?** Each uses the n8n helper that fits its job:
- **`apiRequest`** → `helpers.httpRequestWithAuthentication`. Most ops need n8n's credential system to inject the Bearer header.
- **`fetchAgentToken`** → `helpers.request`. The `/tokens/agent` endpoint is intentionally unauthenticated (it's the bootstrap for users who have no credentials), so n8n's credential helper can't be used.
- **`uploadDeployment`** → `helpers.request`. n8n's modern `httpRequest` does not reliably handle multipart `FormData` (proven across v0.5–0.6 of this node); the legacy `request` helper is the only path that produces a working multipart upload — same fallback Slack, S3, and Google Drive use for file uploads. Auth is manual because the same upload may be Bearer'd with either an API key or a short-lived agent token.

### Operations (15 total)

Operation names mirror the CLI/SDK/MCP resource verbs: get, list, set, remove, records, dns, share, validate, verify. The deploy verb diverges intentionally — n8n surfaces "Deploy" as the user-facing action (matching the `ship <path>` shortcut UX), while the CLI/SDK method and MCP tool are named `upload`. Same operation, different label.

| #   | Resource   | Operation | HTTP Call                                              |
| --- | ---------- | --------- | ------------------------------------------------------ |
| 1   | Deployment | Deploy    | `POST /deployments` multipart FormData (optional auth) |
| 2   | Deployment | Get       | `GET /deployments/{id}`                                |
| 3   | Deployment | List      | `GET /deployments` → fan out `.deployments`            |
| 4   | Deployment | Remove    | `DELETE /deployments/{id}` → `{success: true}`         |
| 5   | Deployment | Set       | `PATCH /deployments/{id}` body `{labels}`              |
| 6   | Domain     | DNS       | `GET /domains/{name}/dns`                              |
| 7   | Domain     | Get       | `GET /domains/{name}`                                  |
| 8   | Domain     | List      | `GET /domains` → fan out `.domains`                    |
| 9   | Domain     | Records   | `GET /domains/{name}/records`                          |
| 10  | Domain     | Remove    | `DELETE /domains/{name}` → `{success: true}`           |
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
- `via` — always `"n8n"`
- `labels` — optional JSON array
- `password` — optional plaintext (6–128 chars); the API hashes it server-side

**No server-processing flags.** `/deployments` is a pure file pipe — n8n never sets `spa`, `build`, or `prerender`. Those flags are reserved for first-party UI (`web/my`, `web/www`) routing through `/upload`. See `cloudflare/api/CLAUDE.md` "Endpoint Purity". For SPA routing, users include `ship.json` in their input files; the deployment serves it as-is.

### Deploy Auth — Optional Credentials

Deploy works without credentials. When no API key is configured, the node fetches a short-lived agent token from `POST /tokens/agent` and uses that as the Bearer token. All other operations require an API key and use `httpRequestWithAuthentication`.

The `handleDeploy` function uses `request` (with `formData`) for both the agent token and deploy calls. It's extracted from `execute()` to keep credential resolution (`getCredentials`) separate from request logic.

### Global vs Per-Item Operations

`list` and `account.get` are **global** — their result doesn't depend on input items. They run **once** regardless of input item count, and the output's `pairedItem` traces back to *all* input items so n8n's data flow stays honest. Per-item operations (`get`, `set`, `remove`, `dns`, `share`, `validate`, `verify`) loop over input items as usual, with `pairedItem: { item: i }`.

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

### Return All / Limit

Both List operations include `returnAll` (boolean) and `limit` (number). Client-side slicing via `.slice(0, limit)` — the API doesn't paginate.

### Error Handling

Uses n8n's standard pattern: `continueOnFail()` returns `{ error: message }` items; otherwise throws `NodeOperationError` with `itemIndex` for precise error attribution.

### Labels

Labels are comma-separated strings in the UI, parsed to `string[]` by `parseLabels()`. Returns `undefined` for empty input (not empty array) to distinguish "not provided" from "clear all".

**Domain Set vs Deployment Set merge semantics:** both use the same rule — if the user added the Labels option (key present in `options`), behavior is "set" (`['a','b']` to replace, `[]` to clear). If they didn't add Labels at all, the key is omitted from the request body and the API preserves existing labels. This matches the merge-upsert contract on `PUT /domains/:name`.

### AI-Agent Hints in Operation Descriptions

`usableAsTool: true` means n8n's AI Agent feature exposes this node's operations to LLMs using the `description` strings as the tool catalog. We deliberately keep descriptions terse for the dropdown UX, but **append agent guidance** to the high-stakes ops:

- **Deploy** mentions the claim URL convention and the password-Options affordance.
- **Deployment Remove / Domain Remove** include "Confirm with the user before calling this — it cannot be undone."

This is the n8n-side equivalent of MCP's `You MUST confirm` and `always show the URL/claim` agent hints. The MCP wording is more imperative because MCP-driven agents typically converse with end-users; n8n-driven agents typically pipe results downstream, so the wording is softer. If you add a destructive op, mirror this pattern.

## Testing

```bash
pnpm test --run     # All tests (~230ms)
```

Tests mock `helpers.request` and `helpers.httpRequestWithAuthentication` — no real HTTP calls.

### Organization

Tests are organized by **implementation surface**, mirroring the file's top-down structure. New tests slot into the describe that owns the surface they exercise:

| Describe | Surface tested |
|---|---|
| `parseLabels` | Pure helper |
| `Deploy — authentication` | `handleDeploy` credential resolution + `fetchAgentToken` fallback |
| `Deploy — file collection & formData` | `handleDeploy` file pipeline (binary/text, paths, MD5, payload) |
| `Deploy — error handling` | `handleDeploy` failure paths (empty files, agent-token fail, upload fail, continueOnFail trace) |
| `Deployment operations` | `execute()` routing for the Deployment resource |
| `Domain operations` | `execute()` routing for the Domain resource (incl. set merge-upsert semantics) |
| `Auth gate for non-deploy operations` | `execute()` credential gate |
| `Global vs per-item iteration` | `execute()` list/account run-once + list controls (returnAll/limit) |
| `Error handling — NodeApiError & continueOnFail` | `execute()` per-item error wrapping |
| `listSearch — credential probe & filtering` | `methods.listSearch` (resource locator backends) |

### Adding new coverage

1. **Identify the implementation surface** the new behavior belongs to (HTTP helper? `handleDeploy` step? `execute()` routing? `listSearch`?).
2. **Add to the matching describe.** Don't create a new describe unless the surface itself is new.
3. **For new resources/operations**, add a single endpoint-shape test in the resource's describe (method + URL + body); add a per-item or global-fan-out test in `Global vs per-item iteration` if the iteration shape is non-trivial.

## Adding New Operations

1. Add operation entry to the relevant resource's `operation` options array (alphabetical order)
2. Add parameter fields with `displayOptions` to show/hide per operation
3. Add HTTP call in the `execute()` method's resource/operation routing via `apiRequest()`
4. List operations: fan out the array into separate n8n items
5. Void operations: return `{ success: true }`

## Known Gotchas

### `pnpm dev` Does Not Render `file:` Icons

`n8n-node dev` creates a symlink that n8n's icon serving doesn't resolve. The icon always shows as the generic fallback in dev mode. **Works correctly when installed from npm.**

### SVG Icon Requirements

No `<filter>`, `<clipPath>`, `<mask>`, `<style>`, or embedded CSS. n8n sanitizes SVGs and strips these.

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

`searchDeployments` / `searchDomains` filter client-side (the API doesn't paginate; full list comes back from one call) and use the same `hasCredentials()` probe as the rest of the node — silent empty results when the user hasn't configured credentials yet, real errors surface once they have.

---

_This file provides Claude Code guidance. User-facing documentation lives in README.md._
