import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseLabels, Shipstatic } from '../nodes/Shipstatic/Shipstatic.node';

vi.mock('n8n-workflow', () => ({
	NodeConnectionTypes: { Main: 'main' },
	NodeOperationError: class extends Error {
		constructor(_node: any, error: Error | string, _opts?: any) {
			super(typeof error === 'string' ? error : error.message);
			this.name = 'NodeOperationError';
		}
	},
}));

function createContext(params: Record<string, any>, credentials?: Record<string, any> | null) {
	return {
		getNodeParameter: vi.fn((name: string) => params[name]),
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
		},
	} as any;
}

/** Parse the multipart Buffer body from an httpRequest call to inspect fields and files. */
function parseMultipart(call: any): { body: string; contentType: string } {
	return { body: call[0].body.toString('utf-8'), contentType: call[0].headers['Content-Type'] };
}

function findDeployCall(ctx: any): any {
	return ctx.helpers.httpRequest.mock.calls.find(
		(c: any[]) => c[0].url?.endsWith('/deployments') && c[0].method === 'POST',
	);
}

const node = new Shipstatic();

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
});

describe('authentication — deploy works with or without credentials', () => {
	beforeEach(() => vi.clearAllMocks());

	it('with API key → permanent deployment under your account', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});

		await node.execute.call(ctx);

		const call = findDeployCall(ctx);
		expect(call).toBeDefined();
		expect(call[0].headers.Authorization).toBe('Bearer ship-test');
	});

	it('without API key → public deployment via agent token (expires in 3 days)', async () => {
		const ctx = createContext(
			{
				resource: 'deployment',
				operation: 'deploy',
				binaryData: true,
				binaryPropertyName: 'data',
				options: {},
			},
			null,
		);
		ctx.helpers.httpRequest
			.mockResolvedValueOnce({ secret: 'agent-token-123' })
			.mockResolvedValueOnce({ deployment: 'test.shipstatic.com' });

		await node.execute.call(ctx);

		const agentCall = ctx.helpers.httpRequest.mock.calls[0];
		expect(agentCall[0].url).toContain('/tokens/agent');
		expect(agentCall[0].method).toBe('POST');

		const deployCall = ctx.helpers.httpRequest.mock.calls[1];
		expect(deployCall[0].headers.Authorization).toBe('Bearer agent-token-123');
	});

	it('non-deploy operations always require an API key', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'list' }, null);

		await expect(node.execute.call(ctx)).rejects.toThrow(
			'This operation requires a ShipStatic API key',
		);
	});
});

