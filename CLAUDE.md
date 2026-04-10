# CLAUDE.md

Claude Code instructions for the **ShipStatic n8n Community Node**.

**n8n-nodes-shipstatic** — n8n community node for the ShipStatic static hosting platform. Direct HTTP calls to the ShipStatic API — zero runtime dependencies. Published to npm. **Maturity:** v0.4.x — Deployments + Domains (13 operations), optional credentials, n8n Cloud verified.

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
pnpm test --run     # All tests (~200ms)
pnpm dev            # Dev mode with hot reload (icon won't show — see Known Gotchas)
```

## Core Patterns

### Direct HTTP — No SDK, No Dependencies

Every operation is a direct HTTP call to `https://api.shipstatic.com`. Zero runtime dependencies — required for n8n Cloud verification. The n8n layer handles:

- UI definition (resource/operation selectors, parameter fields)
- Credential retrieval → Bearer token header
- Routing by resource + operation → HTTP call via `httpRequestWithAuthentication`
- Binary data → FormData multipart upload (using Web API globals)
- Response shaping (list fan-out, void → `{ success: true }`)

### Operations (13 total)

| #   | Resource   | Operation        | HTTP Call                                              |
| --- | ---------- | ---------------- | ------------------------------------------------------ |
| 1   | Deployment | Upload           | `POST /deployments` multipart FormData (optional auth) |
| 2   | Deployment | Get Many         | `GET /deployments` → fan out `.deployments`            |
| 3   | Deployment | Get              | `GET /deployments/{id}`                                |
| 4   | Deployment | Update           | `PATCH /deployments/{id}` body `{labels}`              |
| 5   | Deployment | Delete           | `DELETE /deployments/{id}` → `{success: true}`         |
| 6   | Domain     | Create or Update | `PUT /domains/{name}` body `{deployment?, labels?}`    |
| 7   | Domain     | Get Many         | `GET /domains` → fan out `.domains`                    |
| 8   | Domain     | Get              | `GET /domains/{name}`                                  |
| 9   | Domain     | Get DNS Records  | `GET /domains/{name}/records`                          |
| 10  | Domain     | Validate         | `POST /domains/validate` body `{domain: name}`         |
| 11  | Domain     | Verify DNS       | `POST /domains/{name}/verify`                          |
| 12  | Domain     | Delete           | `DELETE /domains/{name}` → `{success: true}`           |
| 13  | Account    | Get              | `GET /account`                                         |

### Binary Data Upload

Upload uses Web API `FormData` and `File` globals (Node 22+, no imports needed — passes n8n Cloud ESLint scanner). Each input item becomes one file in the deployment. All items are collected into a single `FormData`, with paths built from `binaryData.directory` + `binaryData.fileName`. Common directory prefixes are stripped for clean deployment URLs.

The multipart body includes:

- `files[]` — one File entry per binary item
- `checksums` — JSON array of MD5 hashes (via `node:crypto`)
- `via` — always `"n8n"`
- `spa` — always `"true"` (server-side SPA detection)
- `labels` — optional JSON array

### Upload Auth — Optional Credentials

Upload works without credentials. When no API key is configured, the node fetches a short-lived agent token from `POST /tokens/agent` and uses that as the Bearer token. All other operations require an API key and use `httpRequestWithAuthentication`.

### pairedItem

Every `returnData.push()` includes `pairedItem: { item: i }` to enable n8n's data flow tracing between nodes. List fan-outs pair all items to the input item that triggered the list call. Binary upload pairs the single result to all input items.

### loadOptions (Dynamic Dropdowns)

`deploymentId` and `domainName` (for existing domains) use `loadOptions` to populate dropdowns from the API. Two loader methods in `methods.loadOptions`:

- `getDeployments` — `GET /deployments` via `httpRequestWithAuthentication`
- `getDomains` — `GET /domains` via `httpRequestWithAuthentication`

Both return empty arrays on error (user can still type manually via expression).

### Options Collections

Optional parameters are grouped into `type: 'collection'` fields named `options`:

- **Upload**: Labels → accessed via `this.getNodeParameter('options', i) as IDataObject`
- **Domain Set**: Deployment, Labels → same pattern

### Return All / Limit

Both "Get Many" operations include `returnAll` (boolean) and `limit` (number). Client-side slicing via `.slice(0, limit)` — the API doesn't paginate.

### Error Handling

Uses n8n's standard pattern: `continueOnFail()` returns `{ error: message }` items; otherwise throws `NodeOperationError` with `itemIndex` for precise error attribution.

### Labels

Labels are comma-separated strings in the UI, parsed to `string[]` by `parseLabels()`. Returns `undefined` for empty input (not empty array) to distinguish "not provided" from "clear all".

## Testing

```bash
pnpm test --run     # All tests (~200ms)
```

Tests mock `helpers.httpRequest` and `helpers.httpRequestWithAuthentication` — no real HTTP calls. Coverage:

- `parseLabels` — comma parsing, trimming, empty filtering
- Credential resolution — with key, without key + upload (agent token), without key + other (error)
- Upload — FormData fields (via, spa, labels), multi-item collection, path optimization, empty file skip, error handling
- List slicing — returnAll vs limit
- Void operations — `{ success: true }` convention
- Domain set — empty string → undefined coercion

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

---

_This file provides Claude Code guidance. User-facing documentation lives in README.md._
