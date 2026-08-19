import { createHash } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractResourceLocatorValue,
  parseLabels,
  Shipstatic,
  stripCommonPrefix,
} from '../nodes/Shipstatic/Shipstatic.node';
import {
  ACCOUNT,
  ANONYMOUS_DEPLOYMENT,
  DEPLOYMENT,
  DEPLOYMENT_DELETED,
  DOMAIN,
  DOMAIN_DELETED,
  DOMAIN_DNS,
  DOMAIN_RECORDS,
  DOMAIN_SHARE,
  DOMAIN_VALID,
  DOMAIN_VERIFY,
} from './wire';

// =============================================================================
// Test scaffolding
// =============================================================================
//
// Tests are organized by implementation surface, top-down:
//
//   parseLabels                        pure helper
//   Deploy — authentication            credential resolution + the anonymous door
//   Deploy — file collection & formData    handleDeploy file pipeline
//   Deploy — error handling            handleDeploy failure paths
//   Deployment operations              execute() — Deployment resource
//   Domain operations                  execute() — Domain resource (incl. set merge-upsert)
//   Auth gate for non-deploy operations    execute() — credential gate
//   Global vs per-item iteration       execute() — list/account run-once + list controls
//   Error handling — NodeApiError      execute() — per-item NodeApiError + continueOnFail
//   listSearch — credential probe & filter   methods.listSearch (resource locator backends)
//
// =============================================================================

vi.mock('n8n-workflow', () => ({
  NodeConnectionTypes: { Main: 'main' },
  NodeOperationError: class extends Error {
    constructor(_node: any, error: Error | string, _opts?: any) {
      super(typeof error === 'string' ? error : error.message);
      this.name = 'NodeOperationError';
    }
  },
  NodeApiError: class extends Error {
    httpCode: string | null = null;
    constructor(_node: any, errorResponse: any, opts?: any) {
      super(opts?.message ?? errorResponse?.message ?? 'API error');
      this.name = 'NodeApiError';
      this.httpCode = errorResponse?.httpCode ?? errorResponse?.statusCode ?? null;
    }
  },
}));

function createContext(params: Record<string, any>, credentials?: Record<string, any> | null) {
  return {
    // `extractValue: true` mirrors n8n's runtime behavior for resource locator
    // reads — when set, return the inner `.value` of an `{ mode, value }`
    // object. Falls through to the raw value for plain strings (e.g. labels).
    getNodeParameter: vi.fn(
      (name: string, _idx?: number, fallback?: unknown, options?: { extractValue?: boolean }) => {
        const value = params[name];
        if (options?.extractValue && value && typeof value === 'object' && 'value' in value) {
          return (value as { value: unknown }).value;
        }
        return value ?? fallback;
      },
    ),
    getCredentials:
      credentials === null
        ? vi.fn().mockRejectedValue(new Error('No credentials'))
        : vi.fn().mockResolvedValue(credentials ?? { token: 'ship-test' }),
    getInputData: vi.fn(() => [{ json: {} }]),
    getNode: vi.fn(() => ({ name: 'ShipStatic' })),
    continueOnFail: vi.fn(() => false),
    helpers: {
      assertBinaryData: vi.fn().mockReturnValue({ fileName: 'index.html' }),
      getBinaryDataBuffer: vi.fn().mockResolvedValue(Buffer.from('<html></html>')),
      httpRequest: vi.fn().mockResolvedValue({ deployment: 'test.shipstatic.com' }),
      httpRequestWithAuthentication: vi.fn().mockResolvedValue({}),
      request: vi.fn().mockResolvedValue({ deployment: 'test.shipstatic.com' }),
    },
  } as any;
}

// Resource locator value shape — what n8n stores when a user picks from the
// list or types by ID/name. Tests pass these so `extractValue: true` returns
// the inner string at runtime, exactly as n8n would.
function rl(value: string, mode: 'list' | 'id' | 'name' = 'list') {
  return { __rl: true, mode, value };
}

// Sugar for the most common deploy-context shape — keeps deploy tests crisp.
function createDeployContext(
  overrides: Record<string, any> = {},
  credentials?: Record<string, any> | null,
) {
  return createContext(
    {
      resource: 'deployment',
      operation: 'deploy',
      input: 'binary',
      binaryPropertyName: 'data',
      options: {},
      ...overrides,
    },
    credentials,
  );
}

function findDeployCall(ctx: any): any {
  return ctx.helpers.request.mock.calls.find(
    (c: any[]) => c[0].uri?.endsWith('/deployments') && c[0].method === 'POST',
  );
}

function getFormData(ctx: any): IDataObject {
  return findDeployCall(ctx)?.[0].formData;
}

const node = new Shipstatic();

// =============================================================================
// parseLabels — pure helper
// =============================================================================

