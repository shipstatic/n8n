# CLAUDE.md

Claude Code instructions for the **ShipStatic n8n Community Node**.

**n8n-nodes-shipstatic** — n8n community node that exposes the ShipStatic SDK as workflow actions. Thin wrapper over `@shipstatic/ship`. Published to npm. **Maturity:** v0.2.x — Deployments + Domains (13 operations), optional credentials.

## Architecture

```
nodes/Shipstatic/
├── Shipstatic.node.ts     # Node definition + execute() — all 13 operations
├── Shipstatic.node.json   # Codex metadata (categories, aliases)
└── shipstatic.svg         # Node icon (simplified logo, no SVG filters)

credentials/
└── ShipstaticApi.credentials.ts   # API key credential type
```

## Quick Reference

```bash
pnpm build          # TypeScript → dist/ (uses n8n-node build)
pnpm test --run     # All tests (17 tests, ~200ms)
pnpm dev            # Dev mode with hot reload (icon won't show — see Known Gotchas)
```

## Core Patterns

### SDK Wrapper — No Business Logic

Every operation maps 1:1 to a single `@shipstatic/ship` SDK method. Same pattern as the MCP integration. The n8n layer handles only:
- UI definition (resource/operation selectors, parameter fields)
- Credential retrieval → `new Ship({ apiKey })`
- Routing by resource + operation → SDK call
- Binary data → temp directory materialization (upload)
- Response shaping (list fan-out, void → `{ success: true }`)

No HTTP calls, no auth logic, no domain validation. The SDK handles everything.

### Operations (13 total, matching MCP)

| # | Resource | Operation | SDK Call |
|---|----------|-----------|---------|
| 1 | Deployment | Upload | `ship.deployments.upload(tempDir, {labels, via: 'n8n'})` — accepts binary data, works without credentials |
| 2 | Deployment | Get Many | `ship.deployments.list()` → fan out `.deployments` |
| 3 | Deployment | Get | `ship.deployments.get(id)` |
| 4 | Deployment | Update | `ship.deployments.set(id, {labels})` |
| 5 | Deployment | Delete | `ship.deployments.remove(id)` → `{success: true}` |
| 6 | Domain | Create or Update | `ship.domains.set(name, {deployment?, labels?})` |
| 7 | Domain | Get Many | `ship.domains.list()` → fan out `.domains` |
| 8 | Domain | Get | `ship.domains.get(name)` |
| 9 | Domain | Get DNS Records | `ship.domains.records(name)` |
| 10 | Domain | Validate | `ship.domains.validate(name)` |
| 11 | Domain | Verify DNS | `ship.domains.verify(name)` |
| 12 | Domain | Delete | `ship.domains.remove(name)` → `{success: true}` |
| 13 | Account | Get | `ship.whoami()` |

### Binary Data Upload

Upload accepts binary data from upstream nodes (e.g. Read Binary Files, HTTP Request). Each input item becomes one file in the deployment — all items are collected, written to a temp directory (preserving `directory`/`fileName` from binary metadata), and deployed as a single deployment. Temp directory is cleaned up in a `finally` block. This follows n8n's standard pattern: every first-party upload node (S3, Google Drive, Slack) accepts binary data, not filesystem paths.

### pairedItem

Every `returnData.push()` includes `pairedItem: { item: i }` to enable n8n's data flow tracing between nodes. List fan-outs pair all items to the input item that triggered the list call. Binary upload pairs the single result to all input items.

### loadOptions (Dynamic Dropdowns)

`deploymentId` and `domainName` (for existing domains) use `loadOptions` to populate dropdowns from the API. Two loader methods in `methods.loadOptions`:

