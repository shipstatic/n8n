import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { createHash } from 'node:crypto';

const API = 'https://api.shipstatic.com';

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
// HTTP layer — three helpers, each with one job
//
//   apiRequest         JSON + n8n credential-aware auth (every CRUD op)
//   fetchAgentToken    POST /tokens/agent — bootstrap for unauthenticated deploys
//   uploadDeployment   POST /deployments multipart with a manual Bearer header
//
// All three wrap transport errors in NodeApiError at the I/O boundary so the
// rest of the node can stay trivial — the dominant idiom in n8n core nodes
// (GitHub, Notion, Slack).
// =============================================================================

async function apiRequest(
	ctx: IExecuteFunctions,
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	path: string,
	body?: object,
): Promise<IDataObject> {
	try {
		return await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'shipstaticApi', {
			method,
			url: `${API}${path}`,
			body,
			json: true,
		});
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as JsonObject);
	}
}

// Anonymous deploys go to the platform's public account via a short-lived,
// IP-locked token. The API mints a fresh one per call; we never store it.
// This endpoint is intentionally unauthenticated — it's the bootstrap for
// users who haven't (and may never) configured credentials.
async function fetchAgentToken(ctx: IExecuteFunctions): Promise<string> {
	try {
		const response = await ctx.helpers.request({
			method: 'POST',
			uri: `${API}/tokens/agent`,
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
			json: true,
		});
		return response.secret as string;
	} catch (error) {
		// /tokens/agent is rate-limited (5/hr per IP). When that's the cause,
		// the actionable fix is "use an API key" — surface that explicitly so
		// users don't retry blindly. Mirrors the SDK's UX.
		const httpCode = (error as { httpCode?: string; statusCode?: number }).httpCode
			?? (error as { statusCode?: number }).statusCode;
		if (httpCode === '429' || httpCode === 429) {
			throw new NodeApiError(ctx.getNode(), error as JsonObject, {
				message: 'Public deploy rate limit exceeded',
				description:
					'Add a ShipStatic API key (free at https://my.shipstatic.com/api-key) for higher limits, or wait and retry later.',
			});
		}
		throw new NodeApiError(ctx.getNode(), error as JsonObject);
	}
}

