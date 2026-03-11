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

function parseLabels(value: string): string[] | undefined {
	if (!value) return undefined;
	return value.split(',').map((l) => l.trim()).filter(Boolean);
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
		description: 'Deploy and manage static sites with ShipStatic',
		defaults: {
			name: 'ShipStatic',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'shipstaticApi',
				required: true,
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
					{ name: 'Upload', value: 'upload', description: 'Upload a deployment from a directory', action: 'Upload a deployment' },
					{ name: 'Get Many', value: 'getMany', description: 'List all deployments', action: 'List all deployments' },
					{ name: 'Get', value: 'get', description: 'Get a deployment by ID', action: 'Get a deployment' },
					{ name: 'Update', value: 'update', description: 'Update deployment labels', action: 'Update a deployment' },
					{ name: 'Delete', value: 'delete', description: 'Delete a deployment permanently', action: 'Delete a deployment' },
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
					{ name: 'Create or Update', value: 'set', description: 'Create domain, link to deployment, or update labels', action: 'Create or update a domain' },
					{ name: 'Get Many', value: 'getMany', description: 'List all domains', action: 'List all domains' },
					{ name: 'Get', value: 'get', description: 'Get a domain by name', action: 'Get a domain' },
					{ name: 'Get DNS Records', value: 'records', description: 'Get required DNS records for a domain', action: 'Get DNS records' },
					{ name: 'Validate', value: 'validate', description: 'Check if domain name is valid and available', action: 'Validate a domain' },
					{ name: 'Verify DNS', value: 'verify', description: 'Trigger DNS verification for a domain', action: 'Verify DNS' },
					{ name: 'Delete', value: 'delete', description: 'Delete a domain permanently', action: 'Delete a domain' },
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
					{ name: 'Get', value: 'get', description: 'Get current account information', action: 'Get account info' },
				],
				default: 'get',
			},

			// === Required Parameters ===

			// Deployment: path (upload)
			{
				displayName: 'Path',
				name: 'path',
				type: 'string',
				default: '',
				required: true,
				placeholder: '/path/to/build',
				displayOptions: { show: { resource: ['deployment'], operation: ['upload'] } },
				description: 'Absolute path to the directory or file to deploy',
			},

			// Deployment: ID (get, update, delete)
			{
				displayName: 'Deployment ID',
				name: 'deploymentId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDeployments' },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['deployment'], operation: ['get', 'update', 'delete'] } },
				description: 'Deployment ID (e.g. "happy-cat-abc1234")',
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
				displayName: 'Domain Name',
				name: 'domainName',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getDomains' },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['domain'], operation: ['get', 'records', 'verify', 'delete'] } },
				description: 'Domain name (e.g. "www.example.com")',
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
						displayName: 'Subdomain',
						name: 'subdomain',
						type: 'string',
						default: '',
						placeholder: 'my-site',
						description: 'Suggested subdomain for the deployment',
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
						displayName: 'Deployment',
						name: 'deployment',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getDeployments' },
						default: '',
						description: 'Deployment ID to link to this domain',
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
					const response = await this.helpers.httpRequestWithAuthentication.call(this, 'shipstaticApi', {
						method: 'GET',
						url: 'https://api.shipstatic.com/deployments',
						json: true,
					});
					return (response.deployments ?? []).map((d: { id: string; url?: string }) => ({
						name: d.url ? `${d.id} (${d.url})` : d.id,
						value: d.id,
					}));
				} catch {
					return [];
				}
			},
			async getDomains(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const response = await this.helpers.httpRequestWithAuthentication.call(this, 'shipstaticApi', {
						method: 'GET',
						url: 'https://api.shipstatic.com/domains',
						json: true,
					});
					return (response.domains ?? []).map((d: { name: string }) => ({
						name: d.name,
						value: d.name,
					}));
				} catch {
					return [];
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const credentials = await this.getCredentials('shipstaticApi');
		const ship = new Ship({ apiKey: credentials.apiKey as string });

		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'deployment') {
					if (operation === 'upload') {
						const path = this.getNodeParameter('path', i) as string;
						const options = this.getNodeParameter('options', i) as IDataObject;
						const result = await ship.deployments.upload(path, {
							subdomain: (options.subdomain as string) || undefined,
							labels: parseLabels(options.labels as string),
							via: 'n8n',
						});
						returnData.push({ json: toJson(result), pairedItem: { item: i } });
					} else if (operation === 'getMany') {
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