- `getDeployments` — `GET /deployments` via `httpRequestWithAuthentication` (uses credential's Bearer header)
- `getDomains` — `GET /domains` via `httpRequestWithAuthentication`

Both return empty arrays on error (user can still type manually via expression). The `domainName` field is split into two: one with loader (get, records, verify, delete — existing domains) and one without (set, validate — new/any domain names). The `Deployment` field inside the Domain Set options collection also uses `getDeployments`.

### Options Collections

Optional parameters are grouped into `type: 'collection'` fields named `options`, following the first-party n8n pattern:

- **Upload**: Labels → accessed via `this.getNodeParameter('options', i) as IDataObject`
- **Domain Set**: Deployment, Labels → same pattern

Required parameters (Input Binary Field, Deployment ID, Domain Name, Labels for Update) remain top-level fields.

### Return All / Limit

Both "Get Many" operations (deployments, domains) include `returnAll` (boolean) and `limit` (number, shown when returnAll=false). Client-side slicing via `.slice(0, limit)` — the API doesn't paginate.

### Deployment Tracking

`deployments.upload` sets `via: 'n8n'` — matching MCP's `via: 'mcp'` and CLI's `via: 'cli'`.

### Error Handling

Uses n8n's standard pattern: `continueOnFail()` returns `{ error: message }` items; otherwise throws `NodeOperationError` with `itemIndex` for precise error attribution.

### Labels

Labels are comma-separated strings in the UI, parsed to `string[]` by `parseLabels()`. Returns `undefined` for empty input (not empty array) to distinguish "not provided" from "clear all" per SDK conventions.

### Optional Credentials

The credential is `required: false`. Upload works without credentials (claimable deployments, 3-day TTL). All other operations require an API key.

In `execute()`, `this.getCredentials('shipstaticApi')` resolves to a Ship instance via `.then()`. If no credential is configured, `.catch()` either creates a keyless Ship (upload) or throws `NodeOperationError` with guidance (all other operations).

`ShipstaticApi` credential provides the API key. The `authenticate` property (Bearer header) is used by the `test` property to verify credentials — `GET /account` with the Bearer token. The SDK handles auth separately via `new Ship({ apiKey })`.

### Verified Node Status

n8n's verification guidelines prohibit runtime dependencies in verified community nodes. Our node depends on `@shipstatic/ship` (required for upload: file processing, MD5, SPA detection, multipart). We publish as **unverified**. This is deliberate — the SDK wrapper is the correct architecture for our use case.

## Testing

```bash
pnpm test --run     # All tests (17 tests, ~200ms)
```

```
tests/
└── Shipstatic.node.test.ts   # Business logic tests (17 tests)
```

Tests cover business logic only — not n8n framework scaffolding:
- `parseLabels` — comma parsing, trimming, empty filtering
- Credential resolution — with key, without key + upload, without key + other
- Upload — `via: 'n8n'`, label forwarding, multi-item collection, directory structure, temp cleanup on error
- Error handling — continueOnFail for both upload (batch) and per-item operations
- List slicing — returnAll vs limit
- Void operations — `{ success: true }` convention
- Domain set — empty string → undefined coercion

### Manual Testing

1. **Via `pnpm dev`** — hot-reload dev mode, icon won't render (see below), but all operations work
2. **Via real install** — `pnpm build && npm pack`, then install the `.tgz` into `~/.n8n/custom/`

```bash
pnpm build && npm pack
cd ~/.n8n/custom && npm init -y && npm install /path/to/n8n-nodes-shipstatic-0.2.0.tgz
npx n8n
```

## Adding New Operations

1. Add operation entry to the relevant resource's `operation` options array
2. Add parameter fields with `displayOptions` to show/hide per operation
3. Add SDK call in the `execute()` method's resource/operation routing
4. List operations: fan out the array into separate n8n items
5. Void operations: return `{ success: true }`

## Known Gotchas

### `pnpm dev` Does Not Render `file:` Icons

`n8n-node dev` creates a symlink from `~/.n8n-node-cli/.n8n/custom/node_modules/n8n-nodes-shipstatic` → source directory. n8n's icon serving does not resolve `file:` references through symlinks, so the icon always shows as the generic fallback in dev mode. This is a known n8n limitation (see [#22452](https://github.com/n8n-io/n8n/issues/22452), [#12944](https://github.com/n8n-io/n8n/issues/12944)).

**The icon works correctly when installed from npm or from a `.tgz` (real install into `~/.n8n/custom/`).** Verified 2026-03-11.

### SVG Icon Requirements

The SVG must be simple — no `<filter>`, `<clipPath>`, `<mask>`, `<style>`, or embedded CSS. n8n sanitizes SVGs and strips these elements. The current `shipstatic.svg` is a flat version of the logo (orange rect + white paths, no drop shadows). Do not re-export from the original Figma/design file without stripping filters first.

### `~/.n8n/custom/` Needs a `package.json`

When manually installing a node into `~/.n8n/custom/`, you must `npm init -y` first. Without a `package.json`, npm silently installs packages into a parent directory instead of `~/.n8n/custom/node_modules/`.

---

*This file provides Claude Code guidance. User-facing documentation lives in README.md.*
