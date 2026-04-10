import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ShipstaticApi implements ICredentialType {
	name = 'shipstaticApi';
	displayName = 'ShipStatic API';
	icon = 'file:shipstatic.svg' as const;
	documentationUrl = 'https://docs.shipstatic.com';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'ship-...',
			description:
				'Create a free API key at <a href="https://my.shipstatic.com/api-key">my.shipstatic.com/api-key</a>',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '={{"Bearer " + $credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.shipstatic.com',
			url: '/account',
			method: 'GET',
		},
	};
}