describe('parseLabels', () => {
  it('returns undefined for empty string', () => {
    expect(parseLabels('')).toBeUndefined();
  });

  it('parses comma-separated labels and trims whitespace', () => {
    expect(parseLabels(' a , b , c ')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty segments', () => {
    expect(parseLabels('a,,b')).toEqual(['a', 'b']);
  });

  it('returns a single label when no commas are present', () => {
    expect(parseLabels('production')).toEqual(['production']);
  });

  it('handles trailing and leading commas', () => {
    expect(parseLabels(',foo,bar,')).toEqual(['foo', 'bar']);
  });

  it('returns empty array when input is whitespace and commas only', () => {
    expect(parseLabels(' , , ')).toEqual([]);
  });
});

// =============================================================================
// stripCommonPrefix — pure helper
// =============================================================================

describe('stripCommonPrefix', () => {
  it('returns input unchanged for fewer than two paths', () => {
    expect(stripCommonPrefix([])).toEqual([]);
    expect(stripCommonPrefix(['solo/file.html'])).toEqual(['solo/file.html']);
  });

  it('strips a single shared leading directory', () => {
    expect(stripCommonPrefix(['dist/index.html', 'dist/assets/app.js'])).toEqual([
      'index.html',
      'assets/app.js',
    ]);
  });

  it('strips multiple shared leading directories', () => {
    expect(stripCommonPrefix(['build/web/index.html', 'build/web/assets/app.js'])).toEqual([
      'index.html',
      'assets/app.js',
    ]);
  });

  it('preserves all paths when no common prefix exists', () => {
    expect(stripCommonPrefix(['frontend/index.html', 'public/robots.txt'])).toEqual([
      'frontend/index.html',
      'public/robots.txt',
    ]);
  });

  it('normalizes Windows-style backslashes to forward slashes', () => {
    expect(stripCommonPrefix(['dist\\index.html', 'dist\\assets\\app.js'])).toEqual([
      'index.html',
      'assets/app.js',
    ]);
  });

  it('never strips the final segment (always keeps the file name)', () => {
    // Even if all paths are identical, the file name must survive.
    expect(stripCommonPrefix(['a/b/c.html', 'a/b/c.html'])).toEqual(['c.html', 'c.html']);
  });
});

// =============================================================================
// extractResourceLocatorValue — pure helper
// =============================================================================

describe('extractResourceLocatorValue', () => {
  it('returns undefined for unset values (undefined, null, empty string)', () => {
    expect(extractResourceLocatorValue(undefined)).toBeUndefined();
    expect(extractResourceLocatorValue(null)).toBeUndefined();
    expect(extractResourceLocatorValue('')).toBeUndefined();
  });

  it('passes through a plain non-empty string unchanged', () => {
    // Backward-compat path — accepts strings as-is so callers that haven't
    // migrated to RL shape (or write tests with plain strings) still work.
    expect(extractResourceLocatorValue('happy-cat-abc.shipstatic.com')).toBe(
      'happy-cat-abc.shipstatic.com',
    );
  });

  it('extracts the inner value from an n8n resource-locator object', () => {
    expect(
      extractResourceLocatorValue({
        __rl: true,
        mode: 'id',
        value: 'happy-cat-abc.shipstatic.com',
      }),
    ).toBe('happy-cat-abc.shipstatic.com');
  });

  it('returns undefined for resource-locator objects with empty value', () => {
    expect(extractResourceLocatorValue({ __rl: true, mode: 'list', value: '' })).toBeUndefined();
  });

  it('returns undefined for resource-locator objects whose value is not a string', () => {
    // Defensive — never trust the shape. Numeric / object values for `value`
    // are out of contract and should be treated as unset.
    expect(extractResourceLocatorValue({ value: 42 })).toBeUndefined();
    expect(extractResourceLocatorValue({ value: {} })).toBeUndefined();
  });
});

// =============================================================================
// Deploy — authentication
// =============================================================================

describe('Deploy — authentication', () => {
  beforeEach(() => vi.clearAllMocks());

  it('with a token → Bearer header on the upload', async () => {
    const ctx = createDeployContext();

    await node.execute.call(ctx);

    const call = findDeployCall(ctx);
    expect(call).toBeDefined();
    expect(call[0].headers.Authorization).toBe('Bearer ship-test');
  });

  it('a deploy token rides the same slot — the server classifies, not the node', async () => {
    // One credential slot takes either population. The node never inspects the
    // prefix; a `deploy-` value is presented verbatim exactly like a `ship-`
    // one, which is what makes deploy-only workflows work at all.
    const ctx = createDeployContext({}, { token: 'deploy-abc' });

    await node.execute.call(ctx);

    expect(findDeployCall(ctx)[0].headers.Authorization).toBe('Bearer deploy-abc');
  });

  it('without credentials → NO Authorization header at all (the anonymous door)', async () => {
    // 2.x anonymity is in-band: a credential-less POST /deployments is granted
    // the public-account agent identity per request. There is no token to mint,
    // so the header is simply absent — not empty, not a bearer of nothing.
    const ctx = createDeployContext({}, null);

    await node.execute.call(ctx);

    const call = findDeployCall(ctx);
    expect(call[0].headers.Authorization).toBeUndefined();
  });

  it('an empty credential field deploys anonymously rather than sending a bare Bearer', async () => {
    // A saved-but-blank credential is absence of intent, not a credential.
    // `Bearer ` would be a 401 the user cannot diagnose. Same normalization
    // the SDK applies to an empty SHIP_TOKEN.
    const ctx = createDeployContext({}, { token: '' });

    await node.execute.call(ctx);

    expect(findDeployCall(ctx)[0].headers.Authorization).toBeUndefined();
  });

  it('no token round-trip precedes the deploy — the mint is gone', async () => {
    // The 1.x node minted an agent token through `POST /tokens/agent` before
    // every keyless deploy. The 2.x API deleted that endpoint; the fix was a
    // deletion, and this proves the deletion took. The SPA check is the only
    // other call the deploy path makes, and it is unauthenticated by design —
    // so the requests are ENUMERATED rather than counted. A count would let a
    // future round-trip slip in behind the same number.
    const ctx = createDeployContext({}, null);

    await node.execute.call(ctx);

    expect(ctx.helpers.request.mock.calls.map((c: any[]) => c[0].uri)).toEqual([
      'https://api.shipstatic.com/spa-check',
      'https://api.shipstatic.com/deployments',
    ]);
  });

  it('passes the response through verbatim — claim and expires included', async () => {
    // The keyless response carries a claim URL and an expiry, and a workflow
    // downstream is the caller most able to act on them. The node reshapes
    // nothing.
    const ctx = createDeployContext({}, null);
    ctx.helpers.request.mockResolvedValue(ANONYMOUS_DEPLOYMENT);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual(ANONYMOUS_DEPLOYMENT);
    expect(results[0].json.claim).toBe(ANONYMOUS_DEPLOYMENT.claim);
    expect(results[0].json.expires).toBe(ANONYMOUS_DEPLOYMENT.expires);
  });

  it('an authenticated deploy carries no claim and never expires', async () => {
    const ctx = createDeployContext();
    ctx.helpers.request.mockResolvedValue(DEPLOYMENT);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).not.toHaveProperty('claim');
    expect(results[0].json.expires).toBeNull();
  });
});

// =============================================================================
// Deploy — file collection & formData (handleDeploy success paths)
// =============================================================================

