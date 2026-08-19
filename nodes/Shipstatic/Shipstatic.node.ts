import { createHash } from 'node:crypto';
import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodeListSearchResult,
  INodeProperties,
  INodeType,
  INodeTypeDescription,
  IPairedItemData,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { API } from './api';

/**
 * Origin tracking — which client made this deploy.
 *
 * A LITERAL, and it has to be. `DeploymentVia` in `@shipstatic/types` owns the
 * closed set, but `@n8n/community-nodes/no-restricted-imports` refuses ANY
 * non-relative import here — it matches on the import statement, so even
 * `import type`, which provably erases, is rejected. n8n Cloud's
 * zero-dependency contract is not negotiable and it does not read TypeScript.
 *
 * So the restatement is forced, and where a restatement is forced a fence
 * compares the copies: `tests/contract.test.ts` imports the real `DeploymentVia`
 * and asserts this value is a member. A typo fails the suite instead of
 * becoming a deploy the server silently drops from its analytics.
 */
export const VIA = 'n8n';

// =============================================================================
// Pure helpers
// =============================================================================

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

export function parseLabels(value: string): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
}

function toJson(data: unknown): INodeExecutionData['json'] {
  return data as INodeExecutionData['json'];
}

// True when a transport error carries HTTP 429. The legacy `request` helper
// reports the status as `httpCode` (string) or `statusCode` (number) depending
// on the failure path, so both are read.
function isRateLimited(error: unknown): boolean {
  const code =
    (error as { httpCode?: string }).httpCode ?? (error as { statusCode?: number }).statusCode;
  return code === '429' || code === 429;
}

// Unwrap a resource-locator value when it appears inside a collection.
// `getNodeParameter(..., { extractValue: true })` only works at the top level;
// nested resource locators arrive as the raw `{ mode, value }` shape and need
// manual unwrapping. Returns undefined for unset / empty selections.
export function extractResourceLocatorValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw || undefined;
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const value = (raw as { value: unknown }).value;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  return undefined;
}

// Strip the longest leading directory shared by every path. Used to flatten
// build outputs (e.g. `dist/index.html` + `dist/assets/app.js` → `index.html`
// + `assets/app.js`) so the deployed URLs match what the user expects.
// Backslashes are normalized to forward slashes for Windows binary data.
export function stripCommonPrefix(paths: string[]): string[] {
  if (paths.length < 2) return paths;
  const segments = paths.map((p) => p.replace(/\\/g, '/').split('/'));
  const minLen = Math.min(...segments.map((s) => s.length));
  let strip = 0;
  for (let i = 0; i < minLen - 1; i++) {
    if (segments.every((s) => s[i] === segments[0][i])) strip++;
    else break;
  }
  if (strip === 0) return paths.map((p) => p.replace(/\\/g, '/'));
  return segments.map((s) => s.slice(strip).join('/'));
}

/**
 * The Files (JSON) grammar, restated.
 *
 * `{ path, content, encoding? }` with `utf-8` as the default has THREE holders:
 * the API's own JSON upload transport (`jsonUploadSchema` in
 * `cloudflare/api/src/lib/upload-input.ts` — the wire original), the hosted
 * MCP's `FileSpec`, and this. The owner-to-be is `@shipstatic/types`, beside
 * `DEPLOY_FIELDS`, whose multipart half already lives there; the promotion
 * rides the next types convoy rather than blocking a broken public listing on
 * a constellation walk.
 *
 * Until then `tests/contract.test.ts` pins these as a LOCAL table, and the plan
 * says so honestly: it is a self-consistency pin, not an owner-compare. The
 * fence flips to a real comparison the day the export exists.
 */
const FILE_ENCODINGS = ['utf-8', 'base64'] as const;
type FileEncoding = (typeof FILE_ENCODINGS)[number];
export const FILES_GRAMMAR = {
  PATH: 'path',
  CONTENT: 'content',
  ENCODING: 'encoding',
  DEFAULT_ENCODING: 'utf-8' as FileEncoding,
  ENCODINGS: FILE_ENCODINGS,
} as const;

/**
 * Reject a path this node can see is wrong, before a wasted upload.
 *
 * Mirrors the hosted MCP's `validatePath` check for check, deliberately: two
 * agent-facing surfaces speaking one grammar must refuse the same inputs, or
 * the grammar is a shape rather than a contract. This is STRUCTURAL validation
 * of the node's own input format — not platform policy, which stays the API's
 * (extensions, sizes, junk files) and relays verbatim.
 */
function checkDeployPath(path: string): string | undefined {
  if (path.length === 0) return 'is empty';
  if (path.startsWith('/')) return 'starts with "/" — paths are relative to the site root';
  if (path.includes('\\')) return 'contains a backslash — use "/" as the separator';
  if (path.includes('\0')) return 'contains a null byte';
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') return 'contains a "." or ".." segment';
  }
  return undefined;
}

/**
 * Decode base64 that is ACTUALLY base64.
 *
 * `Buffer.from(x, 'base64')` never throws — it silently discards anything
 * outside the alphabet and returns whatever it managed to decode. So the
 * payload the MCP refuses (its `atob` throws) would deploy here as garbage
 * bytes, and the user would get a broken image rather than an error. The
 * structural check is the refusal.
 *
 * Whitespace is stripped first because wrapping base64 at a column is a normal
 * transport convention that every decoder accepts; what is refused is content
 * that is not base64 at all.
 */
function decodeBase64Strict(content: string): Buffer | undefined {
  const compact = content.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined;
  return Buffer.from(compact, 'base64');
}

// Shared sub-property used in both Options collections (deploy + domain.set).
// Defined once so the field shape stays in lockstep across resources.
const LABELS_OPTION: INodeProperties = {
  displayName: 'Labels',
  name: 'labels',
  type: 'string',
  default: '',
  placeholder: 'production, v2',
  description: 'Comma-separated labels',
};

// =============================================================================
// HTTP layer — two helpers, each with one job
//
//   apiRequest         JSON + n8n credential-aware auth (every CRUD op)
//   uploadDeployment   POST /deployments multipart, auth attached by hand
//
// Both wrap transport errors in NodeApiError at the I/O boundary so the rest
// of the node can stay trivial — the dominant idiom in n8n core nodes
// (GitHub, Notion, Slack).
// =============================================================================

/**
 * The API's failure body, carried through `NodeApiError` so the node's own
 * catch sites can put structure beside the message.
 *
 * The platform's law is "clients branch on error type and status, never on
 * message strings", and a workflow engine is the caller MOST able to obey it —
 * `continueOnFail` output feeds an IF node. n8n's helpers surface a non-2xx
 * body in different places depending on which of them threw, so every shape
 * they are known to produce is read and anything else is treated as absent.
 * Absent is honest: inventing an `errorType` for a DNS failure would claim the
 * platform answered when nothing did.
 */
