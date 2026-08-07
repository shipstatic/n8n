import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';
import { API } from '../nodes/Shipstatic/api';

export class ShipstaticApi implements ICredentialType {
  // The credential TYPE id names the platform, not the credential's shape, so
  // it survives the one-slot rename. Changing it would orphan every stored
  // credential for no gain.
  name = 'shipstaticApi';
  displayName = 'ShipStatic API';
  icon = 'file:shipstatic.svg' as const;
  documentationUrl = 'https://docs.shipstatic.com';
  properties: INodeProperties[] = [
    {
      // ONE credential slot. The platform has two token populations and the
      // value's shape says which it is — the server classifies, so a second
      // field would only let a user contradict themselves.
      displayName: 'Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      placeholder: 'ship-… or deploy-…',
      description:
        'An API key or a deploy token — one slot takes either. Create a free API key at <a href="https://my.shipstatic.com/api-key">my.shipstatic.com/api-key</a>. A deploy token is deploy-scoped: it runs the Deploy operation and nothing else, so it will FAIL the connection test below — that is expected, not a broken credential.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '={{"Bearer " + $credentials.token}}',
      },
    },
  };

  // The test answers "can this credential use the node's account operations",
  // which is what a user configuring a credential wants to know — and the only
  // question the API will answer. A `deploy-` token is refused at the auth
  // boundary with a 401 byte-identical to a garbage credential (the API
  // deliberately does not leak scope), so no probe could distinguish the two.
  // Rather than trade a truthful signal for a vacuous reachability blink
  // against `/ping`, the test stays honest and the 401 says both things.
  test: ICredentialTestRequest = {
    request: {
      baseURL: API,
      url: '/account',
      method: 'GET',
    },
    rules: [
      {
        type: 'responseCode',
        properties: {
          value: 401,
          message:
            'Rejected for account access. Check the value — or, if this is a deploy token (deploy-…), that is expected: deploy tokens only deploy, and the Deploy operation will still work.',
        },
      },
    ],
  };
}