describe('Deploy — file collection & formData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends via and parsed labels in formData; never sets server-processing flags', async () => {
    const ctx = createDeployContext({ options: { labels: 'prod, v2' } });

    await node.execute.call(ctx);

    const fd = getFormData(ctx);
    expect(fd.via).toBe('n8n');
    expect(fd.labels).toBe('["prod","v2"]');
    expect(fd.password).toBeUndefined();
    // /deployments is a pure pipe — integrations must not set spa/build/prerender.
    expect(fd.spa).toBeUndefined();
    expect(fd.build).toBeUndefined();
    expect(fd.prerender).toBeUndefined();
  });

  it('sends password in formData when provided', async () => {
    const ctx = createDeployContext({ options: { password: 'secret123' } });

    await node.execute.call(ctx);

    expect(getFormData(ctx).password).toBe('secret123');
  });

  it('omits password when empty or whitespace-only', async () => {
    const ctx = createDeployContext({ options: { password: '   ' } });

    await node.execute.call(ctx);

    expect(getFormData(ctx).password).toBeUndefined();
  });

  // ─── Files (JSON) mode ────────────────────────────────────────────────────
  //
  // The agent-native path. T0b measured how an AI Agent reaches this node:
  // `$fromAI` carries string/number/boolean/json and NOTHING else, so a tool
  // call cannot hand over binary items — and its `json` arm type-checks the
  // VALUE, so what arrives is already parsed. Both facts drive these rows.

  const filesCtx = (files: unknown) => createDeployContext({ input: 'files', files });

  it('takes an already-resolved array — the agent path, and the main road', async () => {
    // NOT the exotic case. An expression (`{{ $json.files }}`) or an AI Agent's
    // `$fromAI(..., 'json')` both deliver a real array; only a hand-typed field
    // is a string. Parsing is the fallback.
    const ctx = filesCtx([
      { path: 'index.html', content: '<h1>Hi</h1>' },
      { path: 'style.css', content: 'body{margin:0}' },
    ]);

    await node.execute.call(ctx);

    const fd = getFormData(ctx);
    expect(fd['files[]']).toHaveLength(2);
    expect((fd['files[]'] as any[]).map((f) => f.options.filename)).toEqual([
      'index.html',
      'style.css',
    ]);
    expect((fd['files[]'] as any[])[0].value.toString('utf-8')).toBe('<h1>Hi</h1>');
  });

  it('takes a typed JSON string — the fallback shape', async () => {
    const ctx = filesCtx('[{"path":"index.html","content":"<h1>Hi</h1>"}]');

    await node.execute.call(ctx);

    expect(getFormData(ctx)['files[]']).toHaveLength(1);
  });

  it('defaults encoding to utf-8 and decodes base64 to the right bytes', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ctx = filesCtx([
      { path: 'index.html', content: '<h1>Hi</h1>' },
      { path: 'img/logo.png', content: png.toString('base64'), encoding: 'base64' },
    ]);

    await node.execute.call(ctx);

    const entries = getFormData(ctx)['files[]'] as any[];
    expect(entries[0].value.toString('utf-8')).toBe('<h1>Hi</h1>');
    // Checksum-verified: the bytes are the ORIGINAL bytes, not the base64 text.
    expect(entries[1].value.equals(png)).toBe(true);
    const checksums = JSON.parse(getFormData(ctx).checksums as string);
    expect(checksums[1]).toBe(createHash('md5').update(png).digest('hex'));
  });

  it('never strips a common prefix — the paths were written, not discovered', async () => {
    // Binary mode strips because filesystem paths carry an accident of where
    // the files sat. These paths came from an agent or an author, and the
    // hosted MCP's grammar promises "the site root is implied by these paths".
    const ctx = filesCtx([
      { path: 'dist/index.html', content: 'a' },
      { path: 'dist/app.css', content: 'b' },
    ]);

    await node.execute.call(ctx);

    expect((getFormData(ctx)['files[]'] as any[]).map((f) => f.options.filename)).toEqual([
      'dist/index.html',
      'dist/app.css',
    ]);
  });

  it('runs SPA detection over files-mode input like every other mode', async () => {
    const ctx = filesCtx([{ path: 'index.html', content: '<div id="root"></div>' }]);
    ctx.helpers.request.mockImplementation((opts: any) =>
      opts.uri?.endsWith('/spa-check')
        ? Promise.resolve({ isSPA: true })
        : Promise.resolve({ deployment: 'x.shipstatic.com' }),
    );

    await node.execute.call(ctx);

    const names = (getFormData(ctx)['files[]'] as any[]).map((f) => f.options.filename);
    expect(names).toContain('ship.json');
  });

  it('sends ttl in formData when the option was added', async () => {
    const ctx = createDeployContext({ options: { ttl: 3600 } });

    await node.execute.call(ctx);

    // A multipart body is all strings — the API's `collectTtlFromFormData`
    // does the `Number()` on its side, so producing the string is this end's job.
    expect(getFormData(ctx).ttl).toBe('3600');
  });

  it('omits ttl when the option was not added', async () => {
    const ctx = createDeployContext({ options: {} });

    await node.execute.call(ctx);

    expect(getFormData(ctx).ttl).toBeUndefined();
  });

  it('forwards a zero ttl rather than swallowing it — the server owns the range', async () => {
    // Key presence, not truthiness. `0` is below the platform's minimum, and
    // the refusal belongs to the server: a client that silently dropped it
    // would be a second validator, and the user would see a deployment that
    // never expires after asking for one that expires immediately.
    const ctx = createDeployContext({ options: { ttl: 0 } });

    await node.execute.call(ctx);

    expect(getFormData(ctx).ttl).toBe('0');
  });

  it('collects multiple items into one deployment', async () => {
    const ctx = createDeployContext();
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
    ctx.helpers.assertBinaryData
      .mockReturnValueOnce({ fileName: 'index.html' })
      .mockReturnValueOnce({ fileName: 'style.css', directory: 'css' });
    ctx.helpers.getBinaryDataBuffer
      .mockResolvedValueOnce(Buffer.from('<html></html>'))
      .mockResolvedValueOnce(Buffer.from('body{}'));

    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    const fd = getFormData(ctx);
    const files = fd['files[]'] as any[];
    expect(files).toHaveLength(2);
    expect(files[0].options.filename).toBe('index.html');
    expect(files[1].options.filename).toBe('css/style.css');
  });

  it('strips common directory prefix from paths', async () => {
    const ctx = createDeployContext();
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
    ctx.helpers.assertBinaryData
      .mockReturnValueOnce({ fileName: 'index.html', directory: 'dist' })
      .mockReturnValueOnce({ fileName: 'app.js', directory: 'dist/assets' });
    ctx.helpers.getBinaryDataBuffer
      .mockResolvedValueOnce(Buffer.from('<html></html>'))
      .mockResolvedValueOnce(Buffer.from('console.log()'));

    await node.execute.call(ctx);

    const files = getFormData(ctx)['files[]'] as any[];
    expect(files[0].options.filename).toBe('index.html');
    expect(files[1].options.filename).toBe('assets/app.js');
  });

  it('preserves all paths when files share no common directory prefix', async () => {
    // strip === 0 branch — mixed top-level files should pass through untouched.
    const ctx = createDeployContext();
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
    ctx.helpers.assertBinaryData
      .mockReturnValueOnce({ fileName: 'index.html', directory: 'frontend' })
      .mockReturnValueOnce({ fileName: 'robots.txt', directory: 'public' });
    ctx.helpers.getBinaryDataBuffer
      .mockResolvedValueOnce(Buffer.from('<html></html>'))
      .mockResolvedValueOnce(Buffer.from('User-agent: *'));

    await node.execute.call(ctx);

    const files = getFormData(ctx)['files[]'] as any[];
    expect(files[0].options.filename).toBe('frontend/index.html');
    expect(files[1].options.filename).toBe('public/robots.txt');
  });

  it('skips empty files', async () => {
    const ctx = createDeployContext();
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
    ctx.helpers.assertBinaryData
      .mockReturnValueOnce({ fileName: 'empty.txt' })
      .mockReturnValueOnce({ fileName: 'real.html' });
    ctx.helpers.getBinaryDataBuffer
      .mockResolvedValueOnce(Buffer.alloc(0))
      .mockResolvedValueOnce(Buffer.from('<html></html>'));

    await node.execute.call(ctx);

    const files = getFormData(ctx)['files[]'] as any[];
    expect(files).toHaveLength(1);
    expect(files[0].options.filename).toBe('real.html');
  });

  it('sends correct MD5 checksums for each file', async () => {
    const { createHash } = await import('node:crypto');
    const ctx = createDeployContext();
    const content = Buffer.from('<html></html>');
    const expectedMd5 = createHash('md5').update(content).digest('hex');

    await node.execute.call(ctx);

    const fd = getFormData(ctx);
    expect(fd.checksums).toBe(`["${expectedMd5}"]`);
  });

  it('single file deploy preserves path without stripping', async () => {
    const ctx = createDeployContext();
    ctx.helpers.assertBinaryData.mockReturnValue({
      fileName: 'index.html',
      directory: 'dist',
    });

    await node.execute.call(ctx);

    const files = getFormData(ctx)['files[]'] as any[];
    expect(files[0].options.filename).toBe('dist/index.html');
  });

  it('names an unnamed binary item by its index rather than dropping it', async () => {
    // Binary data reaching n8n from an HTTP Request or a database column often
    // carries no fileName. A deployment needs a path for every file, so the
    // index is the fallback — silently skipping the item would lose it.
    const ctx = createDeployContext();
    ctx.helpers.assertBinaryData.mockReturnValue({});

    await node.execute.call(ctx);

    const files = getFormData(ctx)['files[]'] as any[];
    expect(files[0].options.filename).toBe('file_0');
  });

  it('text mode falls back to index.html when File Name is cleared', async () => {
    const ctx = createDeployContext({
      input: 'text',
      fileContent: '<html></html>',
      fileName: '',
    });

    await node.execute.call(ctx);

    const files = getFormData(ctx)['files[]'] as any[];
    expect(files[0].options.filename).toBe('index.html');
  });

  it('text mode deploys fileContent with specified fileName', async () => {
    const ctx = createDeployContext({
      input: 'text',
      fileContent: '<html><body>Hello</body></html>',
      fileName: 'index.html',
    });

    await node.execute.call(ctx);

    const fd = getFormData(ctx);
    const files = fd['files[]'] as any[];
    expect(files).toHaveLength(1);
    expect(files[0].options.filename).toBe('index.html');
    expect(fd.via).toBe('n8n');
  });
});

// =============================================================================
// Deploy — SPA parity & idempotency
// =============================================================================

