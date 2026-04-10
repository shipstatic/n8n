import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { createHash, randomBytes } from 'node:crypto';

const API = 'https://api.shipstatic.com';

function md5(buf: Buffer): string {
	return createHash('md5').update(buf).digest('hex');
}

function buildMultipart(
	files: { path: string; content: Buffer; md5: string }[],
	fields: Record<string, string>,
): { body: Buffer; contentType: string } {
	const boundary = '----n8n' + randomBytes(16).toString('hex');
	const parts: Buffer[] = [];
	for (const f of files) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="${f.path}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
			),
		);
		parts.push(f.content);
		parts.push(Buffer.from('\r\n'));
	}
	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
			),
		);
	}
	parts.push(Buffer.from(`--${boundary}--\r\n`));
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
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
		throw new NodeOperationError(ctx.getNode(), 'No files to deploy — all input items were empty');
	}

	// 2. Optimize paths — strip common directory prefix
	if (files.length > 1) {
		const segments = files.map((f) => f.path.replace(/\\/g, '/').split('/'));
		const minLen = Math.min(...segments.map((s) => s.length));
		let strip = 0;
		for (let i = 0; i < minLen - 1; i++) {
			if (segments.every((s) => s[i] === segments[0][i])) strip++;
			else break;
		}
		if (strip > 0) {
			for (const f of files) {
				f.path = f.path.replace(/\\/g, '/').split('/').slice(strip).join('/');
			}
		}
	}

	// 3. Build multipart body
	const labels = parseLabels(options.labels as string);
	const fields: Record<string, string> = {
		checksums: JSON.stringify(files.map((f) => f.md5)),
		via: 'n8n',
		spa: 'true', // server-side SPA detection + rewrite config
	};
	if (labels) fields.labels = JSON.stringify(labels);
	const { body, contentType } = buildMultipart(files, fields);

	// 4. Resolve auth — API key for permanent deploys, agent token for public/temporary
	let authorization: string;
	if (apiKey) {
		authorization = `Bearer ${apiKey}`;
	} else {
		// No API key — request a short-lived agent token for a public deployment
		const { secret } = (await ctx.helpers.httpRequest({
			method: 'POST',
			url: `${API}/tokens/agent`,
			body: {},
			json: true,
		})) as IDataObject;
		authorization = `Bearer ${secret}`;
	}

	// 5. Deploy
	const result = await ctx.helpers.httpRequest({
		method: 'POST',
		url: `${API}/deployments`,
		body,
		headers: { Authorization: authorization, 'Content-Type': contentType } as IDataObject,
	});

	return [
		{
			json: toJson(result),
			pairedItem: items.map((_, i) => ({ item: i })),
		},
	];
}

async function apiRequest(
	ctx: IExecuteFunctions,
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	path: string,
	body?: object,
): Promise<IDataObject> {
	return ctx.helpers.httpRequestWithAuthentication.call(ctx, 'shipstaticApi', {
		method,
		url: `${API}${path}`,
		body,
		json: true,
	});
}