export type WireError = { error: string; message?: string; status?: number; details?: unknown };

function readWireError(error: unknown): WireError | undefined {
  const err = error as Record<string, unknown> | undefined;
  const bodies = [
    err?.error, // legacy `request` helper with `json: true`
    (err?.response as Record<string, unknown> | undefined)?.body, // httpRequest*
    (err?.cause as Record<string, unknown> | undefined)?.error,
  ];
  for (const body of bodies) {
    if (body && typeof body === 'object' && typeof (body as WireError).error === 'string') {
      return body as WireError;
    }
  }
  return undefined;
}

// Stashed on the NodeApiError we construct: n8n's own class carries `httpCode`
// but nothing shaped like `ErrorResponse`, and re-deriving it at the catch site
// would mean parsing the same body twice from two different wrappers.
const WIRE = Symbol.for('shipstatic.wire');

function apiError(
  ctx: IExecuteFunctions,
  error: unknown,
  options?: object,
  itemIndex?: number,
): NodeApiError {
  const wrapped = new NodeApiError(ctx.getNode(), error as JsonObject, options);
  const wire = readWireError(error);
  if (wire) (wrapped as unknown as Record<symbol, unknown>)[WIRE] = wire;
  // Set EXPLICITLY rather than via the constructor's `options.itemIndex`.
  // `NodeApiError` honours that option in the CJS build and drops it in the
  // ESM one vitest loads — measured, 2026-08-19 — and a field n8n's error UI
  // reads should not depend on which build resolved. Assigning here also keeps
  // the assignment OUT of a catch site, which is what let the re-throw go.
  if (itemIndex !== undefined) {
    wrapped.context = { ...wrapped.context, itemIndex };
  }
  return wrapped;
}

/**
 * The failure item a `continueOnFail` run emits: the message as `error`
 * because that is what n8n's UI renders, and the wire's own fields BESIDE it.
 * The same shape the MCP settled on — text authoritative, structure alongside —
 * and the failure-path mirror of returning delete acknowledgements verbatim.
 */
function errorItem(error: unknown): IDataObject {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred';
  const wire = (error as Record<symbol, WireError> | undefined)?.[WIRE];
  if (!wire) return { error: message };
  return {
    error: message,
    errorType: wire.error,
    ...(wire.status !== undefined ? { status: wire.status } : {}),
    ...(wire.details !== undefined ? { details: wire.details as IDataObject } : {}),
  };
}

async function apiRequest(
  ctx: IExecuteFunctions,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: object,
  // Which input item this call belongs to. Attached to the error AT BIRTH
  // rather than at a catch site, so n8n's UI can highlight the failing item
  // without anyone re-throwing — see `runOperation` for why no catch exists.
  itemIndex?: number,
): Promise<IDataObject> {
  try {
    return await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'shipstaticApi', {
      method,
      url: `${API}${path}`,
      body,
      json: true,
    });
  } catch (error) {
    throw apiError(ctx, error, undefined, itemIndex);
  }
}

/**
 * Walk a paginated collection.
 *
 * The 2.x API paginates every list: omitting `limit` returns the server's
 * default first page, and `cursor: null` is the entire has-more signal. The
 * 1.x API did not, which is why this node used to fetch once and slice — and
 * why `Return All: true` silently stopped at the server's default. `returnAll`
 * is a contract word in n8n's ecosystem: every core node's `returnAll` walks
 * pages, so returning one page under that name is a lie the ecosystem reads.
 *
 * **No page size appears here.** The server owns its default and its cap; a
 * number restated in this file would be a second owner of one fact. So a
 * bounded request asks for what it still needs and keeps going if the server
 * gave less — the clamp is handled by continuing, never by knowing.
 */
async function fetchList(
  ctx: IExecuteFunctions,
  path: string,
  collection: string,
  limit?: number,
  itemIndex?: number,
): Promise<IDataObject[]> {
  const items: IDataObject[] = [];
  let cursor: string | undefined;

  do {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit - items.length));
    if (cursor) query.set('cursor', cursor);
    const qs = query.toString();

    const response = await apiRequest(
      ctx,
      'GET',
      qs ? `${path}?${qs}` : path,
      undefined,
      itemIndex,
    );
    const page = (response[collection] ?? []) as IDataObject[];
    items.push(...page);

    // An empty page with a live cursor is out of contract, and looping on it
    // would hang the execution rather than fail it.
    if (page.length === 0) break;
    cursor = (response.cursor as string | null) ?? undefined;
  } while (cursor && (limit === undefined || items.length < limit));

  return limit === undefined ? items : items.slice(0, limit);
}

// n8n's modern httpRequest helper does not reliably handle multipart FormData
// (proven across v0.5–0.6 of this node); the legacy `request` helper is the
// only path that produces a working multipart upload — the same fallback
// Slack, S3, and Google Drive use for file uploads. Auth is manual because
// deploy is the ONE operation with optional credentials, and n8n's
// credential-aware helper cannot express "send this header only if a
// credential exists".
//
// Anonymity is in-band: a request with no Authorization header is granted the
// public-account agent identity, and the response carries a claim URL and an
// expiry. A token that IS present and rejected fails with a typed error — it
// never silently downgrades to an anonymous deploy.
async function uploadDeployment(
  ctx: IExecuteFunctions,
  formData: IDataObject,
  token: string | undefined,
  idempotencyKey?: string,
): Promise<IDataObject> {
  try {
    return await ctx.helpers.request({
      method: 'POST',
      uri: `${API}/deployments`,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Restated from `IDEMPOTENCY_KEY_CONSTRAINTS.HEADER`; fenced in
        // `tests/contract.test.ts` like every other forced restatement.
        ...(idempotencyKey ? { [IDEMPOTENCY_HEADER]: idempotencyKey } : {}),
      },
      formData,
      json: true,
    });
  } catch (error) {
    // A keyless deploy is metered per IP on the platform's anonymous bucket.
    // When that is the cause, the actionable fix is "add credentials" — say
    // so rather than leaving the caller to retry blindly. An authenticated
    // 429 is a different limit with different advice, so the hint is
    // conditional on the credential being absent.
    if (!token && isRateLimited(error)) {
      throw apiError(ctx, error, {
        message: 'Public deploy rate limit exceeded',
        description:
          'Add a ShipStatic API key (free at https://my.shipstatic.com/api-key) for higher limits, or wait and retry later.',
      });
    }
    throw apiError(ctx, error);
  }
}