describe('Deploy — SPA routing', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Route the deploy mock: /spa-check answers `isSPA`, /deployments succeeds. */
  function spaCtx(isSPA: boolean, overrides: Record<string, any> = {}) {
    const ctx = createDeployContext(overrides);
    ctx.helpers.request.mockImplementation(async (opts: any) =>
      opts.uri.endsWith('/spa-check') ? { isSPA } : DEPLOYMENT,
    );
    return ctx;
  }

  const filenames = (ctx: any) =>
    (getFormData(ctx)['files[]'] as any[]).map((f) => f.options.filename);

  it('appends a routing config when the API detects a single-page app', async () => {
    // Without this, a React build deployed from a workflow serves 404s on
    // every route but `/` — on the one surface whose users are least equipped
    // to know that `ship.json` is the remedy.
    const ctx = spaCtx(true);

    await node.execute.call(ctx);

    expect(filenames(ctx)).toContain('ship.json');
    const config = (getFormData(ctx)['files[]'] as any[]).find(
      (f) => f.options.filename === 'ship.json',
    );
    expect(JSON.parse(config.value.toString())).toEqual({
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
    });
  });

  it('its checksum rides along — the API verifies every file', async () => {
    // The config is appended BEFORE formData is built. Were it after, the
    // API would reject the deploy for a files/checksums length mismatch.
    const ctx = spaCtx(true);

    await node.execute.call(ctx);

    const fd = getFormData(ctx);
    expect(JSON.parse(fd.checksums as string)).toHaveLength((fd['files[]'] as any[]).length);
  });

  it('adds nothing when the app is not a single-page app', async () => {
    const ctx = spaCtx(false);

    await node.execute.call(ctx);

    expect(filenames(ctx)).not.toContain('ship.json');
  });

  it('never overrides a config the user shipped themselves', async () => {
    const ctx = spaCtx(true);
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
    ctx.helpers.assertBinaryData
      .mockReturnValueOnce({ fileName: 'index.html' })
      .mockReturnValueOnce({ fileName: 'ship.json' });
    ctx.helpers.getBinaryDataBuffer
      .mockResolvedValueOnce(Buffer.from('<html></html>'))
      .mockResolvedValueOnce(Buffer.from('{"rewrites":[]}'));

    await node.execute.call(ctx);

    const configs = filenames(ctx).filter((f: string) => f === 'ship.json');
    expect(configs).toHaveLength(1);
    // And the check never ran — the user already decided.
    expect(
      ctx.helpers.request.mock.calls.filter((c: any[]) => c[0].uri.endsWith('/spa-check')),
    ).toHaveLength(0);
  });

  it('the toggle turns it off, and skips the round-trip entirely', async () => {
    const ctx = spaCtx(true, { options: { spaDetect: false } });

    await node.execute.call(ctx);

    expect(filenames(ctx)).not.toContain('ship.json');
    expect(
      ctx.helpers.request.mock.calls.filter((c: any[]) => c[0].uri.endsWith('/spa-check')),
    ).toHaveLength(0);
  });

  it('a failed detection never gates the deploy', async () => {
    // The SDK's own posture: detection is an enhancement. A 500 on /spa-check
    // must not cost the user their deployment.
    const ctx = createDeployContext();
    ctx.helpers.request.mockImplementation(async (opts: any) => {
      if (opts.uri.endsWith('/spa-check')) throw new Error('detector down');
      return DEPLOYMENT;
    });

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual(DEPLOYMENT);
    expect(filenames(ctx)).not.toContain('ship.json');
  });

  it('skips the check when there is no index.html to read', async () => {
    const ctx = spaCtx(true, {
      input: 'text',
      fileContent: 'hello',
      fileName: 'readme.txt',
    });

    await node.execute.call(ctx);

    expect(
      ctx.helpers.request.mock.calls.filter((c: any[]) => c[0].uri.endsWith('/spa-check')),
    ).toHaveLength(0);
  });

  it('sends the deployed paths and the index contents, like the SDK does', async () => {
    const ctx = spaCtx(false);

    await node.execute.call(ctx);

    const check = ctx.helpers.request.mock.calls.find((c: any[]) =>
      c[0].uri.endsWith('/spa-check'),
    );
    expect(check[0].body).toEqual({ files: ['index.html'], index: '<html></html>' });
  });

  it('presents the credential on the pre-flight, like the SDK does', async () => {
    // `/spa-check` charges an anonymous caller the public write bucket and
    // exempts a credentialed one, so probing anonymously with a token in hand
    // spends a budget the user already paid to avoid. The SDK's client
    // attaches auth to every request; so does this.
    const ctx = spaCtx(false);

    await node.execute.call(ctx);

    const check = ctx.helpers.request.mock.calls.find((c: any[]) =>
      c[0].uri.endsWith('/spa-check'),
    );
    expect(check[0].headers.Authorization).toBe('Bearer ship-test');
  });

  it('probes anonymously when there is no credential to present', async () => {
    const ctx = createDeployContext({}, null);
    ctx.helpers.request.mockImplementation(async (opts: any) =>
      opts.uri.endsWith('/spa-check') ? { isSPA: false } : DEPLOYMENT,
    );

    await node.execute.call(ctx);

    const check = ctx.helpers.request.mock.calls.find((c: any[]) =>
      c[0].uri.endsWith('/spa-check'),
    );
    expect(check[0].headers.Authorization).toBeUndefined();
  });
});

describe('Deploy — idempotency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the key as the Idempotency-Key header', async () => {
    // n8n's Retry On Fail makes this the platform surface most likely to
    // retry a deploy automatically.
    const ctx = createDeployContext({ options: { idempotencyKey: 'exec-42' } });

    await node.execute.call(ctx);

    expect(findDeployCall(ctx)[0].headers['Idempotency-Key']).toBe('exec-42');
  });

  it('omits the header when no key is given', async () => {
    const ctx = createDeployContext();

    await node.execute.call(ctx);

    expect(findDeployCall(ctx)[0].headers['Idempotency-Key']).toBeUndefined();
  });

  it('rides alongside the credential rather than replacing it', async () => {
    const ctx = createDeployContext({ options: { idempotencyKey: 'exec-42' } });

    await node.execute.call(ctx);

    const headers = findDeployCall(ctx)[0].headers;
    expect(headers.Authorization).toBe('Bearer ship-test');
    expect(headers['Idempotency-Key']).toBe('exec-42');
  });
});

// =============================================================================
// Deploy — error handling (handleDeploy failure paths)
// =============================================================================

