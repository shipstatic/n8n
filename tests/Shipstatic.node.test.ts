import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseLabels, Shipstatic } from '../nodes/Shipstatic/Shipstatic.node';

// Mock n8n-workflow (peer dependency)
vi.mock('n8n-workflow', () => ({
	NodeConnectionTypes: { Main: 'main' },
	NodeOperationError: class extends Error {
		constructor(_node: any, error: Error | string, _opts?: any) {
			super(typeof error === 'string' ? error : error.message);
			this.name = 'NodeOperationError';
		}
	},
}));

// Mock Ship SDK
vi.mock('@shipstatic/ship', () => ({
	default: vi.fn().mockImplementation(function () { return {
		deployments: {
			upload: vi.fn().mockResolvedValue({ deployment: 'happy-cat-abc1234.shipstatic.com' }),
			list: vi.fn().mockResolvedValue({ deployments: [{ deployment: 'a' }, { deployment: 'b' }, { deployment: 'c' }] }),
			get: vi.fn().mockResolvedValue({ deployment: 'a' }),
			set: vi.fn().mockResolvedValue({ deployment: 'a' }),
			remove: vi.fn().mockResolvedValue(undefined),
		},
		domains: {
			set: vi.fn().mockResolvedValue({ domain: 'www.example.com' }),
			list: vi.fn().mockResolvedValue({ domains: [{ domain: 'a.com' }, { domain: 'b.com' }] }),
			get: vi.fn().mockResolvedValue({ domain: 'www.example.com' }),
			records: vi.fn().mockResolvedValue({ records: [] }),
			validate: vi.fn().mockResolvedValue({ valid: true }),
			verify: vi.fn().mockResolvedValue({ verified: true }),
			remove: vi.fn().mockResolvedValue(undefined),
		},
		whoami: vi.fn().mockResolvedValue({ email: 'test@example.com', plan: 'free' }),
	}; }),
}));

vi.mock('fs/promises', () => ({
	mkdtemp: vi.fn().mockResolvedValue('/tmp/n8n-shipstatic-test'),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}));

import Ship from '@shipstatic/ship';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
const MockShip = vi.mocked(Ship);

function createContext(params: Record<string, any>, credentials?: Record<string, any> | null) {
	return {
		getNodeParameter: vi.fn((name: string) => params[name]),
		getCredentials: credentials === null
			? vi.fn().mockRejectedValue(new Error('No credentials'))
			: vi.fn().mockResolvedValue(credentials ?? { apiKey: 'ship-test' }),
		getInputData: vi.fn(() => [{ json: {} }]),
		getNode: vi.fn(() => ({ name: 'ShipStatic' })),
		continueOnFail: vi.fn(() => false),
		helpers: {
			assertBinaryData: vi.fn().mockReturnValue({ fileName: 'index.html' }),
			getBinaryDataBuffer: vi.fn().mockResolvedValue(Buffer.from('<html></html>')),
		},
	} as any;
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

describe('credential resolution', () => {
	beforeEach(() => vi.clearAllMocks());

	it('creates Ship with API key when credentials are set', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'upload', binaryPropertyName: 'data', options: {} });

		await node.execute.call(ctx);

		expect(MockShip).toHaveBeenCalledWith({ apiKey: 'ship-test' });
	});

	it('creates Ship without API key for upload when no credentials', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'upload', binaryPropertyName: 'data', options: {} }, null);

		await node.execute.call(ctx);

		expect(MockShip).toHaveBeenCalledWith({});
	});

	it('throws for non-upload operations when no credentials', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'getMany' }, null);

		await expect(node.execute.call(ctx)).rejects.toThrow('This operation requires a ShipStatic API key');
	});
});