/**
 * SPA detection — parity with every SDK-riding surface.
 *
 * The SDK's deploy path runs this for the CLI, both MCP transports and the
 * VS Code extension: `POST /spa-check` (public, no credential needed), and on
 * `isSPA` it appends a generated `ship.json` so client-side routes resolve.
 * This node is direct HTTP, so without a mirror a React build deployed from a
 * workflow serves 404s on every route but `/` — on the ONE surface whose users
 * are least equipped to diagnose that, and least likely to know what
 * `ship.json` is.
 *
 * Mirrors the SDK's posture exactly: skip when the user already ships a config,
 * skip when `index.html` is absent or too large to be worth reading, and
 * **continue silently on any failure** — detection is an enhancement, never a
 * gate on the deploy.
 */
// Restated from `DEPLOYMENT_CONFIG_FILENAME`; fenced against it. It gates both
// the skip-when-the-user-shipped-one check and the appended filename, so drift
// would silently break the SPA mirror's own escape hatch.
export const SHIP_JSON = 'ship.json';

/** Restated from `IDEMPOTENCY_KEY_CONSTRAINTS.HEADER`; fenced against it. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

// Restated from `SPA_DEFAULT_CONFIG` in `@shipstatic/types` — the zero-import
// rule forbids reading it, so `tests/contract.test.ts` compares the copies.
export const SPA_CONFIG = { rewrites: [{ source: '/(.*)', destination: '/index.html' }] };

/**
 * **The server classifies; this node does not.** The SDK guards its own call
 * with a 100KB index ceiling, and copying that number here would have put a
 * third copy of an unowned fact in the estate — the API has
 * `DEPLOYMENT.SPA_MAX_INDEX_SIZE`, the SDK an inline literal, and
 * `@shipstatic/types` owns neither, so there is nothing to fence a copy
 * against.
 *
 * Not holding the number is stronger than fencing it: a client that never
 * makes the classification decision cannot disagree with the server about it.
 * An oversized index is answered `isSPA: false` gracefully — the outcome is
 * identical, and outcome parity with the SDK is what a user experiences.
 * The cost is one redundant upload of an index the deploy sends anyway, in
 * the uncommon case of a >100KB index.html, bounded by the API's own 5MB
 * body limit.
 */
async function detectSpa(
  ctx: IExecuteFunctions,
  files: { path: string; content: Buffer }[],
  token: string | undefined,
) {
  const index = files.find((f) => f.path === 'index.html');
  if (!index) return false;
  try {
    const response = (await ctx.helpers.request({
      method: 'POST',
      uri: `${API}/spa-check`,
      headers: {
        'Content-Type': 'application/json',
        // The credential rides the pre-flight, exactly as the SDK's client
        // does — it attaches auth to every request, this one included. Not
        // cosmetic: `/spa-check` charges an ANONYMOUS caller the public write
        // bucket to bound its AI tier's spend, and exempts a credentialed one
        // "so the pre-flight never double-charges the deploy it precedes".
        // Probing anonymously with a token in hand forfeits that exemption and
        // spends a budget the user already paid to avoid — which surfaces as
        // SPA routing silently ceasing to work under sustained use, while the
        // deploys themselves keep succeeding.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: { files: files.map((f) => f.path), index: index.content.toString('utf-8') },
      json: true,
    })) as IDataObject;
    return response.isSPA === true;
  } catch {
    return false;
  }
}

// =============================================================================
// Credential probe — used by listSearch
//
// When credentials are absent (the typical state while a user is wiring the
// node up), the resource-locator dropdown stays empty silently. Once
// credentials exist, real API failures surface to the n8n UI rather than
// being swallowed. The probe never makes a network request.
// =============================================================================

async function hasCredentials(ctx: ILoadOptionsFunctions): Promise<boolean> {
  try {
    await ctx.getCredentials('shipstaticApi');
    return true;
  } catch {
    return false;
  }
}

/**
 * One page of a resource-locator dropdown. Both backends differ only in which
 * collection they read and which key names an item, so they share this rather
 * than stating the same walk twice.
 */
async function searchPage(
  ctx: ILoadOptionsFunctions,
  path: string,
  collection: string,
  key: string,
  filter?: string,
  cursor?: string,
): Promise<INodeListSearchResult> {
  if (!(await hasCredentials(ctx))) return { results: [] };
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'shipstaticApi', {
    method: 'GET',
    url: `${API}${path}${query}`,
    json: true,
  });
  const page = (response[collection] ?? []) as IDataObject[];
  const needle = filter?.toLowerCase();
  const matches = needle
    ? page.filter((item) => String(item[key]).toLowerCase().includes(needle))
    : page;
  return {
    results: matches.map((item) => ({ name: String(item[key]), value: String(item[key]) })),
    ...(response.cursor ? { paginationToken: response.cursor } : {}),
  };
}

// =============================================================================
// Deploy — the only operation with optional credentials and multipart upload
// =============================================================================

/**
 * Read the Files (JSON) input into the same shape the other two modes produce.
 *
 * **The value arrives in two shapes, and the AGENT path is the second one.**
 * Measured at `n8n-workflow@2.12.0`: a `type: 'json'` parameter typed by hand
 * is a STRING, but one an expression produced — `{{ $json.files }}`, or an AI
 * Agent's `$fromAI(..., 'json')` — is the RESOLVED VALUE. n8n's own
 * `generateZodSchema` type-checks that value ("a non-empty object or a
 * non-empty array"), so what lands here from an agent is a real array. Parsing
 * is the fallback, not the main road.
 *
 * That same host-side check admits a non-empty OBJECT, so an agent can hand
 * over `{...}` in perfect good faith and n8n will pass it along. The refusal
 * has to name the shape actually wanted, or the agent has nothing to correct
 * toward.
 */