describe('Deploy — error handling', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─── Files (JSON) refusals ────────────────────────────────────────────────
  //
  // Every message is authored for whoever reads it, and for files mode that is
  // often an LLM correcting its own tool call — so a refusal that only says
  // "invalid" leaves it nothing to aim at. Each of these names the shape.

  const filesCtx = (files: unknown) => createDeployContext({ input: 'files', files });
  const rejects = async (files: unknown, message: RegExp) =>
    expect(node.execute.call(filesCtx(files))).rejects.toMatchObject({
      name: 'NodeOperationError',
      message: expect.stringMatching(message),
    });

  it('refuses malformed JSON', async () => {
    await rejects('[{"path": broken}]', /not valid JSON/i);
  });

  it('refuses a non-empty OBJECT by naming the array it wanted', async () => {
    // The one an agent hits in good faith: n8n's own host-side validator for a
    // `json` parameter admits "a non-empty object OR a non-empty array"
    // (measured, T0b), so `{...}` reaches the node having passed every check
    // upstream. The refusal has to describe the array, or the agent has
    // nothing to correct toward.
    await rejects({ 'index.html': '<h1>Hi</h1>' }, /must be a JSON array/i);
    await rejects({ 'index.html': '<h1>Hi</h1>' }, /received object/i);
  });

  it('refuses a JSON string that parses to something other than an array', async () => {
    await rejects('"just a string"', /must be a JSON array/i);
  });

  it('names null as null rather than as "object"', async () => {
    // `typeof null === 'object'`, so the naive message would tell someone who
    // sent nothing that they sent an object. The received type rides the
    // MESSAGE because that is what n8n renders and what an agent reads first.
    await rejects('null', /received null/i);
  });

  it('refuses an entry missing path or content, naming which file', async () => {
    await rejects([{ content: 'x' }], /File 1 is missing a "path"/i);
    await rejects([{ path: 'a.html' }], /File 1 .*is missing a "content"/i);
  });

  it('refuses an entry that is not an object', async () => {
    await rejects(['index.html'], /File 1 is not an object/i);
  });

  it('mirrors the hosted MCP path checks, one refusal each', async () => {
    await rejects([{ path: '', content: 'x' }], /is empty/i);
    await rejects([{ path: '/index.html', content: 'x' }], /starts with "\/"/i);
    await rejects([{ path: 'a\\b.html', content: 'x' }], /backslash/i);
    await rejects([{ path: '../secrets', content: 'x' }], /"\." or "\.\." segment/i);
    await rejects([{ path: 'a\0b', content: 'x' }], /null byte/i);
  });

  it('refuses an unknown encoding', async () => {
    await rejects([{ path: 'a.html', content: 'x', encoding: 'hex' }], /unknown encoding/i);
  });

  it('refuses content marked base64 that is not base64', async () => {
    // `Buffer.from(x, "base64")` NEVER throws — it silently discards anything
    // outside the alphabet. Without the structural check this deploys garbage
    // bytes and the user gets a broken image instead of an error, while the
    // hosted MCP (whose `atob` throws) refuses the very same payload.
    await rejects(
      [{ path: 'logo.png', content: 'this is definitely not base64!!', encoding: 'base64' }],
      /not valid base64/i,
    );
  });

  it('accepts base64 wrapped across lines — whitespace is transport, not garbage', async () => {
    const bytes = Buffer.from('hello world, this is a longer payload to wrap');
    const wrapped = bytes.toString('base64').replace(/(.{8})/g, '$1\n');
    const ctx = filesCtx([{ path: 'a.bin', content: wrapped, encoding: 'base64' }]);

    await node.execute.call(ctx);

    expect((getFormData(ctx)['files[]'] as any[])[0].value.equals(bytes)).toBe(true);
  });

  it('refuses an empty array the same way the other modes refuse zero files', async () => {
    await rejects([], /No files to deploy/i);
  });

  it('throws NodeOperationError when all input items are empty', async () => {
    const ctx = createDeployContext();
    ctx.helpers.getBinaryDataBuffer.mockResolvedValue(Buffer.alloc(0));

    await expect(node.execute.call(ctx)).rejects.toMatchObject({
      name: 'NodeOperationError',
      message: expect.stringContaining('No files to deploy'),
    });
  });

  it('wraps deploy HTTP failures in NodeApiError to preserve status code', async () => {
    const ctx = createDeployContext();
    const httpError: any = new Error('Deploy rejected');
    httpError.httpCode = '413';
    ctx.helpers.request.mockRejectedValue(httpError);

    await expect(node.execute.call(ctx)).rejects.toMatchObject({
      name: 'NodeApiError',
      httpCode: '413',
    });
  });

  it('a rejected token fails the deploy — it never downgrades to anonymous', async () => {
    // The fail-closed anonymity invariant. Anonymity requires proven ABSENCE
    // of credentials; a credential that is present and refused is an error,
    // never a silent public deploy under someone else's account.
    const ctx = createDeployContext();
    const httpError: any = new Error('Unauthorized');
    httpError.httpCode = '401';
    ctx.helpers.request.mockRejectedValue(httpError);

    await expect(node.execute.call(ctx)).rejects.toMatchObject({
      name: 'NodeApiError',
      httpCode: '401',
    });
    // One DEPLOY attempt. No retry without the header. (The SPA check also
    // rejects here and is swallowed by design — detection never gates a
    // deploy — so deploy calls are counted rather than all calls.)
    expect(
      ctx.helpers.request.mock.calls.filter((c: any[]) => c[0].uri?.endsWith('/deployments')),
    ).toHaveLength(1);
  });

  it('a rate-limited KEYLESS deploy surfaces the actionable "add a key" message', async () => {
    // The anonymous bucket used to sit on the agent-token mint; in 2.x it
    // meters `POST /deployments` per IP directly. The hint moved with the
    // limit rather than dying with the endpoint — the promise it made to the
    // user is still the right one.
    const ctx = createDeployContext({}, null);
    const httpError: any = new Error('Too Many Requests');
    httpError.httpCode = '429';
    ctx.helpers.request.mockRejectedValue(httpError);

    await expect(node.execute.call(ctx)).rejects.toMatchObject({
      name: 'NodeApiError',
      message: expect.stringContaining('Public deploy rate limit exceeded'),
    });
  });

  it('recognises the rate limit whether the status arrives as a string or a number', async () => {
    // The legacy `request` helper reports the status as `httpCode` (string) on
    // some paths and `statusCode` (number) on others, which is why both are
    // read and both spellings compared. Half of that would work in testing and
    // fail on whichever path the user hit.
    const ctx = createDeployContext({}, null);
    const httpError: any = new Error('Too Many Requests');
    httpError.statusCode = 429;
    ctx.helpers.request.mockRejectedValue(httpError);

    await expect(node.execute.call(ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Public deploy rate limit exceeded'),
    });
  });

  it('a rate-limited AUTHENTICATED deploy does NOT suggest adding a key', async () => {
    // Different limit, different advice. Telling a user with a key to add a
    // key is worse than saying nothing — the hint is conditional on the
    // credential being absent, and this is what holds it there.
    const ctx = createDeployContext();
    const httpError: any = new Error('Too Many Requests');
    httpError.httpCode = '429';
    ctx.helpers.request.mockRejectedValue(httpError);

    await expect(node.execute.call(ctx)).rejects.toMatchObject({
      name: 'NodeApiError',
      message: 'Too Many Requests',
    });
  });

  it('returns error item when continueOnFail is enabled', async () => {
    const ctx = createDeployContext();
    ctx.helpers.request.mockRejectedValue(new Error('Deploy failed'));
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({ error: 'Deploy failed' });
  });

  it('continueOnFail traces error back to ALL input items, not just item 0', async () => {
    // Deploy collects every input item into a single upload, so on failure
    // the error item must pair to all of them. Hardcoding `{ item: 0 }`
    // would silently drop items 1..N from n8n's data lineage.
    const ctx = createDeployContext();
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }, { json: {} }]);
    ctx.helpers.request.mockRejectedValue(new Error('Deploy failed'));
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it('a non-Error throw still produces a readable error item', async () => {
    // Not the HTTP path — `uploadDeployment` wraps every rejection in
    // NodeApiError, so nothing non-Error survives it. The reachable source is
    // n8n's own binary helpers, which are not contractually bound to throw an
    // Error. Without the fallback the user reads `{ error: undefined }`.
    const ctx = createDeployContext();
    ctx.helpers.assertBinaryData.mockImplementation(() => {
      throw 'binary property "data" is not present';
    });
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({ error: 'An unexpected error occurred' });
  });
});

// =============================================================================
// Deployment operations — execute() routing for the Deployment resource
// =============================================================================

describe('Deployment operations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get calls GET /deployments/:id', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl('happy-cat-abc1234.shipstatic.com', 'id'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
      deployment: 'happy-cat-abc1234.shipstatic.com',
    });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('GET');
    expect(call[1].url).toBe(
      'https://api.shipstatic.com/deployments/happy-cat-abc1234.shipstatic.com',
    );
  });

  it('set with populated labels sends the parsed array as PATCH body', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'set',
      deployment: rl('test.shipstatic.com', 'id'),
      labels: 'production, v1',
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ deployment: 'a' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('PATCH');
    expect(call[1].url).toBe('https://api.shipstatic.com/deployments/test.shipstatic.com');
    expect(call[1].body).toEqual({ labels: ['production', 'v1'] });
  });

  it('set with empty labels input clears via PATCH body', async () => {
    // Empty string is the n8n-native way for the user to say "clear all
    // labels". `parseLabels('') ?? []` flattens this to the API's clear shape.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'set',
      deployment: rl('test.shipstatic.com', 'id'),
      labels: '',
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ deployment: 'a' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('PATCH');
    expect(call[1].body).toEqual({ labels: [] });
  });

  it('delete calls DELETE /deployments/:id and returns the wire acknowledgement', async () => {
    // The API answers 202 with `{ deployment, status: 'deleting' }` — the row
    // states the plan it is transitioning through, because the site stays
    // served until cleanup completes. A workflow branching on the deletion is
    // the caller MOST able to act on that state; the node used to throw it
    // away and fabricate `{ success: true }`, the boolean the platform's
    // "state, not boolean" mutation law retired.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'delete',
      deployment: rl(DEPLOYMENT.deployment, 'id'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(DEPLOYMENT_DELETED);

    const [results] = await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('DELETE');
    expect(call[1].url).toBe(`https://api.shipstatic.com/deployments/${DEPLOYMENT.deployment}`);
    expect(results[0].json).toEqual(DEPLOYMENT_DELETED);
    expect(results[0].json.status).toBe('deleting');
    expect(results[0].json).not.toHaveProperty('success');
  });
});

// =============================================================================
// Domain operations — execute() routing for the Domain resource
// =============================================================================

