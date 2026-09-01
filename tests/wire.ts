/**
 * @file Fence: the wire shapes this node passes through are the platform's.
 *
 * The node speaks HTTP directly — no SDK, by n8n Cloud's zero-runtime-dependency
 * rule — which makes it the one consumer in the constellation that could
 * restate a response shape by hand and drift from it silently. It cannot
 * IMPORT the shapes at runtime, but the suite can: `@shipstatic/types` is a
 * devDependency, and every fixture below is `satisfies`-checked against the
 * type the API actually answers with.
 *
 * So an API reshape lands here as a compile error under `pnpm typecheck`
 * rather than as a workflow that quietly reads `undefined`. That only holds
 * because `tsconfig.check.json` covers `tests/**` — vitest transpiles through
 * esbuild without typechecking, and a `satisfies` clause nothing ever compiles
 * is decoration.
 *
 * Fixtures are shared with `tests/live.test.ts`, which asserts the same shapes
 * against a real API rather than a mock. Two tiers, one vocabulary.
 */
import type {
  AccountGetResponse,
  Deployment,
  DeploymentCreateResponse,
  DeploymentDeleteResponse,
  Domain,
  DomainDeleteResponse,
  DomainDnsResponse,
  DomainRecordsResponse,
  DomainShareResponse,
  DomainValidateResponse,
  DomainVerifyResponse,
} from '@shipstatic/types';

// ─── Deployments ────────────────────────────────────────────────────────────

/** A deployment under an account: no claim, and it never expires. */
export const DEPLOYMENT = {
  deployment: 'happy-cat-abc1234.shipstatic.com',
  url: 'https://happy-cat-abc1234.shipstatic.com',
  files: 2,
  size: 4096,
  status: 'success',
  config: false,
  password: false,
  labels: [],
  via: 'n8n',
  created: 1785000000,
  expires: null,
  screenshot: 'https://screenshots.shipstatic.com/happy-cat-abc1234/a3f2c1b4d5e6f789',
} satisfies Deployment;

/**
 * What a credential-less deploy answers with. `claim` and `expires` are the
 * whole point of the anonymous door — the node passes them through untouched
 * so a workflow can show the user how to keep the site.
 */
export const ANONYMOUS_DEPLOYMENT = {
  ...DEPLOYMENT,
  claim: `https://my.shipstatic.com/claim/${'a'.repeat(32)}`,
  expires: 1785259200,
} satisfies DeploymentCreateResponse;

/**
 * The 202 acknowledgement. `status` is the transitional state — the site stays
 * served until background cleanup completes — and it is exactly what the node
 * used to discard in favour of `{ success: true }`.
 */
export const DEPLOYMENT_DELETED = {
  deployment: DEPLOYMENT.deployment,
  status: 'deleting',
} satisfies DeploymentDeleteResponse;

// ─── Domains ────────────────────────────────────────────────────────────────

export const DOMAIN = {
  domain: 'www.example.com',
  url: 'https://www.example.com',
  deployment: DEPLOYMENT.deployment,
  status: 'success',
  labels: [],
  created: 1785000000,
  linked: 1785000000,
  links: 1,
} satisfies Domain;

/** 200, and the row is gone — which is why this one carries no state. */
export const DOMAIN_DELETED = {
  domain: DOMAIN.domain,
} satisfies DomainDeleteResponse;

export const DOMAIN_VERIFY = {
  domain: DOMAIN.domain,
} satisfies DomainVerifyResponse;

export const DOMAIN_DNS = {
  domain: DOMAIN.domain,
  dns: { provider: { name: 'Cloudflare' } },
} satisfies DomainDnsResponse;

export const DOMAIN_RECORDS = {
  domain: DOMAIN.domain,
  apex: 'example.com',
  records: [
    { type: 'CNAME', name: 'www', value: 'happy-cat-abc1234.shipstatic.com' },
    { type: 'A', name: '@', value: '203.0.113.10' },
  ],
} satisfies DomainRecordsResponse;

// wire: api/src/lib/domains/utils.ts — the FINISHED setup link,
// `https://connect.<platform>/<domain>/<hash>`; no client assembles one.
export const DOMAIN_SHARE = {
  domain: DOMAIN.domain,
  url: `https://connect.shipstatic.com/${DOMAIN.domain}/a1b2c3d4e5f6`,
} satisfies DomainShareResponse;

export const DOMAIN_VALID = {
  valid: true,
  normalized: DOMAIN.domain,
  available: true,
  reason: null,
} satisfies DomainValidateResponse;

// ─── Account ────────────────────────────────────────────────────────────────

export const ACCOUNT = {
  email: 'me@example.com',
  name: null,
  picture: null,
  plan: 'free',
  suspended: false,
  usage: { deployments: 2, platformDomains: 0, customDomains: 1 },
  caps: { deployments: 10, platformDomains: 1, customDomains: 1 },
  created: 1785000000,
  activated: 1785000000,
  hint: 'cdef',
  pastDue: false,
  billed: false,
  upgrade: null,
  interval: null,
  scheduled: null,
  cancelAt: null,
  authMethod: 'apiKey',
} satisfies AccountGetResponse;