function readFilesInput(ctx: IExecuteFunctions): { path: string; content: Buffer; md5: string }[] {
  const raw = ctx.getNodeParameter('files', 0);
  const fail = (message: string, description?: string): never => {
    throw new NodeOperationError(ctx.getNode(), message, {
      itemIndex: 0,
      ...(description ? { description } : {}),
    });
  };

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(
        'Files is not valid JSON',
        'Expected a JSON array of files, e.g. [{"path": "index.html", "content": "<h1>Hi</h1>"}].',
      );
    }
  }

  if (!Array.isArray(parsed)) {
    // The received type rides the MESSAGE, not the description. Two reasons:
    // n8n renders the message and treats the description as secondary, and an
    // agent correcting its own tool call reads the message first. `null` is
    // named explicitly because `typeof null === 'object'` would otherwise tell
    // someone who sent nothing that they sent an object.
    //
    // This is the refusal an agent is most likely to meet in good faith: n8n's
    // host-side validator for a `json` parameter admits "a non-empty object OR
    // a non-empty array" (measured, T0b), so `{...}` passes every check
    // upstream and arrives here. Naming the array is what gives the agent
    // something to correct toward.
    // No `array` arm: this block is already guarded by `!Array.isArray`, so one
    // would be unreachable by construction — and the ratchet caught it as a
    // fourth uncovered branch the moment it was written.
    const received = parsed === null || parsed === undefined ? 'null' : typeof parsed;
    fail(
      `Files must be a JSON array of files — received ${received}`,
      'Expected an array like [{"path": "index.html", "content": "<h1>Hi</h1>"}] — one object per file, each with "path" and "content".',
    );
  }

  const collected: { path: string; content: Buffer; md5: string }[] = [];
  for (const [index, entry] of (parsed as unknown[]).entries()) {
    const where = `File ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${where} is not an object`, 'Each file must be {"path": …, "content": …}.');
    }
    const record = entry as Record<string, unknown>;
    const path = record[FILES_GRAMMAR.PATH];
    const content = record[FILES_GRAMMAR.CONTENT];
    if (typeof path !== 'string') fail(`${where} is missing a "path" string`);
    if (typeof content !== 'string') {
      fail(
        `${where} ("${path as string}") is missing a "content" string`,
        'Content is the file\'s text. For binary files set "encoding": "base64" on that entry and pass base64 bytes.',
      );
    }

    const pathProblem = checkDeployPath(path as string);
    if (pathProblem) fail(`${where} has an invalid path: it ${pathProblem}`);

    const encoding = record[FILES_GRAMMAR.ENCODING] ?? FILES_GRAMMAR.DEFAULT_ENCODING;
    if (typeof encoding !== 'string' || !FILE_ENCODINGS.includes(encoding as FileEncoding)) {
      fail(
        `${where} ("${path as string}") has an unknown encoding`,
        `Use ${FILE_ENCODINGS.map((e) => `"${e}"`).join(' or ')}; omit it for plain text.`,
      );
    }

    let buffer: Buffer | undefined;
    if (encoding === 'base64') {
      buffer = decodeBase64Strict(content as string);
      if (!buffer) {
        fail(
          `${where} ("${path as string}") is marked base64 but is not valid base64`,
          'Pass text content as a plain string with no encoding — only genuinely binary files (images, fonts) should be base64.',
        );
      }
    } else {
      buffer = Buffer.from(content as string, 'utf-8');
    }

    collected.push({
      path: path as string,
      content: buffer as Buffer,
      md5: md5(buffer as Buffer),
    });
  }

  return collected;
}

async function handleDeploy(
  ctx: IExecuteFunctions,
  items: INodeExecutionData[],
  token: string | undefined,
): Promise<INodeExecutionData[]> {
  const input = ctx.getNodeParameter('input', 0) as string;
  const options = ctx.getNodeParameter('options', 0) as IDataObject;

  // 1. Collect files — from binary data, text content, or a JSON file list
  const files: { path: string; content: Buffer; md5: string }[] = [];

  if (input === 'binary') {
    const binaryPropertyName = ctx.getNodeParameter('binaryPropertyName', 0) as string;
    for (let i = 0; i < items.length; i++) {
      const binaryData = ctx.helpers.assertBinaryData(i, binaryPropertyName);
      const buffer = await ctx.helpers.getBinaryDataBuffer(i, binaryPropertyName);
      if (buffer.length === 0) continue;
      const dir = (binaryData.directory || '').replace(/^\/+/, '');
      const fileName = binaryData.fileName || `file_${i}`;
      files.push({
        path: dir ? `${dir}/${fileName}` : fileName,
        content: buffer,
        md5: md5(buffer),
      });
    }
    // 1a. Binary only — strip the longest shared directory so a build output's
    //     URLs read as the user expects. Filesystem-derived paths carry an
    //     accident of where the files sat; the other two modes carry paths
    //     someone WROTE, and rewriting those would be a surprise.
    const stripped = stripCommonPrefix(files.map((f) => f.path));
    for (const [idx, file] of files.entries()) {
      file.path = stripped[idx];
    }
  } else if (input === 'files') {
    for (const entry of readFilesInput(ctx)) {
      files.push(entry);
    }
  } else {
    const fileContent = ctx.getNodeParameter('fileContent', 0) as string;
    const fileName = ctx.getNodeParameter('fileName', 0) as string;
    const content = Buffer.from(fileContent, 'utf-8');
    files.push({ path: fileName || 'index.html', content, md5: md5(content) });
  }

  if (files.length === 0) {
    throw new NodeOperationError(ctx.getNode(), 'No files to deploy — all input items were empty', {
      description:
        'Connect a node that produces binary data (e.g. Read Binary Files, HTTP Request, Convert to File), or switch Input to Text Content or Files (JSON).',
    });
  }

  // 3. SPA parity — append a routing config when the build needs one and the
  //    user did not ship their own. Runs on the stripped paths because that is
  //    what the deployment will serve.
  const spaDetect = options.spaDetect !== false;
  if (
    spaDetect &&
    !files.some((f) => f.path === SHIP_JSON) &&
    (await detectSpa(ctx, files, token))
  ) {
    const content = Buffer.from(`${JSON.stringify(SPA_CONFIG, null, 2)}\n`, 'utf-8');
    files.push({ path: SHIP_JSON, content, md5: md5(content) });
  }

  // 4. Build formData — after the SPA step, so its checksum rides along
  const formData: IDataObject = {
    'files[]': files.map((f) => ({
      value: f.content,
      options: { filename: f.path, contentType: 'application/octet-stream' },
    })),
    checksums: JSON.stringify(files.map((f) => f.md5)),
    via: VIA,
  };
  const labels = parseLabels(options.labels as string);
  if (labels) formData.labels = JSON.stringify(labels);
  const password = (options.password as string | undefined)?.trim();
  if (password) formData.password = password;
  // Sent iff the user ADDED the option — key presence, never truthiness. A `0`
  // fed by an expression forwards and the server refuses it with its own
  // sentence, which is the whole point: this node is not a second validator of
  // a range it does not own. (The truthiness gate `labels`/`password` use is
  // right for them — an empty string is absence of intent — and wrong here,
  // where `0` is a value the user typed.)
  if (options.ttl !== undefined) formData.ttl = String(options.ttl);

  // 5. Upload — with the token when one is configured, anonymously when not
  const idempotencyKey = (options.idempotencyKey as string | undefined)?.trim();
  const result = await uploadDeployment(ctx, formData, token, idempotencyKey);

  return [
    {
      json: toJson(result),
      pairedItem: items.map((_, i) => ({ item: i })),
    },
  ];
}