describe('Domain operations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dns calls GET /domains/:name/dns', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'dns',
      domain: rl('www.example.com', 'name'),
    });
    // The fixture is the API's shape, not a plausible one: the provider is
    // nested under `dns`, and this assertion used to claim a flat
    // `provider: 'cloudflare'` the API has never sent. Typed fixtures are how
    // a hand-written HTTP client stops inventing the responses it reads.
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(DOMAIN_DNS);

    const [results] = await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('GET');
    expect(call[1].url).toBe(`https://api.shipstatic.com/domains/${DOMAIN.domain}/dns`);
    expect(results[0].json).toEqual(DOMAIN_DNS);
  });

  it('get calls GET /domains/:name', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'get',
      domain: rl('www.example.com', 'name'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('GET');
    expect(call[1].url).toBe('https://api.shipstatic.com/domains/www.example.com');
  });

  it('records calls GET /domains/:name/records', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'records',
      domain: rl('www.example.com', 'name'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(DOMAIN_RECORDS);

    const [results] = await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('GET');
    expect(call[1].url).toBe(`https://api.shipstatic.com/domains/${DOMAIN.domain}/records`);
    expect(results[0].json).toEqual(DOMAIN_RECORDS);
  });

  it('delete calls DELETE /domains/:name and returns the wire acknowledgement', async () => {
    // `{ domain }` at 200 — the domain is gone when the call returns, which is
    // why this acknowledgement carries no state where the deployment's does.
    const ctx = createContext({
      resource: 'domain',
      operation: 'delete',
      domain: rl(DOMAIN.domain, 'name'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(DOMAIN_DELETED);

    const [results] = await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('DELETE');
    expect(call[1].url).toBe(`https://api.shipstatic.com/domains/${DOMAIN.domain}`);
    expect(results[0].json).toEqual(DOMAIN_DELETED);
    expect(results[0].json).not.toHaveProperty('success');
  });

  it('share calls GET /domains/:name/share', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'share',
      domain: rl('www.example.com', 'name'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(DOMAIN_SHARE);

    const [results] = await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('GET');
    expect(call[1].url).toBe(`https://api.shipstatic.com/domains/${DOMAIN.domain}/share`);
    expect(results[0].json).toEqual(DOMAIN_SHARE);
  });

  it('validate calls POST /domains/validate with body', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'validate',
      domain: rl('www.example.com', 'name'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(DOMAIN_VALID);

    const [results] = await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('POST');
    expect(call[1].url).toBe('https://api.shipstatic.com/domains/validate');
    expect(call[1].body).toEqual({ domain: DOMAIN.domain });
    expect(results[0].json).toEqual(DOMAIN_VALID);
  });

  it('verify calls POST /domains/:name/verify', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'verify',
      domain: rl('www.example.com', 'name'),
    });
    // 202: the DNS check is QUEUED, not performed. The acknowledgement states
    // no status precisely because the domain's own status is unchanged until
    // the check runs — this assertion used to claim a `{ status: 'pending' }`
    // the API does not send.
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(DOMAIN_VERIFY);

    const [results] = await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('POST');
    expect(call[1].url).toBe(`https://api.shipstatic.com/domains/${DOMAIN.domain}/verify`);
    expect(results[0].json).toEqual(DOMAIN_VERIFY);
  });

  // ─── set merge-upsert semantics ─────────────────────────────────────────
  // PUT /domains/:name preserves omitted fields, updates present ones, and
  // clears when present-but-empty. n8n's options collection mirrors this:
  // adding the Labels option (key present in `options`) means "set"; not
  // adding it means "preserve". Empty-string deployment is treated as not
  // provided (we never want to wipe a domain's deployment link silently).

  it('set: omits both fields when no options are provided (preserve)', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'set',
      domain: rl('www.example.com', 'name'),
      options: {},
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('PUT');
    expect(call[1].body).toEqual({});
  });

  it('set: clears labels when Labels option is added with empty value', async () => {
    // Mirrors deployment.set semantics: present-key + empty value = clear.
    // Asymmetric handling here was a real bug (n8n could not clear labels on
    // domains, only on deployments) — guarded by this test going forward.
    const ctx = createContext({
      resource: 'domain',
      operation: 'set',
      domain: rl('www.example.com', 'name'),
      options: { labels: '' },
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].body).toEqual({ labels: [] });
  });

  it('set: sends labels and deployment when both options are provided', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'set',
      domain: rl('www.example.com', 'name'),
      options: { deployment: 'happy-cat-abc.shipstatic.com', labels: 'prod, v1' },
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].body).toEqual({
      deployment: 'happy-cat-abc.shipstatic.com',
      labels: ['prod', 'v1'],
    });
  });

  it('set: deployment-only update (Labels option absent → preserved)', async () => {
    // User adds the Deployment option (e.g. switching the domain to a new
    // deployment) but does NOT add the Labels option. Body must carry only
    // `deployment` so the API preserves existing labels.
    const ctx = createContext({
      resource: 'domain',
      operation: 'set',
      domain: rl('www.example.com', 'name'),
      options: { deployment: 'new-deployment.shipstatic.com' },
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].body).toEqual({ deployment: 'new-deployment.shipstatic.com' });
    expect(call[1].body.labels).toBeUndefined();
  });

  it('set: unwraps a resource-locator value for the inner Deployment option', async () => {
    // Inner-collection resource locators arrive as the raw `{ mode, value }`
    // shape (n8n's `extractValue: true` only works at the top level).
    // `extractResourceLocatorValue` handles the unwrapping uniformly.
    const ctx = createContext({
      resource: 'domain',
      operation: 'set',
      domain: rl('www.example.com', 'name'),
      options: { deployment: rl('happy-cat-abc.shipstatic.com', 'id') },
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].body).toEqual({ deployment: 'happy-cat-abc.shipstatic.com' });
  });

  it('set: accepts a freshly-typed domain via the resource-locator "By Name" mode', async () => {
    // Reserving / creating a brand-new domain — the user types a name in
    // the resource locator's "By Name" mode rather than picking from the
    // list. extractValue gives us the typed string just the same.
    const ctx = createContext({
      resource: 'domain',
      operation: 'set',
      domain: rl('www.brand-new.com', 'name'),
      options: {},
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.brand-new.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('PUT');
    expect(call[1].url).toBe('https://api.shipstatic.com/domains/www.brand-new.com');
    expect(call[1].body).toEqual({});
  });

  it('set: omits empty deployment string from body (treats as not provided)', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'set',
      domain: rl('www.example.com', 'name'),
      options: { deployment: '', labels: 'prod' },
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

    await node.execute.call(ctx);

    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].body).toEqual({ labels: ['prod'] });
    expect(call[1].body.deployment).toBeUndefined();
  });
});

// =============================================================================
// Auth gate — non-deploy operations require credentials
// =============================================================================

describe('Auth gate for non-deploy operations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws with a clear message when credentials are missing', async () => {
    const ctx = createContext({ resource: 'deployment', operation: 'list' }, null);

    await expect(node.execute.call(ctx)).rejects.toThrow(
      'This operation requires ShipStatic credentials',
    );
  });
});

// =============================================================================
// Global vs per-item iteration — list/account run once; per-item ops fan out
// =============================================================================

describe('Global vs per-item iteration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deployments list calls API once with N input items, pairs output to all', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'list',
      returnAll: true,
    });
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }, { json: {} }]);
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
      deployments: [{ deployment: 'a' }, { deployment: 'b' }],
    });

    const [results] = await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    // pairedItem traces back to ALL input items, not just item 0.
    expect(results[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
    expect(results[1].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it('domains list calls API once with N input items', async () => {
    const ctx = createContext({
      resource: 'domain',
      operation: 'list',
      returnAll: true,
    });
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
      domains: [{ domain: 'www.example.com' }],
    });

    const [results] = await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('account get calls GET /account once and returns the body', async () => {
    const ctx = createContext({
      resource: 'account',
      operation: 'get',
    });
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }, { json: {} }, { json: {} }]);
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(ACCOUNT);

    const [results] = await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
    const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
    expect(call[1].method).toBe('GET');
    expect(call[1].url).toBe('https://api.shipstatic.com/account');
    expect(results).toHaveLength(1);
    expect(results[0].json).toEqual(ACCOUNT);
    expect(results[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }, { item: 3 }]);
  });

  it('per-item operation (deployment get) fans out one call per input item', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl('happy-cat-abc1234.shipstatic.com', 'id'),
    });
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }, { json: {} }]);
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ deployment: 'a' });

    const [results] = await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    expect(results[0].pairedItem).toEqual({ item: 0 });
    expect(results[2].pairedItem).toEqual({ item: 2 });
  });

  // ─── List controls (returnAll / limit) ──────────────────────────────────
  // Same logic for both deployment.list and domain.list — covered once here.

  it('list returnAll=true returns every result (no client-side slice)', async () => {
    const ctx = createContext({ resource: 'deployment', operation: 'list', returnAll: true });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
      deployments: [{ deployment: 'a' }, { deployment: 'b' }, { deployment: 'c' }],
    });

    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(3);
  });

  it('list returnAll=false slices to limit', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'list',
      returnAll: false,
      limit: 2,
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
      deployments: [{ deployment: 'a' }, { deployment: 'b' }, { deployment: 'c' }],
    });

    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
  });

  it('domain list returnAll=false slices to limit too', async () => {
    // The two list operations carry the same client-side slice written twice,
    // and only one of them was exercised — so the domain copy could have been
    // deleted and the suite would have stayed green.
    const ctx = createContext({
      resource: 'domain',
      operation: 'list',
      returnAll: false,
      limit: 1,
    });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
      domains: [DOMAIN, { ...DOMAIN, domain: 'blog.example.com' }],
    });

    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    expect(results[0].json).toEqual(DOMAIN);
  });

  it('a list response missing its array yields no items rather than throwing', async () => {
    // Defensive `?? []` on both list paths. A body without the key is out of
    // contract, and the honest answer is zero items — not a TypeError inside a
    // for-of that the user reads as "the node is broken".
    for (const resource of ['deployment', 'domain']) {
      const ctx = createContext({ resource, operation: 'list', returnAll: true });
      ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({});

      const [results] = await node.execute.call(ctx);

      expect(results).toEqual([]);
    }
  });
});

