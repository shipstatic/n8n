import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import {
	extractResourceLocatorValue,
	parseLabels,
	Shipstatic,
	stripCommonPrefix,
} from '../nodes/Shipstatic/Shipstatic.node';

// =============================================================================
// Test scaffolding
// =============================================================================
//
// Tests are organized by implementation surface, top-down:
//
//   parseLabels                        pure helper
//   Deploy — authentication            credential resolution + agent-token fallback
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
			(
				name: string,
				_idx?: number,
				fallback?: unknown,
				options?: { extractValue?: boolean },
			) => {
				const value = params[name];
				if (
					options?.extractValue &&
					value &&
					typeof value === 'object' &&
					'value' in value
				) {
					return (value as { value: unknown }).value;
				}
				return value ?? fallback;
			},
		),
		getCredentials:
			credentials === null
				? vi.fn().mockRejectedValue(new Error('No credentials'))
				: vi.fn().mockResolvedValue(credentials ?? { apiKey: 'ship-test' }),
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
			binaryData: true,
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

	it('with API key → permanent deployment under your account', async () => {
		const ctx = createDeployContext();

		await node.execute.call(ctx);

		const call = findDeployCall(ctx);
		expect(call).toBeDefined();
		expect(call[0].headers.Authorization).toBe('Bearer ship-test');
	});

	it('without API key → public deployment via agent token (expires in 3 days)', async () => {
		const ctx = createDeployContext({}, null);
		ctx.helpers.request
			.mockResolvedValueOnce({ secret: 'agent-token-123' })
			.mockResolvedValueOnce({ deployment: 'test.shipstatic.com' });

		await node.execute.call(ctx);

		const agentCall = ctx.helpers.request.mock.calls[0];
		expect(agentCall[0].uri).toContain('/tokens/agent');
		expect(agentCall[0].method).toBe('POST');

		const deployCall = findDeployCall(ctx);
		expect(deployCall[0].headers.Authorization).toBe('Bearer agent-token-123');
	});

	it('with API key, /tokens/agent is NOT called', async () => {
		// Guards against a regression where the agent-token bootstrap would fire
		// even when an explicit API key is configured — wasted call + rate cost.
		const ctx = createDeployContext();

		await node.execute.call(ctx);

		const agentTokenCall = ctx.helpers.request.mock.calls.find(
			(c: any[]) => c[0].uri?.includes('/tokens/agent'),
		);
		expect(agentTokenCall).toBeUndefined();
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

	it('text mode deploys fileContent with specified fileName', async () => {
		const ctx = createDeployContext({
			binaryData: false,
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
// Deploy — error handling (handleDeploy failure paths)
// =============================================================================

describe('Deploy — error handling', () => {
	beforeEach(() => vi.clearAllMocks());

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

	it('wraps /tokens/agent failures in NodeApiError', async () => {
		// Anonymous deploy bootstrap — when /tokens/agent fails for any reason,
		// the error must surface as NodeApiError (not the raw transport error).
		const ctx = createDeployContext({}, null);
		const httpError: any = new Error('Service Unavailable');
		httpError.httpCode = '503';
		ctx.helpers.request.mockRejectedValue(httpError);

		await expect(node.execute.call(ctx)).rejects.toMatchObject({
			name: 'NodeApiError',
			httpCode: '503',
		});
	});

	it('rate-limited /tokens/agent surfaces an actionable "add an API key" message', async () => {
		// /tokens/agent is rate-limited (5/hr per IP). We surface a specific
		// hint so users don't retry blindly — mirrors the SDK's UX.
		const ctx = createDeployContext({}, null);
		const httpError: any = new Error('Too Many Requests');
		httpError.httpCode = '429';
		ctx.helpers.request.mockRejectedValue(httpError);

		await expect(node.execute.call(ctx)).rejects.toMatchObject({
			name: 'NodeApiError',
			message: expect.stringContaining('Public deploy rate limit exceeded'),
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

	it('remove calls DELETE /deployments/:id and returns success:true', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'remove',
			deployment: rl('test.shipstatic.com', 'id'),
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(undefined);

		const [results] = await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('DELETE');
		expect(call[1].url).toBe('https://api.shipstatic.com/deployments/test.shipstatic.com');
		expect(results[0].json).toEqual({ success: true });
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
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
			domain: 'www.example.com',
			provider: 'cloudflare',
		});

		const [results] = await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('GET');
		expect(call[1].url).toBe('https://api.shipstatic.com/domains/www.example.com/dns');
		expect(results[0].json).toEqual({ domain: 'www.example.com', provider: 'cloudflare' });
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
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
			domain: 'www.example.com',
			records: [],
		});

		await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('GET');
		expect(call[1].url).toBe('https://api.shipstatic.com/domains/www.example.com/records');
	});

	it('remove calls DELETE /domains/:name and returns success:true', async () => {
		const ctx = createContext({
			resource: 'domain',
			operation: 'remove',
			domain: rl('www.example.com', 'name'),
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(undefined);

		const [results] = await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('DELETE');
		expect(call[1].url).toBe('https://api.shipstatic.com/domains/www.example.com');
		expect(results[0].json).toEqual({ success: true });
	});

	it('share calls GET /domains/:name/share', async () => {
		const ctx = createContext({
			resource: 'domain',
			operation: 'share',
			domain: rl('www.example.com', 'name'),
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
			domain: 'www.example.com',
			hash: 'abc123',
		});

		const [results] = await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('GET');
		expect(call[1].url).toBe('https://api.shipstatic.com/domains/www.example.com/share');
		expect(results[0].json).toEqual({ domain: 'www.example.com', hash: 'abc123' });
	});

	it('validate calls POST /domains/validate with body', async () => {
		const ctx = createContext({
			resource: 'domain',
			operation: 'validate',
			domain: rl('www.example.com', 'name'),
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ valid: true });

		await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('POST');
		expect(call[1].url).toBe('https://api.shipstatic.com/domains/validate');
		expect(call[1].body).toEqual({ domain: 'www.example.com' });
	});

	it('verify calls POST /domains/:name/verify', async () => {
		const ctx = createContext({
			resource: 'domain',
			operation: 'verify',
			domain: rl('www.example.com', 'name'),
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ status: 'pending' });

		await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('POST');
		expect(call[1].url).toBe('https://api.shipstatic.com/domains/www.example.com/verify');
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
			'This operation requires a ShipStatic API key',
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
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
			email: 'me@example.com',
			plan: 'free',
		});

		const [results] = await node.execute.call(ctx);

		expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('GET');
		expect(call[1].url).toBe('https://api.shipstatic.com/account');
		expect(results).toHaveLength(1);
		expect(results[0].json).toEqual({ email: 'me@example.com', plan: 'free' });
		expect(results[0].pairedItem).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
			{ item: 3 },
		]);
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
});

// =============================================================================
// listSearch — resource-locator search backends with credential probe
// =============================================================================

describe('listSearch — credential probe & filtering', () => {
	function createSearchCtx(opts: {
		hasCredentials: boolean;
		apiResponse?: any;
		apiError?: any;
	}) {
		return {
			getCredentials: opts.hasCredentials
				? vi.fn().mockResolvedValue({ apiKey: 'ship-test' })
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
			results: [{ name: 'happy-cat-abc1234.shipstatic.com', value: 'happy-cat-abc1234.shipstatic.com' }],
		});
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
