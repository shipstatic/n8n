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
import Ship from '@shipstatic/ship';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

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
						name: 'Delete',
						value: 'delete',
						description: 'Permanently remove a deployment and all its files',
						action: 'Delete a deployment',
					},
					{
						name: 'Get',
						value: 'get',
						description:
							'Get details for a specific deployment including URL, status, and file count',
						action: 'Get a deployment',
					},
					{
						name: 'Get Many',
						value: 'getMany',
						description: 'List all your deployed sites with their URLs, status, and labels',
						action: 'List all deployments',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update the labels on a deployment for organization and filtering',
						action: 'Update a deployment',
					},
					{
						name: 'Upload',
						value: 'upload',
						description: 'Publish files and get a live URL instantly — no account needed',
						action: 'Upload a deployment',
					},
				],
				default: 'upload',
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
						name: 'Create or Update',
						value: 'set',
						description:
							'Connect a custom domain to your site, switch deployments, or update labels',
						action: 'Create or update a domain',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Permanently disconnect and remove a custom domain',
						action: 'Delete a domain',
					},
					{
						name: 'Get',
						value: 'get',
						description:
							'Get details for a specific domain including its linked site and DNS status',
						action: 'Get a domain',
					},
					{
						name: 'Get DNS Records',
						value: 'records',
						description: 'Get the DNS records you need to configure at your DNS provider',
						action: 'Get DNS records',
					},
					{
						name: 'Get Many',
						value: 'getMany',
						description:
							'List all your custom domains with their linked sites and verification status',
						action: 'List all domains',
					},
					{
						name: 'Validate',
						value: 'validate',
						description: 'Check if a domain name is valid and available before connecting it',
						action: 'Validate a domain',
					},
					{
						name: 'Verify DNS',
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

			// Deployment: binary field (upload)
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: { show: { resource: ['deployment'], operation: ['upload'] } },
				hint: 'The name of the input binary field containing the file data',
			},

			// Deployment: ID (get, update, delete)
			{
				displayName: 'Deployment Name or ID',
				name: 'deploymentId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDeployments' },
				default: '',
				required: true,
				displayOptions: {
					show: { resource: ['deployment'], operation: ['get', 'update', 'delete'] },
				},
				description:
					'Deployment hostname (e.g. "happy-cat-abc1234.shipstatic.com"). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// Deployment: labels (update — the payload, not optional)
			{
				displayName: 'Labels',
				name: 'labels',
				type: 'string',
				default: '',
				placeholder: 'production, v2',
				displayOptions: { show: { resource: ['deployment'], operation: ['update'] } },
				description: 'Comma-separated labels',
			},

			// Domain: name — existing domain (get, records, verify, delete)
			{
				displayName: 'Domain Name or ID',
				name: 'domainName',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDomains' },
				default: '',
				required: true,
				displayOptions: {
					show: { resource: ['domain'], operation: ['get', 'records', 'verify', 'delete'] },
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
				displayOptions: { show: { operation: ['getMany'] } },
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { operation: ['getMany'], returnAll: [false] } },
				description: 'Max number of results to return',
			},

			// === Options (optional fields) ===

			// Upload options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['deployment'], operation: ['upload'] } },
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
							url: 'https://api.shipstatic.com/deployments',
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
							url: 'https://api.shipstatic.com/domains',
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

		// Upload works without credentials (claimable deployment, 3-day TTL).
		// All other operations require an API key.
		const ship = await this.getCredentials('shipstaticApi')
			.then((c) => new Ship({ apiKey: c.apiKey as string }))
			.catch(() => {
				if (resource === 'deployment' && operation === 'upload') return new Ship({});
				throw new NodeOperationError(
					this.getNode(),
					'This operation requires a ShipStatic API key. Add a ShipStatic credential to use it.',
				);
			});

		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Upload: all input items → one deployment
		if (resource === 'deployment' && operation === 'upload') {
			const binaryPropertyName = this.getNodeParameter('binaryPropertyName', 0) as string;
			const options = this.getNodeParameter('options', 0) as IDataObject;
			const tempDir = await mkdtemp(join(tmpdir(), 'n8n-shipstatic-'));
			try {
				for (let i = 0; i < items.length; i++) {
					const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
					const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
					const dir = (binaryData.directory || '').replace(/^\/+/, '');
					const fullPath = join(tempDir, dir, binaryData.fileName || `file_${i}`);
					await mkdir(dirname(fullPath), { recursive: true });
					await writeFile(fullPath, buffer);
				}
				const result = await ship.deployments.upload(tempDir, {
					labels: parseLabels(options.labels as string),
					via: 'n8n',
				});
				returnData.push({
					json: toJson(result),
					pairedItem: items.map((_, i) => ({ item: i })),
				});
			} catch (error) {
				if (this.continueOnFail()) {
					const message = error instanceof Error ? error.message : 'An unexpected error occurred';
					returnData.push({ json: { error: message }, pairedItem: { item: 0 } });
				} else {
					throw new NodeOperationError(this.getNode(), error as Error);
				}
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
			return [returnData];
		}

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'deployment') {
					if (operation === 'getMany') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const response = await ship.deployments.list();
						let results = response.deployments;
						if (!returnAll) {
							const limit = this.getNodeParameter('limit', i) as number;
							results = results.slice(0, limit);
						}
						for (const deployment of results) {
							returnData.push({ json: toJson(deployment), pairedItem: { item: i } });
						}
					} else if (operation === 'get') {
						const id = this.getNodeParameter('deploymentId', i) as string;
						const result = await ship.deployments.get(id);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'update') {
						const id = this.getNodeParameter('deploymentId', i) as string;
						const labels = parseLabels(this.getNodeParameter('labels', i) as string) ?? [];
						const result = await ship.deployments.set(id, { labels });
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'delete') {
						const id = this.getNodeParameter('deploymentId', i) as string;
						await ship.deployments.remove(id);
						returnData.push({ json: { success: true }, pairedItem: { item: i } });
					}
				} else if (resource === 'domain') {
					if (operation === 'set') {
						const name = this.getNodeParameter('domainName', i) as string;
						const options = this.getNodeParameter('options', i) as IDataObject;
						const result = await ship.domains.set(name, {
							deployment: (options.deployment as string) || undefined,
							labels: parseLabels(options.labels as string),
						});
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'getMany') {
						const returnAll = this.getNodeParameter('returnAll', i) as boolean;
						const response = await ship.domains.list();
						let results = response.domains;
						if (!returnAll) {
							const limit = this.getNodeParameter('limit', i) as number;
							results = results.slice(0, limit);
						}
						for (const domain of results) {
							returnData.push({ json: toJson(domain), pairedItem: { item: i } });
						}
					} else if (operation === 'get') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await ship.domains.get(name);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'records') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await ship.domains.records(name);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'validate') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await ship.domains.validate(name);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'verify') {
						const name = this.getNodeParameter('domainName', i) as string;
						const result = await ship.domains.verify(name);
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'delete') {
						const name = this.getNodeParameter('domainName', i) as string;
						await ship.domains.remove(name);
						returnData.push({ json: { success: true }, pairedItem: { item: i } });
					}
				} else if (resource === 'account') {
					const result = await ship.whoami();
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