export class Shipstatic implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ShipStatic',
		name: 'shipstatic',
		icon: 'file:shipstatic.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description:
			'Free, no account needed — deploy static websites, landing pages, and prototypes instantly',
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
			// Resource
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

			// Deployment operations
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
						description: 'Publish files and get a live URL instantly — no account needed',
						action: 'Deploy a site',
					},
					{
						name: 'Get',
						value: 'get',
						description:
							'Get deployment details including URL, status, file count, size, and labels',
						action: 'Get a deployment',
					},
					{
						name: 'List',
						value: 'list',
						description: 'List all deployments with their URLs, status, and labels',
						action: 'List all deployments',
					},
					{
						name: 'Remove',
						value: 'remove',
						description: 'Permanently remove a deployment and all its files',
						action: 'Remove a deployment',
					},
					{
						name: 'Set',
						value: 'set',
						description: 'Update the labels on a deployment for organization and filtering',
						action: 'Set deployment labels',
					},
				],
				default: 'deploy',
			},

			// Domain operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['domain'] } },
				options: [
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
						description: 'List all domains with their linked deployments and verification status',
						action: 'List all domains',
					},
					{
						name: 'Records',
						value: 'records',
						description: 'Get the DNS records you need to configure at your DNS provider',
						action: 'Get DNS records',
					},
					{
						name: 'Remove',
						value: 'remove',
						description: 'Permanently disconnect and remove a custom domain',
						action: 'Remove a domain',
					},
					{
						name: 'Set',
						value: 'set',
						description:
							'Connect a custom domain to your site, switch deployments, or update labels',
						action: 'Set a domain',
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
						description: 'Check if DNS is configured correctly after you set up the records',
						action: 'Verify DNS',
					},
				],
				default: 'set',
			},

			// Account operations
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

			// === Required Parameters ===

			// Deployment: binary toggle (deploy)
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
			},

			// Deployment: ID (get, set, remove)
			{
				displayName: 'Deployment Name or ID',
				name: 'deploymentId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDeployments' },
				default: '',
				required: true,
				displayOptions: {
					show: { resource: ['deployment'], operation: ['get', 'set', 'remove'] },
				},
				description:
					'Deployment hostname (e.g. "happy-cat-abc1234.shipstatic.com"). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// Deployment: labels (set — the payload)
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'string',
				default: '',
				placeholder: 'production, v2',
				displayOptions: { show: { resource: ['deployment'], operation: ['set'] } },
				description: 'Comma-separated labels',
			},

			// Domain: name — existing domain (get, records, verify, remove)
			{
				displayName: 'Domain Name or ID',
				name: 'domainName',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDomains' },
				default: '',
				required: true,
				displayOptions: {
					show: { resource: ['domain'], operation: ['get', 'records', 'verify', 'remove'] },
				},
				description:
					'Domain name (e.g. "www.example.com"). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// Domain: name — new/any domain (set, validate)
			{
				displayName: 'Domain Name',
				name: 'domainName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'www.example.com',
				displayOptions: { show: { resource: ['domain'], operation: ['set', 'validate'] } },
				description: 'Domain name (e.g. "www.example.com")',
			},

			// === List Controls ===

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

			// === Options (optional fields) ===

			// Deploy options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['deployment'], operation: ['deploy'] } },
				options: [
					{
						displayName: 'Labels',
						name: 'labels',
						type: 'string',
						default: '',
						placeholder: 'production, v2',
						description: 'Comma-separated labels',
					},
				],
			},

			// Domain Set options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['domain'], operation: ['set'] } },
				options: [
					{
						displayName: 'Deployment Name or ID',
						name: 'deployment',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getDeployments' },
						default: '',
						description:
							'Deployment to link to this domain. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Labels',
						name: 'labels',
						type: 'string',
						default: '',
						placeholder: 'production, v2',
						description: 'Comma-separated labels',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getDeployments(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const response = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'shipstaticApi',
						{
							method: 'GET',
							url: `${API}/deployments`,
							json: true,
						},
					);
					return (response.deployments ?? []).map((d: { deployment: string }) => ({
						name: d.deployment,
						value: d.deployment,
					}));
				} catch {
					return [];
				}
			},
			async getDomains(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const response = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'shipstaticApi',
						{
							method: 'GET',
							url: `${API}/domains`,
							json: true,
						},
					);
					return (response.domains ?? []).map((d: { domain: string }) => ({
						name: d.domain,
						value: d.domain,
					}));
				} catch {
					return [];
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Deploy works two ways:
		// • With API key  → permanent deployment under your account
		// • Without        → public deployment, expires in 3 days (no sign-up needed)
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
					const message = error instanceof Error ? error.message : 'An unexpected error occurred';
					returnData.push({ json: { error: message }, pairedItem: { item: 0 } });
				} else {
					throw new NodeOperationError(this.getNode(), error as Error);
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
				'This operation requires a ShipStatic API key. Add a ShipStatic credential to use it.',
			);
		}

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'deployment') {
					if (operation === 'list') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const response = await apiRequest(this, 'GET', '/deployments');
						let results = (response.deployments ?? []) as IDataObject[];
						if (!returnAll) {
							const limit = this.getNodeParameter('limit', i) as number;
							results = results.slice(0, limit);
						}
						for (const deployment of results) {
							returnData.push({ json: toJson(deployment), pairedItem: { item: i } });
						}
					} else if (operation === 'get') {
						const id = this.getNodeParameter('deploymentId', i) as string;
						const result = await apiRequest(this, 'GET', `/deployments/${encodeURIComponent(id)}`);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'set') {
						const id = this.getNodeParameter('deploymentId', i) as string;
						const labelValues = parseLabels(this.getNodeParameter('labels', i) as string) ?? [];
						const result = await apiRequest(
							this,
							'PATCH',
							`/deployments/${encodeURIComponent(id)}`,
							{ labels: labelValues },
						);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'remove') {
						const id = this.getNodeParameter('deploymentId', i) as string;
						await apiRequest(this, 'DELETE', `/deployments/${encodeURIComponent(id)}`);
						returnData.push({ json: { success: true }, pairedItem: { item: i } });
					}
				} else if (resource === 'domain') {
					if (operation === 'set') {
						const name = this.getNodeParameter('domainName', i) as string;
						const domainOptions = this.getNodeParameter('options', i) as IDataObject;
						const result = await apiRequest(this, 'PUT', `/domains/${encodeURIComponent(name)}`, {
							deployment: (domainOptions.deployment as string) || undefined,
							labels: parseLabels(domainOptions.labels as string),
						});
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'list') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const response = await apiRequest(this, 'GET', '/domains');
						let results = (response.domains ?? []) as IDataObject[];
						if (!returnAll) {
							const limit = this.getNodeParameter('limit', i) as number;
							results = results.slice(0, limit);
						}
						for (const domain of results) {
							returnData.push({ json: toJson(domain), pairedItem: { item: i } });
						}
					} else if (operation === 'get') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await apiRequest(this, 'GET', `/domains/${encodeURIComponent(name)}`);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'records') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await apiRequest(
							this,
							'GET',
							`/domains/${encodeURIComponent(name)}/records`,
						);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'validate') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await apiRequest(this, 'POST', '/domains/validate', {
							domain: name,
						});
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'verify') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await apiRequest(
							this,
							'POST',
							`/domains/${encodeURIComponent(name)}/verify`,
						);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'remove') {
						const name = this.getNodeParameter('domainName', i) as string;
						await apiRequest(this, 'DELETE', `/domains/${encodeURIComponent(name)}`);
						returnData.push({ json: { success: true }, pairedItem: { item: i } });
					}
				} else if (resource === 'account') {
					const result = await apiRequest(this, 'GET', '/account');
					returnData.push({ json: toJson(result), pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					const message = error instanceof Error ? error.message : 'An unexpected error occurred';
					returnData.push({ json: { error: message }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