/**
 * One item through the resource/operation dispatch, returning what it
 * produced rather than pushing into a shared array.
 *
 * Extracted so `execute()` can run it WITHOUT a try/catch on the strict
 * path. The natural shape — one try whose `else` re-throws — trips
 * `require-node-api-error`, which cannot tell a re-throw of an
 * already-typed error from a raw one, and the inline disable that used to
 * silence it is void where it matters: n8n's verification scanner runs
 * eslint with `allowInlineConfig: false`. Wrapping instead would nest a
 * typed error inside another and degrade the message a user reads, so the
 * error is simply never caught when it is going to be re-thrown.
 */
async function runOperation(
  ctx: IExecuteFunctions,
  resource: string,
  operation: string,
  i: number,
  pairedItem: IPairedItemData | IPairedItemData[],
): Promise<INodeExecutionData[]> {
  const out: INodeExecutionData[] = [];
  if (resource === 'deployment') {
    if (operation === 'list') {
      const returnAll = ctx.getNodeParameter('returnAll', 0) as boolean;
      const limit = returnAll ? undefined : (ctx.getNodeParameter('limit', 0) as number);
      // `cursor` is deliberately absent from the item json: returnAll and
      // limit ARE n8n's pagination abstraction, and handing a workflow a
      // cursor it has no way to feed back would be a second, broken one.
      for (const deployment of await fetchList(ctx, '/deployments', 'deployments', limit, i)) {
        out.push({ json: toJson(deployment), pairedItem });
      }
    } else if (operation === 'get') {
      const id = ctx.getNodeParameter('deployment', i, '', {
        extractValue: true,
      }) as string;
      const result = await apiRequest(
        ctx,
        'GET',
        `/deployments/${encodeURIComponent(id)}`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'set') {
      const id = ctx.getNodeParameter('deployment', i, '', {
        extractValue: true,
      }) as string;
      const labelValues = parseLabels(ctx.getNodeParameter('labels', i) as string) ?? [];
      const result = await apiRequest(
        ctx,
        'PATCH',
        `/deployments/${encodeURIComponent(id)}`,
        {
          labels: labelValues,
        },
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'delete') {
      const id = ctx.getNodeParameter('deployment', i, '', {
        extractValue: true,
      }) as string;
      // The acknowledgement is the output, verbatim. The API answers
      // 202 with `{ deployment, status: 'deleting' }` — the row states
      // the plan it is transitioning through, and a workflow branching
      // on the deletion is the caller most able to act on that. A
      // fabricated `{ success: true }` would throw it away.
      const result = await apiRequest(
        ctx,
        'DELETE',
        `/deployments/${encodeURIComponent(id)}`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    }
  } else if (resource === 'domain') {
    // All domain ops read the same `domain` resource locator.
    const name = ctx.getNodeParameter('domain', i, '', {
      extractValue: true,
    }) as string;

    if (operation === 'set') {
      const domainOptions = ctx.getNodeParameter('options', i) as IDataObject;
      // Merge-upsert semantics: omitted keys preserve, present keys update.
      // Empty Labels (added but blank) clears — same shape as Deployment Set.
      const body: IDataObject = {};
      const linkedDeployment = extractResourceLocatorValue(domainOptions.deployment);
      if (linkedDeployment) body.deployment = linkedDeployment;
      if (domainOptions.labels !== undefined) {
        body.labels = parseLabels(domainOptions.labels as string) ?? [];
      }
      const result = await apiRequest(ctx, 'PUT', `/domains/${encodeURIComponent(name)}`, body, i);
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'list') {
      const returnAll = ctx.getNodeParameter('returnAll', 0) as boolean;
      const limit = returnAll ? undefined : (ctx.getNodeParameter('limit', 0) as number);
      for (const domain of await fetchList(ctx, '/domains', 'domains', limit, i)) {
        out.push({ json: toJson(domain), pairedItem });
      }
    } else if (operation === 'get') {
      const result = await apiRequest(
        ctx,
        'GET',
        `/domains/${encodeURIComponent(name)}`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'records') {
      const result = await apiRequest(
        ctx,
        'GET',
        `/domains/${encodeURIComponent(name)}/records`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'dns') {
      const result = await apiRequest(
        ctx,
        'GET',
        `/domains/${encodeURIComponent(name)}/dns`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'share') {
      const result = await apiRequest(
        ctx,
        'GET',
        `/domains/${encodeURIComponent(name)}/share`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'validate') {
      const result = await apiRequest(
        ctx,
        'POST',
        '/domains/validate',
        {
          domain: name,
        },
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'verify') {
      const result = await apiRequest(
        ctx,
        'POST',
        `/domains/${encodeURIComponent(name)}/verify`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    } else if (operation === 'delete') {
      // Same law as the deployment delete: the wire's acknowledgement
      // IS the output. `{ domain }` at 200 — the domain is gone when
      // the call returns, which is why this one carries no state.
      const result = await apiRequest(
        ctx,
        'DELETE',
        `/domains/${encodeURIComponent(name)}`,
        undefined,
        i,
      );
      out.push({ json: toJson(result), pairedItem });
    }
  } else if (resource === 'account') {
    const result = await apiRequest(ctx, 'GET', '/account', undefined, i);
    out.push({ json: toJson(result), pairedItem });
  }
  return out;
}

export class Shipstatic implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'ShipStatic',
    name: 'shipstatic',
    // eslint-disable-next-line @n8n/community-nodes/icon-prefer-themed-variants -- REFUSED on the merits, not deferred. The rule warns on SHAPE (a string rather than `{ light, dark }`) and cannot see content; this mark is a solid #EE6723 tile with white glyphs, so it CARRIES ITS OWN GROUND and renders identically on either theme. A themed pair here would be two files that differ in nothing, to satisfy a check about a problem this icon does not have — the transparent-background, dark-stroke icon the rule exists for. EXPIRY: if the brand mark ever loses its tile (transparent ground, or glyphs that borrow the host's colour), the rule becomes correct and the pair is owed. Suppressed at the line it concerns rather than in `eslint.config.mjs`, so the decision is visible where the icon is.
    icon: 'file:shipstatic.svg',
    group: ['output'],
    version: 1,
    subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
    description: 'Deploy static sites and HTML pages to a live URL — free, no account needed',
    defaults: {
      name: 'ShipStatic',
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    // Deploy works without credentials — the API grants a public identity per
    // request and answers with a claim URL and an expiry. Every other
    // operation requires a free API key.
    credentials: [
      {
        name: 'shipstaticApi',
        required: false,
      },
    ],
    properties: [
      // ─── Resource & Operation ───────────────────────────────────────────
      // Each resource defines its own Operation property; n8n shows the one
      // matching the selected resource. This is the canonical n8n shape for
      // resource-grouped APIs (matches GitHub, Notion, Slack).

      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Deployment', value: 'deployment' },
          { name: 'Domain', value: 'domain' },
          { name: 'Account', value: 'account' },
        ],
        default: 'deployment',
      },

      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['deployment'] } },
        options: [
          {
            name: 'Delete',
            value: 'delete',
            description:
              'Delete a deployment and all its files. The response reports the transitional state — the site stays served until cleanup completes. Confirm with the user before calling this — it cannot be undone.',
            action: 'Delete a deployment',
          },
          {
            name: 'Deploy',
            value: 'deploy',
            description:
              'Publish files and get a live URL. Without credentials, the response includes a claim URL — show both to the user. To make the site private, set Password under Options.',
            action: 'Deploy a site',
          },
          {
            name: 'Get',
            value: 'get',
            description:
              'Get deployment details including URL, status, file count, size, labels, and password protection state',
            action: 'Get a deployment',
          },
          {
            name: 'List',
            value: 'list',
            description:
              'List all deployments with their URLs, status, labels, and password protection state',
            action: 'List all deployments',
          },
          {
            name: 'Set',
            value: 'set',
            description: 'Update labels on a deployment. Replaces all existing labels.',
            action: 'Set deployment labels',
          },
        ],
        default: 'deploy',
      },

      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['domain'] } },
        options: [
          {
            name: 'Delete',
            value: 'delete',
            description:
              'Permanently disconnect and delete a custom domain. Confirm with the user before calling this — it cannot be undone.',
            action: 'Delete a domain',
          },
          {
            name: 'DNS',
            value: 'dns',
            description:
              'Look up the DNS provider for a domain (e.g. Cloudflare, Namecheap) to know where to configure records',
            action: 'Look up DNS provider',
          },
          {
            name: 'Get',
            value: 'get',
            description:
              'Get domain details including linked deployment, verification status, and labels',
            action: 'Get a domain',
          },
          {
            name: 'List',
            value: 'list',
            description: 'List all domains with their linked deployment and verification status',
            action: 'List all domains',
          },
          {
            name: 'Records',
            value: 'records',
            description:
              'Get the DNS records you need to configure at your DNS provider. Call after Set; show the records to the user, then call Verify once DNS is configured.',
            action: 'Get DNS records',
          },
          {
            name: 'Set',
            value: 'set',
            description:
              'Create or update a custom domain. Reserve a name, link it to a deployment, switch deployments, or update labels.',
            action: 'Set a domain',
          },
          {
            name: 'Share',
            value: 'share',
            description:
              'Get a shareable setup hash so someone else can view the required DNS records without an API key',
            action: 'Get share hash',
          },
          {
            name: 'Validate',
            value: 'validate',
            description: 'Check if a domain name is valid and available before connecting it',
            action: 'Validate a domain',
          },
          {
            name: 'Verify',
            value: 'verify',
            description:
              'Trigger DNS verification for a custom domain. Call after the user configures DNS records — verification is asynchronous and the domain status updates once DNS propagates.',
            action: 'Verify DNS',
          },
        ],
        default: 'set',
      },

      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['account'] } },
        options: [
          {
            name: 'Get',
            value: 'get',
            description: 'Get your account details including email, plan, and usage',
            action: 'Get account info',
          },
        ],
        default: 'get',
      },

      // ─── Required Parameters ────────────────────────────────────────────
      // Per-operation inputs. Visibility is driven by `displayOptions.show`
      // matching the selected resource + operation.

      // Deploy — where the files come from. Three modes, one downstream
      // pipeline. Replaced the 0.x `binaryData` boolean: a third source cannot
      // be a second boolean, and the selector is what lets an AI Agent supply a
      // whole site (see `input: 'files'`).
      {
        displayName: 'Input',
        name: 'input',
        type: 'options',
        default: 'binary',
        noDataExpression: true,
        displayOptions: { show: { resource: ['deployment'], operation: ['deploy'] } },
        options: [
          {
            name: 'Binary Files',
            value: 'binary',
            description: 'Files from upstream nodes — the workflow-native path',
          },
          {
            name: 'Files (JSON)',
            value: 'files',
            description: 'A list of paths and contents — how an AI agent deploys a whole site',
          },
          {
            name: 'Text Content',
            value: 'text',
            description: 'A single file typed or wired in directly',
          },
        ],
        description: 'Where the files to deploy come from',
      },
      {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        displayOptions: {
          show: { resource: ['deployment'], operation: ['deploy'], input: ['binary'] },
        },
        hint: 'The name of the input binary field containing the file to be deployed',
      },
      {
        displayName: 'File Content',
        name: 'fileContent',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 5 },
        displayOptions: {
          show: { resource: ['deployment'], operation: ['deploy'], input: ['text'] },
        },
        hint: 'The text content of the file to deploy',
      },
      {
        displayName: 'File Name',
        name: 'fileName',
        type: 'string',
        default: 'index.html',
        required: true,
        displayOptions: {
          show: { resource: ['deployment'], operation: ['deploy'], input: ['text'] },
        },
        description: 'The path to deploy the content as (defaults to "index.html")',
      },
      {
        displayName: 'Files',
        name: 'files',
        type: 'json',
        default: '[\n  {\n    "path": "index.html",\n    "content": "<h1>Hello</h1>"\n  }\n]',
        required: true,
        typeOptions: { rows: 8 },
        displayOptions: {
          show: { resource: ['deployment'], operation: ['deploy'], input: ['files'] },
        },
        // Written to be read by an LLM: `usableAsTool` makes this the tool
        // catalogue's text for the one parameter an agent must construct.
        // States the schema, the default, and the one thing agents reliably get
        // wrong — base64-encoding text that should have been passed as text.
        description:
          'The site to deploy, as a JSON array of files. Each entry is an object with "path" (relative, e.g. "index.html" or "assets/app.css") and "content". Content is plain text by default — encoding defaults to "utf-8", so pass HTML, CSS, JS, JSON or SVG directly as a normal string with no encoding step. Only for genuinely binary files (images, fonts) add "encoding": "base64" to that entry and pass base64-encoded bytes; never base64-encode text. Example: [{"path": "index.html", "content": "<h1>Hi</h1>"}, {"path": "style.css", "content": "body{margin:0}"}]',
      },

      // Deployment — used by get, set, delete. Resource locator gives the user
      // search-as-you-type from the list and free-text fallback by hostname.
      {
        displayName: 'Deployment',
        name: 'deployment',
        type: 'resourceLocator',
        default: { mode: 'list', value: '' },
        required: true,
        displayOptions: {
          show: { resource: ['deployment'], operation: ['get', 'set', 'delete'] },
        },
        description: 'The deployment to operate on',
        modes: [
          {
            displayName: 'From List',
            name: 'list',
            type: 'list',
            typeOptions: {
              searchListMethod: 'searchDeployments',
              searchable: true,
            },
          },
          {
            displayName: 'By Hostname',
            name: 'id',
            type: 'string',
            placeholder: 'happy-cat-abc1234.shipstatic.com',
            hint: 'The full hostname returned by Deploy',
          },
        ],
      },

      // Deployment labels — the payload of `set` (always present in body; `[]` clears)
      {
        displayName: 'Labels',
        name: 'labels',
        type: 'string',
        default: '',
        placeholder: 'production, v2',
        displayOptions: { show: { resource: ['deployment'], operation: ['set'] } },
        description: 'Comma-separated labels',
      },

      // Domain — used by every domain operation. Resource locator handles
      // both flows uniformly: "From List" for ops on existing domains
      // (get, records, verify, delete, dns, share) and for re-pointing
      // (set); "By Name" for ops that may target a not-yet-created domain
      // (set when reserving, validate).
      {
        displayName: 'Domain',
        name: 'domain',
        type: 'resourceLocator',
        default: { mode: 'list', value: '' },
        required: true,
        displayOptions: { show: { resource: ['domain'] } },
        description: 'The domain to operate on',
        modes: [
          {
            displayName: 'From List',
            name: 'list',
            type: 'list',
            typeOptions: {
              searchListMethod: 'searchDomains',
              searchable: true,
            },
          },
          {
            displayName: 'By Name',
            name: 'name',
            type: 'string',
            placeholder: 'www.example.com',
            hint: 'A subdomain you own (apex domains not supported)',
          },
        ],
      },

      // ─── List Controls ──────────────────────────────────────────────────
      // Shared by every `list` operation. The API doesn't paginate, so we
      // slice client-side after fetching the full list.

      {
        displayName: 'Return All',
        name: 'returnAll',
        type: 'boolean',
        default: false,
        displayOptions: { show: { operation: ['list'] } },
        // n8n's own ruleset enforces this sentence verbatim
        // (`node-param-description-wrong-for-return-all`), and that is the
        // whole point: `returnAll` is a contract word every core node honours
        // by walking pages. Until T9 this node returned one page under it. The
        // phrase never needed fixing — the behaviour did.
        description: 'Whether to return all results or only up to a given limit',
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        default: 50,
        typeOptions: { minValue: 1 },
        displayOptions: { show: { operation: ['list'], returnAll: [false] } },
        description: 'Max number of results to return',
      },

      // ─── Options Collections ────────────────────────────────────────────
      // `options` is defined twice — once per operation that has its own
      // optional inputs. n8n selects the collection whose displayOptions
      // match the active operation. Empty values on present keys mean
      // "clear" (mirrors the API's merge-upsert semantics).

      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { resource: ['deployment'], operation: ['deploy'] } },
        options: [
          {
            displayName: 'Idempotency Key',
            name: 'idempotencyKey',
            type: 'string',
            default: '',
            // NO `placeholder`, and the reason is external rather than
            // aesthetic. It used to read `={{ $execution.id }}` behind an
            // inline disable for `node-param-placeholder-miscased-id` (the rule
            // wants `ID`; `$execution.ID` is not a variable, so the rule is
            // wrong here and its autofix would BREAK the expression).
            //
            // The disable does not work where it counts: n8n's verification
            // scanner runs eslint with `allowInlineConfig: false`, so every
            // inline directive in this repo is overruled during the check that
            // decides Cloud listing. Measured 2026-08-19 — the published
            // `1.0.0-beta.1` failed the scan on exactly this line WITH the
            // disable present.
            //
            // So the example moved into the description, where no rule
            // applies and the reader sees it just as well.
            description:
              'Key the ATTEMPT, never the try. A retry carrying the same key replays the original deployment instead of creating a second one — which matters most here, because Retry On Fail is a core n8n feature and makes this the platform surface most likely to retry automatically. Use a value that is stable across retries of one logical deploy and different for the next one; an expression reading the execution ID is the usual choice, and a commit SHA works too. Omit it and every run deploys afresh.',
          },
          LABELS_OPTION,
          {
            displayName: 'Password',
            name: 'password',
            type: 'string',
            typeOptions: { password: true },
            default: '',
            description:
              'Password-protect the deployment (6–128 characters; whitespace significant). Visitors must enter this password before viewing the site, including on any custom domains pointing at it.',
          },
          {
            displayName: 'Single-Page App Routing',
            name: 'spaDetect',
            type: 'boolean',
            default: true,
            description:
              'Whether to detect a single-page app (React, Vue, Svelte…) and add the routing config it needs, so deep links resolve instead of 404ing. Matches what the CLI and the AI-agent integrations already do. Turn it off, or include your own routing config among the deployed files, to take control.',
          },
          {
            displayName: 'TTL',
            name: 'ttl',
            type: 'number',
            // A UI convenience default owned by THIS node, the same way
            // `fileName`'s `index.html` is — not a restatement of anything in
            // `@shipstatic/types`, so nothing fences it. It exists because a
            // number field cannot ride the Labels absence pattern: adding the
            // option puts the key in the collection at whatever the default is,
            // so the default is what an unedited "Add Option" click sends. An
            // hour is a defensible preview lifetime; the server owns the range.
            default: 3600,
            // A RESTATEMENT of `TTL_CONSTRAINTS.MIN_SECONDS`, fenced against the
            // owner in `tests/contract.test.ts`. No `maxValue`: the ceiling is a
            // year, nobody reaches it by accident, and the server's own sentence
            // teaches it better than a spinner that silently clamps.
            typeOptions: { minValue: 1 },
            description:
              "How long the deployment stays live, in seconds — the platform reclaims it when the time is up. Leave this option off for a deployment that never expires. Requires credentials: an anonymous deployment already expires on the platform's own schedule, and a TTL on one is refused. A deployment carrying a TTL cannot be linked to a custom domain — deploy without one if the site needs a domain.",
          },
        ],
      },

      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { resource: ['domain'], operation: ['set'] } },
        options: [
          {
            displayName: 'Deployment',
            name: 'deployment',
            type: 'resourceLocator',
            default: { mode: 'list', value: '' },
            description: 'The deployment to link to this domain (omit to reserve only)',
            modes: [
              {
                displayName: 'From List',
                name: 'list',
                type: 'list',
                typeOptions: {
                  searchListMethod: 'searchDeployments',
                  searchable: true,
                },
              },
              {
                displayName: 'By Hostname',
                name: 'id',
                type: 'string',
                placeholder: 'happy-cat-abc1234.shipstatic.com',
                hint: 'The full hostname returned by Deploy',
              },
            ],
          },
          LABELS_OPTION,
        ],
      },
    ],
  };

  methods = {
    listSearch: {
      // Resource locator search backends. Probe credentials first — a silent
      // empty dropdown is the right UX while the user is still wiring the
      // node up. Once credentials exist, any failure (invalid key, API down)
      // is real and must surface in the UI.
      //
      // **The cursor IS n8n's pagination token.** `INodeListSearchResult`
      // carries `paginationToken` and the listSearch signature receives it
      // back on the next call, which is exactly the API's `{limit, cursor}`
      // contract under another name — so the dropdown scrolls through every
      // deployment instead of stopping at the server's first page.
      //
      // Filtering stays client-side and therefore PER PAGE: the API has no
      // filter query, so narrowing what a page returned is the whole of what
      // a client can do. n8n asks for the next page as the user scrolls.
      async searchDeployments(
        this: ILoadOptionsFunctions,
        filter?: string,
        paginationToken?: string,
      ): Promise<INodeListSearchResult> {
        return searchPage(
          this,
          '/deployments',
          'deployments',
          'deployment',
          filter,
          paginationToken,
        );
      },
      async searchDomains(
        this: ILoadOptionsFunctions,
        filter?: string,
        paginationToken?: string,
      ): Promise<INodeListSearchResult> {
        return searchPage(this, '/domains', 'domains', 'domain', filter, paginationToken);
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    // Deploy has two modes:
    // • With a token — permanent deployment under your account
    // • Without one — public deployment with a claim URL and an expiry
    if (resource === 'deployment' && operation === 'deploy') {
      let token: string | undefined;
      let credentialAttached = false;
      try {
        const credentials = await this.getCredentials('shipstaticApi');
        credentialAttached = true;
        token = (credentials.token as string)?.trim() || undefined;
      } catch {
        // No credential attached — the anonymous door, and the product.
      }
      // **Attaching a credential is intent; leaving its slot empty is a
      // mistake.** `getCredentials` THROWS when no credential is attached and
      // RESOLVES when one is — two different states, and collapsing them is
      // what makes the 0.x upgrade fail silently. A credential created for the
      // 0.x node stored its value under `apiKey`; 1.x reads `token`, so an
      // upgraded workflow arrives here with a credential attached and an empty
      // slot. Deploying that anonymously SUCCEEDS — and hands back a public
      // deployment that expires in days where the user expected a permanent one
      // under their account. A wrong success is the worst failure this node
      // has, so it is refused.
      //
      // The anonymous door is untouched: no credential attached is still no
      // credential, and still deploys. Only the contradiction is refused.
      //
      // This is also the ONLY guard available for the 0.x migration. The other
      // one — reading a stored-but-undeclared `binaryData` to catch a 0.x
      // text-mode workflow — is impossible by construction: `getNodeParameters`
      // (`n8n-workflow/dist/esm/node-helpers.js`) iterates the DECLARED
      // property array, so a stored key with no declaration is never visited.
      // Measured 2026-08-19 at n8n-workflow 2.12.0. That break stays loud by
      // accident rather than by design (the missing binary field errors), and
      // its real mitigation is the README's upgrade section.
      if (credentialAttached && !token) {
        throw new NodeOperationError(
          this.getNode(),
          'ShipStatic credential is attached but its Token field is empty',
          {
            description:
              'Open the credential and paste an API key (ship-…) or a deploy token (deploy-…). Upgrading from the 0.x node? It stored the value in an "API Key" field that 1.x no longer reads — re-enter it in Token. To deploy anonymously instead, remove the credential from this node.',
          },
        );
      }

      // **No try/catch on the strict path, deliberately.** The obvious shape is
      // one try whose `else` re-throws — and a bare `throw error` is refused by
      // `require-node-api-error`, which cannot see that the value is already a
      // NodeApiError. An inline disable does not help: n8n's verification
      // scanner runs eslint with `allowInlineConfig: false` (measured — a
      // published beta failed the scan on a line whose disable was present).
      //
      // Wrapping instead would be worse than the lint it silences: nesting a
      // typed error inside `new NodeApiError(...)` degrades the message the
      // user reads and strands the wire fields `errorItem` recovers. So the
      // error is simply never caught when it is going to be re-thrown.
      if (!this.continueOnFail()) {
        returnData.push(...(await handleDeploy(this, items, token)));
        return [returnData];
      }

      try {
        returnData.push(...(await handleDeploy(this, items, token)));
      } catch (error) {
        // Deploy consumes every input item into one upload, so the error must
        // trace back to all of them — same pairedItem shape as the success
        // path inside handleDeploy.
        returnData.push({
          json: errorItem(error),
          pairedItem: items.map((_, idx) => ({ item: idx })),
        });
      }
      return [returnData];
    }

    // All other operations require credentials
    try {
      await this.getCredentials('shipstaticApi');
    } catch {
      throw new NodeOperationError(
        this.getNode(),
        'This operation requires ShipStatic credentials.',
        {
          description:
            'Open Credentials → New → ShipStatic API and paste an API key. Get a free key at https://my.shipstatic.com/api-key. A deploy token (deploy-…) is deploy-scoped — it can run Deploy, but not this operation.',
        },
      );
    }

    // Global ops (list, account.get) don't depend on per-item parameters —
    // run once and pair the output to all input items so n8n's data-trace stays
    // honest. Per-item ops (get, set, delete, etc.) loop over input items as usual.
    const isGlobalOp = operation === 'list' || (resource === 'account' && operation === 'get');
    const iterations = isGlobalOp ? 1 : items.length;
    const globalPairedItem = items.map((_, idx) => ({ item: idx }));

    // `continueOnFail` is constant for the execution, so the branch is hoisted
    // out of the loop: the tolerant path catches, the strict path never does.
    const tolerant = this.continueOnFail();

    for (let i = 0; i < iterations; i++) {
      const pairedItem = isGlobalOp ? globalPairedItem : { item: i };
      if (!tolerant) {
        returnData.push(...(await runOperation(this, resource, operation, i, pairedItem)));
        continue;
      }
      try {
        returnData.push(...(await runOperation(this, resource, operation, i, pairedItem)));
      } catch (error) {
        returnData.push({ json: errorItem(error), pairedItem });
      }
    }

    return [returnData];
  }
}