describe('upload', () => {
	beforeEach(() => vi.clearAllMocks());

	it('passes via: n8n and parsed labels to SDK', async () => {
		const mockUpload = vi.fn().mockResolvedValue({ deployment: 'test.shipstatic.com' });
		MockShip.mockImplementationOnce(function () { return { deployments: { upload: mockUpload } } as any; });

		const ctx = createContext({
			resource: 'deployment', operation: 'upload',
			binaryPropertyName: 'data',
			options: { labels: 'prod, v2' },
		});

		await node.execute.call(ctx);

		expect(mockUpload).toHaveBeenCalledWith('/tmp/n8n-shipstatic-test', {
			labels: ['prod', 'v2'],
			via: 'n8n',
		});
	});

	it('collects multiple items into one deployment', async () => {
		const mockUpload = vi.fn().mockResolvedValue({ deployment: 'test.shipstatic.com' });
		MockShip.mockImplementationOnce(function () { return { deployments: { upload: mockUpload } } as any; });

		const ctx = createContext({
			resource: 'deployment', operation: 'upload',
			binaryPropertyName: 'data', options: {},
		});
		ctx.getInputData.mockReturnValue([{ json: {} }, { json: {} }]);
		ctx.helpers.assertBinaryData
			.mockReturnValueOnce({ fileName: 'index.html' })
			.mockReturnValueOnce({ fileName: 'style.css', directory: 'css' });
		ctx.helpers.getBinaryDataBuffer
			.mockResolvedValueOnce(Buffer.from('<html></html>'))
			.mockResolvedValueOnce(Buffer.from('body{}'));

		const [results] = await node.execute.call(ctx);

		expect(writeFile).toHaveBeenCalledTimes(2);
		expect(rm).toHaveBeenCalledWith('/tmp/n8n-shipstatic-test', { recursive: true, force: true });
		expect(results).toHaveLength(1);
	});

	it('preserves directory structure from binary metadata', async () => {
		MockShip.mockImplementationOnce(function () { return { deployments: { upload: vi.fn().mockResolvedValue({ deployment: 'x' }) } } as any; });

		const ctx = createContext({
			resource: 'deployment', operation: 'upload',
			binaryPropertyName: 'data', options: {},
		});
		// n8n sets directory to an absolute path — leading slash is stripped for path.join safety
		ctx.helpers.assertBinaryData.mockReturnValue({ fileName: 'app.js', directory: '/home/node/.n8n-files/dist/assets/js' });
		ctx.helpers.getBinaryDataBuffer.mockResolvedValue(Buffer.from('console.log()'));

		await node.execute.call(ctx);

		expect(writeFile).toHaveBeenCalledWith(
			'/tmp/n8n-shipstatic-test/home/node/.n8n-files/dist/assets/js/app.js',
			Buffer.from('console.log()'),
		);
		expect(mkdir).toHaveBeenCalledWith('/tmp/n8n-shipstatic-test/home/node/.n8n-files/dist/assets/js', { recursive: true });
	});

	it('cleans up temp directory on SDK error', async () => {
		MockShip.mockImplementationOnce(function () { return { deployments: { upload: vi.fn().mockRejectedValue(new Error('Upload failed')) } } as any; });

		const ctx = createContext({
			resource: 'deployment', operation: 'upload',
			binaryPropertyName: 'data', options: {},
		});

		await expect(node.execute.call(ctx)).rejects.toThrow('Upload failed');

		expect(rm).toHaveBeenCalledWith('/tmp/n8n-shipstatic-test', { recursive: true, force: true });
	});

	it('returns error item when continueOnFail is enabled', async () => {
		MockShip.mockImplementationOnce(function () { return { deployments: { upload: vi.fn().mockRejectedValue(new Error('Upload failed')) } } as any; });

		const ctx = createContext({
			resource: 'deployment', operation: 'upload',
			binaryPropertyName: 'data', options: {},
		});
		ctx.continueOnFail.mockReturnValue(true);

		const [results] = await node.execute.call(ctx);

		expect(results[0].json).toEqual({ error: 'Upload failed' });
		expect(rm).toHaveBeenCalled();
	});
});

describe('list operations', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns all items when returnAll is true', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'getMany', returnAll: true });

		const [results] = await node.execute.call(ctx);

		expect(results).toHaveLength(3);
	});

	it('slices to limit when returnAll is false', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'getMany', returnAll: false, limit: 2 });

		const [results] = await node.execute.call(ctx);

		expect(results).toHaveLength(2);
	});
});

describe('deployment update', () => {
	beforeEach(() => vi.clearAllMocks());

	it('clears labels when input is empty', async () => {
		const mockSet = vi.fn().mockResolvedValue({ deployment: 'a' });
		MockShip.mockImplementationOnce(function () { return { deployments: { set: mockSet } } as any; });

		const ctx = createContext({
			resource: 'deployment', operation: 'update',
			deploymentId: 'test.shipstatic.com',
			labels: '',
		});

		await node.execute.call(ctx);

		expect(mockSet).toHaveBeenCalledWith('test.shipstatic.com', { labels: [] });
	});
});

describe('void operations', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns { success: true } for delete', async () => {
		const ctx = createContext({ resource: 'deployment', operation: 'delete', deploymentId: 'test.shipstatic.com' });

		const [result] = await node.execute.call(ctx);

		expect(result[0].json).toEqual({ success: true });
	});
});

describe('error handling', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns error item for per-item operations when continueOnFail is enabled', async () => {
		MockShip.mockImplementationOnce(function () { return { deployments: { get: vi.fn().mockRejectedValue(new Error('Not found')) } } as any; });

		const ctx = createContext({
			resource: 'deployment', operation: 'get',
			deploymentId: 'test.shipstatic.com',
		});
		ctx.continueOnFail.mockReturnValue(true);

		const [results] = await node.execute.call(ctx);

		expect(results[0].json).toEqual({ error: 'Not found' });
	});
});

describe('domain set', () => {
	beforeEach(() => vi.clearAllMocks());

	it('converts empty deployment string to undefined', async () => {
		const mockSet = vi.fn().mockResolvedValue({ domain: 'www.example.com' });
		MockShip.mockImplementationOnce(function () { return { domains: { set: mockSet } } as any; });

		const ctx = createContext({
			resource: 'domain', operation: 'set',
			domainName: 'www.example.com',
			options: { deployment: '', labels: '' },
		});

		await node.execute.call(ctx);

		expect(mockSet).toHaveBeenCalledWith('www.example.com', {
			deployment: undefined,
			labels: undefined,
		});
	});
});