describe('deploy', () => {
	beforeEach(() => vi.clearAllMocks());

	it('sends via, spa, and parsed labels in multipart body', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: { labels: 'prod, v2' },
		});

		await node.execute.call(ctx);

		const { body, contentType } = parseMultipart(findDeployCall(ctx));
		expect(contentType).toContain('multipart/form-data; boundary=');
		expect(body).toContain('name="via"\r\n\r\nn8n');
		expect(body).toContain('name="spa"\r\n\r\ntrue');
		expect(body).toContain('name="labels"\r\n\r\n["prod","v2"]');
	});

	it('collects multiple items into one deployment', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});
		ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
		ctx.helpers.assertBinaryData
			.mockReturnValueOnce({ fileName: 'index.html' })
			.mockReturnValueOnce({ fileName: 'style.css', directory: 'css' });
		ctx.helpers.getBinaryDataBuffer
			.mockResolvedValueOnce(Buffer.from('<html></html>'))
			.mockResolvedValueOnce(Buffer.from('body{}'));

		const [results] = await node.execute.call(ctx);

		expect(results).toHaveLength(1);
		const { body } = parseMultipart(findDeployCall(ctx));
		expect(body).toContain('filename="index.html"');
		expect(body).toContain('filename="css/style.css"');
	});

	it('strips common directory prefix from paths', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});
		ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
		ctx.helpers.assertBinaryData
			.mockReturnValueOnce({ fileName: 'index.html', directory: 'dist' })
			.mockReturnValueOnce({ fileName: 'app.js', directory: 'dist/assets' });
		ctx.helpers.getBinaryDataBuffer
			.mockResolvedValueOnce(Buffer.from('<html></html>'))
			.mockResolvedValueOnce(Buffer.from('console.log()'));

		await node.execute.call(ctx);

		const { body } = parseMultipart(findDeployCall(ctx));
		expect(body).toContain('filename="index.html"');
		expect(body).toContain('filename="assets/app.js"');
		expect(body).not.toContain('filename="dist/');
	});

	it('skips empty files', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});
		ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
		ctx.helpers.assertBinaryData
			.mockReturnValueOnce({ fileName: 'empty.txt' })
			.mockReturnValueOnce({ fileName: 'real.html' });
		ctx.helpers.getBinaryDataBuffer
			.mockResolvedValueOnce(Buffer.alloc(0))
			.mockResolvedValueOnce(Buffer.from('<html></html>'));

		await node.execute.call(ctx);

		const { body } = parseMultipart(findDeployCall(ctx));
		expect(body).toContain('filename="real.html"');
		expect(body).not.toContain('filename="empty.txt"');
	});

	it('sends correct MD5 checksums for each file', async () => {
		const { createHash } = await import('node:crypto');
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});
		const content = Buffer.from('<html></html>');
		const expectedMd5 = createHash('md5').update(content).digest('hex');

		await node.execute.call(ctx);

		const { body } = parseMultipart(findDeployCall(ctx));
		expect(body).toContain(`["${expectedMd5}"]`);
	});

	it('single file deploy preserves path without stripping', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});
		ctx.helpers.assertBinaryData.mockReturnValue({
			fileName: 'index.html',
			directory: 'dist',
		});

		await node.execute.call(ctx);

		const { body } = parseMultipart(findDeployCall(ctx));
		expect(body).toContain('filename="dist/index.html"');
	});

	it('throws when all files are empty', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});
		ctx.helpers.getBinaryDataBuffer.mockResolvedValue(Buffer.alloc(0));

		await expect(node.execute.call(ctx)).rejects.toThrow('No files to deploy');
	});

	it('returns error item when continueOnFail is enabled', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: true,
			binaryPropertyName: 'data',
			options: {},
		});
		ctx.helpers.httpRequest.mockRejectedValue(new Error('Upload failed'));
		ctx.continueOnFail.mockReturnValue(true);

		const [results] = await node.execute.call(ctx);

		expect(results[0].json).toEqual({ error: 'Upload failed' });
	});

	it('text mode deploys fileContent with specified fileName', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'deploy',
			binaryData: false,
			fileContent: '<html><body>Hello</body></html>',
			fileName: 'index.html',
			options: {},
		});

		await node.execute.call(ctx);

		const { body } = parseMultipart(findDeployCall(ctx));
		expect(body).toContain('filename="index.html"');
		expect(body).toContain('<html><body>Hello</body></html>');
		expect(body).toContain('name="via"\r\n\r\nn8n');
	});
});

describe('list operations', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns all items when returnAll is true', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'list', returnAll: true });
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({
			deployments: [{ deployment: 'a' }, { deployment: 'b' }, { deployment: 'c' }],
		});

		const [results] = await node.execute.call(ctx);

		expect(results).toHaveLength(3);
	});

	it('slices to limit when returnAll is false', async () => {
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

describe('deployment set', () => {
	beforeEach(() => vi.clearAllMocks());

	it('clears labels when input is empty', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'set',
			deploymentId: 'test.shipstatic.com',
			labels: '',
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ deployment: 'a' });

		await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('PATCH');
		expect(call[1].body).toEqual({ labels: [] });
	});
});

describe('void operations', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns { success: true } for remove', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'remove',
			deploymentId: 'test.shipstatic.com',
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue(undefined);

		const [result] = await node.execute.call(ctx);

		expect(result[0].json).toEqual({ success: true });
	});
});

describe('error handling', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns error item for per-item operations when continueOnFail is enabled', async () => {
		const ctx = createContext({
			resource: 'deployment',
			operation: 'get',
			deploymentId: 'test.shipstatic.com',
		});
		ctx.helpers.httpRequestWithAuthentication.mockRejectedValue(new Error('Not found'));
		ctx.continueOnFail.mockReturnValue(true);

		const [results] = await node.execute.call(ctx);

		expect(results[0].json).toEqual({ error: 'Not found' });
	});
});

describe('domain set', () => {
	beforeEach(() => vi.clearAllMocks());

	it('converts empty deployment string to undefined', async () => {
		const ctx = createContext({
			resource: 'domain',
			operation: 'set',
			domainName: 'www.example.com',
			options: { deployment: '', labels: '' },
		});
		ctx.helpers.httpRequestWithAuthentication.mockResolvedValue({ domain: 'www.example.com' });

		await node.execute.call(ctx);

		const call = ctx.helpers.httpRequestWithAuthentication.mock.calls[0];
		expect(call[1].method).toBe('PUT');
		expect(call[1].body).toEqual({ deployment: undefined, labels: undefined });
	});
});