// =============================================================================
// Pagination — the walk, and what `Return All` promises
// =============================================================================
//
// The 2.x API paginates every list; the 1.x API did not. `returnAll` is a
// contract word in n8n's ecosystem — n8n's OWN lint rule enforces the sentence
// "Whether to return all results or only up to a given limit" verbatim — so a
// node that returns one page under it is lying in the ecosystem's own words.

describe('Pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Two pages, then the end. `cursor: null` is the entire has-more signal. */
  function pagedDeployments(ctx: any, pages: IDataObject[][]) {
    let call = 0;
    ctx.helpers.httpRequestWithAuthentication.mockImplementation(async () => {
      const page = pages[call] ?? [];
      const isLast = call >= pages.length - 1;
      call += 1;
      return { deployments: page, cursor: isLast ? null : `cursor-${call}` };
    });
  }

  const page = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({ ...DEPLOYMENT, deployment: `d${offset + i}` }));

  it('returnAll follows the cursor to the end', async () => {
    const ctx = createContext({ resource: 'deployment', operation: 'list', returnAll: true });
    pagedDeployments(ctx, [page(2), page(2, 2)]);

    const [results] = await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(4);
    expect(results.map((r: any) => r.json.deployment)).toEqual(['d0', 'd1', 'd2', 'd3']);
  });

  it('returnAll sends no limit — the server owns its page size', async () => {
    // Restating the server's default or cap here would give one fact two
    // owners. The walk terminates on `cursor: null`, never on a known number.
    const ctx = createContext({ resource: 'deployment', operation: 'list', returnAll: true });
    pagedDeployments(ctx, [page(1)]);

    await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication.mock.calls[0][1].url).toBe(
      'https://api.shipstatic.com/deployments',
    );
  });

  it('feeds the cursor back on the next request', async () => {
    const ctx = createContext({ resource: 'deployment', operation: 'list', returnAll: true });
    pagedDeployments(ctx, [page(1), page(1, 1)]);

    await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication.mock.calls[1][1].url).toBe(
      'https://api.shipstatic.com/deployments?cursor=cursor-1',
    );
  });

  it('a bounded limit asks for what it still needs, and continues past a clamp', async () => {
    // The server may return fewer than asked — it clamps silently at its own
    // cap. Handling that by CONTINUING is what keeps the cap out of this file.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'list',
      returnAll: false,
      limit: 3,
    });
    pagedDeployments(ctx, [page(2), page(2, 2)]);

    const [results] = await node.execute.call(ctx);

    const urls = ctx.helpers.httpRequestWithAuthentication.mock.calls.map((c: any[]) => c[1].url);
    expect(urls[0]).toBe('https://api.shipstatic.com/deployments?limit=3');
    // Two arrived, one is still wanted.
    expect(urls[1]).toBe('https://api.shipstatic.com/deployments?limit=1&cursor=cursor-1');
    expect(results).toHaveLength(3);
  });

  it('stops without a second request when the first page satisfies the limit', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'list',
      returnAll: false,
      limit: 2,
    });
    pagedDeployments(ctx, [page(2), page(2, 2)]);

    const [results] = await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
  });

  it('an empty page with a live cursor terminates instead of hanging', async () => {
    // Out of contract, and the honest failure is zero items — not an n8n
    // execution that never returns.
    const ctx = createContext({ resource: 'deployment', operation: 'list', returnAll: true });
    ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
      deployments: [],
      cursor: 'never-ending',
    });

    const [results] = await node.execute.call(ctx);

    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
  });

  it('domains walk the same way', async () => {
    const ctx = createContext({ resource: 'domain', operation: 'list', returnAll: true });
    let call = 0;
    ctx.helpers.httpRequestWithAuthentication.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { domains: [DOMAIN], cursor: 'c1' }
        : { domains: [{ ...DOMAIN, domain: 'blog.example.com' }], cursor: null };
    });

    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(2);
  });

  it('the item json carries no cursor — returnAll/limit IS the abstraction', async () => {
    // Handing a workflow a cursor it has no field to feed back would be a
    // second pagination interface, and a broken one.
    const ctx = createContext({ resource: 'deployment', operation: 'list', returnAll: true });
    pagedDeployments(ctx, [page(1)]);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).not.toHaveProperty('cursor');
  });
});

// =============================================================================
// listSearch pagination — the cursor IS n8n's paginationToken
// =============================================================================

describe('listSearch — pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  function searchCtx(response: any) {
    return {
      getCredentials: vi.fn().mockResolvedValue({ token: 'ship-test' }),
      helpers: { httpRequestWithAuthentication: vi.fn().mockResolvedValue(response) },
    } as any;
  }

  it('returns the cursor as paginationToken so the dropdown can scroll', async () => {
    const ctx = searchCtx({ deployments: [DEPLOYMENT], cursor: 'c1' });

    const result = await node.methods.listSearch.searchDeployments.call(ctx);

    expect(result.paginationToken).toBe('c1');
  });

  it('omits paginationToken on the last page', async () => {
    const ctx = searchCtx({ deployments: [DEPLOYMENT], cursor: null });

    const result = await node.methods.listSearch.searchDeployments.call(ctx);

    expect(result).not.toHaveProperty('paginationToken');
  });

  it('sends the token back as the cursor', async () => {
    const ctx = searchCtx({ domains: [DOMAIN], cursor: null });

    await node.methods.listSearch.searchDomains.call(ctx, undefined, 'c1');

    expect(ctx.helpers.httpRequestWithAuthentication.mock.calls[0][1].url).toBe(
      'https://api.shipstatic.com/domains?cursor=c1',
    );
  });
});

// =============================================================================
// Error handling — NodeApiError wrapping & continueOnFail (per-item ops)
// =============================================================================