// n8n's modern httpRequest helper does not reliably handle multipart FormData
// (proven across v0.5–0.6 of this node); the legacy `request` helper is the
// only path that produces a working multipart upload — the same fallback
// Slack, S3, and Google Drive use for file uploads. Auth is manual because
// the same upload may be Bearer'd with either an API key or an agent token.
async function uploadDeployment(
	ctx: IExecuteFunctions,
	authorization: string,
	formData: IDataObject,
): Promise<IDataObject> {
	try {
		return await ctx.helpers.request({
			method: 'POST',
			uri: `${API}/deployments`,
			headers: { Authorization: authorization },
			formData,
			json: true,
		});
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as JsonObject);
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

// =============================================================================
// Deploy — the only operation with optional credentials and multipart upload
// =============================================================================

async function handleDeploy(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	apiKey: string | undefined,
): Promise<INodeExecutionData[]> {
	const isBinaryData = ctx.getNodeParameter('binaryData', 0) as boolean;
	const options = ctx.getNodeParameter('options', 0) as IDataObject;

	// 1. Collect files — from binary data or text content
	const files: { path: string; content: Buffer; md5: string }[] = [];

	if (isBinaryData) {
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
	} else {
		const fileContent = ctx.getNodeParameter('fileContent', 0) as string;
		const fileName = ctx.getNodeParameter('fileName', 0) as string;
		const content = Buffer.from(fileContent, 'utf-8');
		files.push({ path: fileName || 'index.html', content, md5: md5(content) });
	}

	if (files.length === 0) {
		throw new NodeOperationError(
			ctx.getNode(),
			'No files to deploy — all input items were empty',
			{
				description:
					'Connect a node that produces binary data (e.g. Read Binary Files, HTTP Request, Convert to File), or toggle Binary File off and provide File Content.',
			},
		);
	}

	// 2. Optimize paths — strip common directory prefix
	const stripped = stripCommonPrefix(files.map((f) => f.path));
	files.forEach((f, idx) => (f.path = stripped[idx]));

	// 3. Build formData
	const formData: IDataObject = {
		'files[]': files.map((f) => ({
			value: f.content,
			options: { filename: f.path, contentType: 'application/octet-stream' },
		})),
		checksums: JSON.stringify(files.map((f) => f.md5)),
		via: 'n8n',
	};
	const labels = parseLabels(options.labels as string);
	if (labels) formData.labels = JSON.stringify(labels);
	const password = (options.password as string)?.trim();
	if (password) formData.password = password;

	// 4. Authenticate — explicit API key, or a short-lived agent token for public deploys
	const token = apiKey ?? (await fetchAgentToken(ctx));

	// 5. Upload
	const result = await uploadDeployment(ctx, `Bearer ${token}`, formData);

	return [
		{
			json: toJson(result),
			pairedItem: items.map((_, i) => ({ item: i })),
		},
	];
}

export class Shipstatic implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ShipStatic',
		name: 'shipstatic',
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
		// Deploy works without credentials (public deploy, 3-day expiry).
		// All other operations require a free API key.
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
						name: 'Deploy',
						value: 'deploy',
						description:
							'Publish files and get a live URL. Without an API key, the response includes a claim URL — show both to the user. To make the site private, set Password under Options.',
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
						name: 'Remove',
						value: 'remove',
						description:
							'Permanently remove a deployment and all its files. Confirm with the user before calling this — it cannot be undone.',
						action: 'Remove a deployment',
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
						description:
							'List all domains with their linked deployment and verification status',
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
						name: 'Remove',
						value: 'remove',
						description:
							'Permanently disconnect and remove a custom domain. Confirm with the user before calling this — it cannot be undone.',
						action: 'Remove a domain',
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

			// Deploy — binary file toggle (default) or text content fallback
			{
				displayName: 'Binary File',
				name: 'binaryData',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['deployment'], operation: ['deploy'] } },
				description: 'Whether the data to deploy should be taken from binary field',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: { resource: ['deployment'], operation: ['deploy'], binaryData: [true] },
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
					show: { resource: ['deployment'], operation: ['deploy'], binaryData: [false] },
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
					show: { resource: ['deployment'], operation: ['deploy'], binaryData: [false] },
				},
				description: 'The path to deploy the content as (defaults to "index.html")',
			},

			// Deployment — used by get, set, remove. Resource locator gives the user
			// search-as-you-type from the list and free-text fallback by hostname.
			{
				displayName: 'Deployment',
				name: 'deployment',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: { resource: ['deployment'], operation: ['get', 'set', 'remove'] },
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
			// (get, records, verify, remove, dns, share) and for re-pointing
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
			// Resource locator search backends. Probe credentials first — silent
			// empty dropdown is the right UX while the user is still wiring the
			// node up. Once credentials exist, any failure (invalid key, API down)
			// is real and must surface in the UI. Filtering is client-side: the
			// API returns the full list and we narrow on the user's typed query.
			async searchDeployments(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				if (!(await hasCredentials(this))) return { results: [] };
				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'shipstaticApi',
					{ method: 'GET', url: `${API}/deployments`, json: true },
				);
				const all = (response.deployments ?? []) as { deployment: string }[];
				const matches = filter
					? all.filter((d) => d.deployment.toLowerCase().includes(filter.toLowerCase()))
					: all;
				return {
					results: matches.map((d) => ({ name: d.deployment, value: d.deployment })),
				};
			},
			async searchDomains(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				if (!(await hasCredentials(this))) return { results: [] };
				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'shipstaticApi',
					{ method: 'GET', url: `${API}/domains`, json: true },
				);
				const all = (response.domains ?? []) as { domain: string }[];
				const matches = filter
					? all.filter((d) => d.domain.toLowerCase().includes(filter.toLowerCase()))
					: all;
				return {
					results: matches.map((d) => ({ name: d.domain, value: d.domain })),
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Deploy has two modes:
		// • With an API key — permanent deployment under your account
		// • Without an API key — public deployment, expires in 3 days (no sign-up needed)
		if (resource === 'deployment' && operation === 'deploy') {
			let apiKey: string | undefined;
			try {
				const credentials = await this.getCredentials('shipstaticApi');
				apiKey = credentials.apiKey as string;
			} catch {
				// No credentials — deploy will use a temporary agent token instead
			}

			try {
				const results = await handleDeploy(this, items, apiKey);
				returnData.push(...results);
			} catch (error) {
				if (this.continueOnFail()) {
					// Deploy consumes every input item into one upload, so the error
					// must trace back to all of them — same pairedItem shape as the
					// success path inside handleDeploy.
					const message = error instanceof Error ? error.message : 'An unexpected error occurred';
					returnData.push({
						json: { error: message },
						pairedItem: items.map((_, idx) => ({ item: idx })),
					});
				} else {
					throw error;
				}
			}
			return [returnData];
		}

		// All other operations require credentials
		try {
			await this.getCredentials('shipstaticApi');
		} catch {
			throw new NodeOperationError(
				this.getNode(),
				'This operation requires a ShipStatic API key.',
				{
					description:
						'Open Credentials → New → ShipStatic API and paste your key. Get a free key at https://my.shipstatic.com/api-key.',
				},
			);
		}

		// Global ops (list, account.get) don't depend on per-item parameters —
		// run once and pair the output to all input items so n8n's data-trace stays
		// honest. Per-item ops (get, set, remove, etc.) loop over input items as usual.
		const isGlobalOp =
			operation === 'list' || (resource === 'account' && operation === 'get');
		const iterations = isGlobalOp ? 1 : items.length;
		const globalPairedItem = items.map((_, idx) => ({ item: idx }));

		for (let i = 0; i < iterations; i++) {
			const pairedItem = isGlobalOp ? globalPairedItem : { item: i };
			try {
				if (resource === 'deployment') {
					if (operation === 'list') {
						const returnAll = this.getNodeParameter('returnAll', 0) as boolean;
						const response = await apiRequest(this, 'GET', '/deployments');
						let results = (response.deployments ?? []) as IDataObject[];
						if (!returnAll) {
							const limit = this.getNodeParameter('limit', 0) as number;
							results = results.slice(0, limit);
						}
						for (const deployment of results) {
							returnData.push({ json: toJson(deployment), pairedItem });
						}
					} else if (operation === 'get') {
						const id = this.getNodeParameter('deployment', i, '', {
							extractValue: true,
						}) as string;
						const result = await apiRequest(this, 'GET', `/deployments/${encodeURIComponent(id)}`);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'set') {
						const id = this.getNodeParameter('deployment', i, '', {
							extractValue: true,
						}) as string;
						const labelValues = parseLabels(this.getNodeParameter('labels', i) as string) ?? [];
						const result = await apiRequest(
							this,
							'PATCH',
							`/deployments/${encodeURIComponent(id)}`,
							{ labels: labelValues },
						);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'remove') {
						const id = this.getNodeParameter('deployment', i, '', {
							extractValue: true,
						}) as string;
						await apiRequest(this, 'DELETE', `/deployments/${encodeURIComponent(id)}`);
						returnData.push({ json: { success: true }, pairedItem });
					}
				} else if (resource === 'domain') {
					// All domain ops read the same `domain` resource locator.
					const name = this.getNodeParameter('domain', i, '', {
						extractValue: true,
					}) as string;

					if (operation === 'set') {
						const domainOptions = this.getNodeParameter('options', i) as IDataObject;
						// Merge-upsert semantics: omitted keys preserve, present keys update.
						// Empty Labels (added but blank) clears — same shape as Deployment Set.
						const body: IDataObject = {};
						const linkedDeployment = extractResourceLocatorValue(domainOptions.deployment);
						if (linkedDeployment) body.deployment = linkedDeployment;
						if (domainOptions.labels !== undefined) {
							body.labels = parseLabels(domainOptions.labels as string) ?? [];
						}
						const result = await apiRequest(
							this,
							'PUT',
							`/domains/${encodeURIComponent(name)}`,
							body,
						);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'list') {
						const returnAll = this.getNodeParameter('returnAll', 0) as boolean;
						const response = await apiRequest(this, 'GET', '/domains');
						let results = (response.domains ?? []) as IDataObject[];
						if (!returnAll) {
							const limit = this.getNodeParameter('limit', 0) as number;
							results = results.slice(0, limit);
						}
						for (const domain of results) {
							returnData.push({ json: toJson(domain), pairedItem });
						}
					} else if (operation === 'get') {
						const result = await apiRequest(this, 'GET', `/domains/${encodeURIComponent(name)}`);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'records') {
						const result = await apiRequest(
							this,
							'GET',
							`/domains/${encodeURIComponent(name)}/records`,
						);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'dns') {
						const result = await apiRequest(
							this,
							'GET',
							`/domains/${encodeURIComponent(name)}/dns`,
						);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'share') {
						const result = await apiRequest(
							this,
							'GET',
							`/domains/${encodeURIComponent(name)}/share`,
						);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'validate') {
						const result = await apiRequest(this, 'POST', '/domains/validate', {
							domain: name,
						});
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'verify') {
						const result = await apiRequest(
							this,
							'POST',
							`/domains/${encodeURIComponent(name)}/verify`,
						);
						returnData.push({ json: toJson(result), pairedItem });
					} else if (operation === 'remove') {
						await apiRequest(this, 'DELETE', `/domains/${encodeURIComponent(name)}`);
						returnData.push({ json: { success: true }, pairedItem });
					}
				} else if (resource === 'account') {
					const result = await apiRequest(this, 'GET', '/account');
					returnData.push({ json: toJson(result), pairedItem });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					const message = error instanceof Error ? error.message : 'An unexpected error occurred';
					returnData.push({ json: { error: message }, pairedItem });
					continue;
				}
				// Attach the input item index so n8n's error UI can highlight which
				// item caused the failure. Standard n8n core node pattern.
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					error.context = { ...error.context, itemIndex: i };
				}
				throw error;
			}
		}

		return [returnData];
	}
}