describe('Error handling — NodeApiError & continueOnFail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wraps HTTP failures in NodeApiError to preserve status code in the n8n UI', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl('test.shipstatic.com', 'id'),
    });
    const httpError: any = new Error('Not found');
    httpError.httpCode = '404';
    ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(httpError);

    await expect(node.execute.call(ctx)).rejects.toMatchObject({
      name: 'NodeApiError',
      httpCode: '404',
    });
  });

  it('returns error item for per-item operations when continueOnFail is enabled', async () => {
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl('test.shipstatic.com', 'id'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(new Error('Not found'));
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({ error: 'Not found' });
    expect(results[0].pairedItem).toEqual({ item: 0 });
  });

  it('returns error item for global operations with pairedItem tracing all input items', async () => {
    // Global ops (list, account.get) take a different pairedItem path —
    // they use the precomputed `globalPairedItem` array, not `{ item: i }`.
    // On continueOnFail, the error item must trace back to all input items
    // since the failed call would have produced output for all of them.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'list',
      returnAll: true,
    });
    ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }, { json: {} }]);
    ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(new Error('Internal error'));
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results).toHaveLength(1);
    expect(results[0].json).toEqual({ error: 'Internal error' });
    expect(results[0].pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it("carries the wire's typed fields BESIDE the message", async () => {
    // The platform's law is "clients branch on error type and status, never on
    // message strings" — and a workflow engine is the caller most able to obey
    // it, since this json feeds an IF node. Flattening to `{ error: message }`
    // left it string-matching prose. `error` stays the message because that is
    // what n8n's UI renders; the structure rides alongside.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl(DEPLOYMENT.deployment, 'id'),
    });
    const httpError: any = new Error('Deployment not found');
    httpError.error = {
      error: 'not_found',
      message: 'Deployment not found',
      status: 404,
      details: { resource: 'deployment' },
    };
    ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(httpError);
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({
      error: 'Deployment not found',
      errorType: 'not_found',
      status: 404,
      details: { resource: 'deployment' },
    });
  });

  it('reads the wire body from either shape n8n surfaces it in', async () => {
    // The legacy `request` helper and `httpRequest*` put a non-2xx body in
    // different places; both are read, so the output does not depend on which
    // helper happened to throw.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl(DEPLOYMENT.deployment, 'id'),
    });
    const httpError: any = new Error('Rate limited');
    httpError.response = { body: { error: 'rate_limit', message: 'Rate limited', status: 429 } };
    ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(httpError);
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({
      error: 'Rate limited',
      errorType: 'rate_limit',
      status: 429,
    });
  });

  it('omits status and details when the wire body has none', async () => {
    // `ErrorResponse` marks both optional. Emitting `status: undefined` would
    // put a key in the json an IF node can test for and never trust.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl(DEPLOYMENT.deployment, 'id'),
    });
    const httpError: any = new Error('Something broke');
    httpError.error = { error: 'internal_server_error', message: 'Something broke' };
    ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(httpError);
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({
      error: 'Something broke',
      errorType: 'internal_server_error',
    });
  });

  it('a transport failure carries the message ALONE — no invented shape', async () => {
    // Nothing answered, so claiming an `errorType` would claim the platform
    // failed when it was never reached. Absence is the honest output.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl(DEPLOYMENT.deployment, 'id'),
    });
    ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(new Error('ECONNREFUSED'));
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({ error: 'ECONNREFUSED' });
  });

  it('the deploy path types its failures the same way', async () => {
    const ctx = createDeployContext();
    const httpError: any = new Error('File too large');
    httpError.error = { error: 'validation_failed', message: 'File too large', status: 413 };
    ctx.helpers.request.mockRejectedValue(httpError);
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toMatchObject({ errorType: 'validation_failed', status: 413 });
  });

  it('a non-Error throw still produces a readable error item', async () => {
    // Same reasoning as the deploy path: `apiRequest` wraps every HTTP
    // rejection, so the reachable non-Error source is parameter resolution.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl(DEPLOYMENT.deployment, 'id'),
    });
    ctx.getNodeParameter.mockImplementation((name: string) => {
      if (name === 'deployment') throw 'could not resolve';
      return { resource: 'deployment', operation: 'get' }[name];
    });
    ctx.continueOnFail.mockReturnValue(true);

    const [results] = await node.execute.call(ctx);

    expect(results[0].json).toEqual({ error: 'An unexpected error occurred' });
  });

  it('rethrows a non-node error untouched rather than stamping it', async () => {
    // Only n8n's own error classes carry a `context`. Parameter resolution
    // throws plain Errors, and writing `.context` onto one would be inventing a
    // field on someone else's object — so the guard exists, and this holds it.
    const ctx = createContext({
      resource: 'deployment',
      operation: 'get',
      deployment: rl(DEPLOYMENT.deployment, 'id'),
    });
    const raw = new Error('Parameter "deployment" could not be resolved');
    ctx.getNodeParameter.mockImplementation((name: string) => {
      if (name === 'deployment') throw raw;
      return { resource: 'deployment', operation: 'get' }[name];
    });

    await expect(node.execute.call(ctx)).rejects.toBe(raw);
    expect(raw).not.toHaveProperty('context');
  });
});

// =============================================================================
// listSearch — resource-locator search backends with credential probe
// =============================================================================

describe('listSearch — credential probe & filtering', () => {
  function createSearchCtx(opts: { hasCredentials: boolean; apiResponse?: any; apiError?: any }) {
    return {
      getCredentials: opts.hasCredentials
        ? vi.fn().mockResolvedValue({ token: 'ship-test' })
        : vi.fn().mockRejectedValue(new Error('No credentials configured')),
      helpers: {
        httpRequestWithAuthentication: opts.apiError
          ? vi.fn().mockRejectedValue(opts.apiError)
          : vi.fn().mockResolvedValue(opts.apiResponse ?? {}),
      },
    } as any;
  }

  // ─── searchDeployments ──────────────────────────────────────────────────

  it('searchDeployments returns empty results silently when no credentials', async () => {
    const ctx = createSearchCtx({ hasCredentials: false });
    const result = await node.methods.listSearch.searchDeployments.call(ctx);
    expect(result).toEqual({ results: [] });
    // Critical: no network request fires while creds are absent.
    expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
  });

  it('searchDeployments surfaces real API errors when credentials are configured', async () => {
    const apiError: any = new Error('Unauthorized');
    apiError.httpCode = '401';
    const ctx = createSearchCtx({ hasCredentials: true, apiError });

    await expect(node.methods.listSearch.searchDeployments.call(ctx)).rejects.toThrow(
      'Unauthorized',
    );
  });

  it('searchDeployments returns the full list when no filter is provided', async () => {
    const ctx = createSearchCtx({
      hasCredentials: true,
      apiResponse: { deployments: [{ deployment: 'a' }, { deployment: 'b' }] },
    });
    const result = await node.methods.listSearch.searchDeployments.call(ctx);
    expect(result).toEqual({
      results: [
        { name: 'a', value: 'a' },
        { name: 'b', value: 'b' },
      ],
    });
  });

  it('searchDeployments narrows results case-insensitively when a filter is given', async () => {
    const ctx = createSearchCtx({
      hasCredentials: true,
      apiResponse: {
        deployments: [
          { deployment: 'happy-cat-abc1234.shipstatic.com' },
          { deployment: 'fast-fox-def5678.shipstatic.com' },
        ],
      },
    });
    const result = await node.methods.listSearch.searchDeployments.call(ctx, 'CAT');
    expect(result).toEqual({
      results: [
        { name: 'happy-cat-abc1234.shipstatic.com', value: 'happy-cat-abc1234.shipstatic.com' },
      ],
    });
  });

  it('both backends yield an empty dropdown when the body has no array', async () => {
    // Out of contract, and the dropdown is the wrong place to raise it — an
    // empty list is the honest render. Without the `?? []` this is a TypeError
    // inside n8n's resource-locator UI.
    for (const backend of ['searchDeployments', 'searchDomains'] as const) {
      const ctx = createSearchCtx({ hasCredentials: true, apiResponse: {} });
      expect(await node.methods.listSearch[backend].call(ctx)).toEqual({ results: [] });
    }
  });

  // ─── searchDomains ──────────────────────────────────────────────────────

  it('searchDomains returns empty results silently when no credentials', async () => {
    const ctx = createSearchCtx({ hasCredentials: false });
    const result = await node.methods.listSearch.searchDomains.call(ctx);
    expect(result).toEqual({ results: [] });
    expect(ctx.helpers.httpRequestWithAuthentication).not.toHaveBeenCalled();
  });

  it('searchDomains surfaces real API errors when credentials are configured', async () => {
    const apiError: any = new Error('Internal Server Error');
    apiError.httpCode = '500';
    const ctx = createSearchCtx({ hasCredentials: true, apiError });

    await expect(node.methods.listSearch.searchDomains.call(ctx)).rejects.toThrow(
      'Internal Server Error',
    );
  });

  it('searchDomains returns the full list when no filter is provided', async () => {
    const ctx = createSearchCtx({
      hasCredentials: true,
      apiResponse: { domains: [{ domain: 'www.example.com' }] },
    });
    const result = await node.methods.listSearch.searchDomains.call(ctx);
    expect(result).toEqual({
      results: [{ name: 'www.example.com', value: 'www.example.com' }],
    });
  });

  it('searchDomains narrows results case-insensitively when a filter is given', async () => {
    const ctx = createSearchCtx({
      hasCredentials: true,
      apiResponse: {
        domains: [{ domain: 'www.example.com' }, { domain: 'www.shipstatic.com' }],
      },
    });
    const result = await node.methods.listSearch.searchDomains.call(ctx, 'EXAMPLE');
    expect(result).toEqual({
      results: [{ name: 'www.example.com', value: 'www.example.com' }],
    });
  });
});
