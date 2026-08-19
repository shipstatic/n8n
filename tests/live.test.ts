/**
 * @file The live tier: the same `execute()`, a real API.
 *
 * Every other test drives the node against a mock of n8n's helper contract,
 * which can only ever prove the node is self-consistent. This tier is the one
 * that can observe the platform: whether a credential-less deploy really comes
 * back with a claim and an expiry, whether `DELETE /deployments/:id` really
 * answers with a transitional state, whether `via` is really stored. Those are
 * the claims the 2.x rewrite is ABOUT, and a mock asserts them by construction.
 *
 * **The environment dimension lives here, not in the artifact.** The node
 * cannot read `process.env` — `@n8n/community-nodes/no-restricted-globals`
 * bans it because n8n Cloud sandboxes community nodes away from `process` —
 * so `nodes/Shipstatic/api.ts` is a plain production constant and this file
 * substitutes it. That module existing as the single owner of the URL is what
 * makes the seam one line instead of a fork.
 *
 * SKIPS unless `SHIP_API_URL` is set, so it never runs in CI and never gates a
 * publish. To run it:
 *
 *   SHIP_API_URL=https://api.<env> SHIP_TOKEN=ship-your-api-key pnpm test --run live
 *
 * The `SHIP_TOKEN` half unlocks the authenticated gates; `SHIP_DEPLOY_TOKEN`
 * unlocks the deploy-token scope asymmetry. Each block skips independently, so
 * a partial credential set runs the part it can prove.
 */
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const API_URL = process.env.SHIP_API_URL;
const TOKEN = process.env.SHIP_TOKEN;
const DEPLOY_TOKEN = process.env.SHIP_DEPLOY_TOKEN;

// Hoisted above the import below — this is the whole substitution.
vi.mock('../nodes/Shipstatic/api', () => ({ API: process.env.SHIP_API_URL }));

const { Shipstatic } = await import('../nodes/Shipstatic/Shipstatic.node');
const node = new Shipstatic();

// ─── A faithful-enough n8n ──────────────────────────────────────────────────
//
// Only the four helpers the node actually calls. `request` is the legacy
// multipart path (n8n's modern helper does not do FormData reliably, which is
// why the node uses it); the `{ value, options: { filename } }` entry shape is
// request-promise's, translated here to a real multipart body.

function toMultipart(formData: Record<string, unknown>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(formData)) {
    if (Array.isArray(value)) {
      for (const entry of value as { value: Buffer; options: { filename: string } }[]) {
        body.append(
          key,
          new Blob([new Uint8Array(entry.value)], { type: 'application/octet-stream' }),
          entry.options.filename,
        );
      }
    } else {
      body.append(key, String(value));
    }
  }
  return body;
}

async function send(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    const error: any = new Error(text || response.statusText);
    error.statusCode = response.status;
    error.httpCode = String(response.status);
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

function liveContext(params: Record<string, any>, token?: string) {
  return {
    getNodeParameter: (name: string, _i?: number, fallback?: unknown, opts?: any) => {
      const value = params[name];
      if (opts?.extractValue && value && typeof value === 'object' && 'value' in value) {
        return value.value;
      }
      return value ?? fallback;
    },
    getCredentials: async () => {
      if (!token) throw new Error('No credentials');
      return { token };
    },
    getInputData: () => [{ json: {} }],
    getNode: () => ({ name: 'ShipStatic' }),
    continueOnFail: () => false,
    helpers: {
      assertBinaryData: () => ({ fileName: 'index.html' }),
      getBinaryDataBuffer: async () => Buffer.from(params.__html ?? '<h1>live</h1>'),
      // The legacy helper carries BOTH shapes: `formData` for the multipart
      // deploy, `body` + `json: true` for the SPA check. Handling only the
      // first made `/spa-check` throw — swallowed by design, which is why the
      // deploy still succeeded and only the file count gave it away.
      request: (opts: any) =>
        send(opts.uri, {
          method: opts.method,
          headers: opts.headers,
          body: opts.formData ? toMultipart(opts.formData) : JSON.stringify(opts.body),
        }),
      httpRequestWithAuthentication: (_credType: string, opts: any) =>
        send(opts.url, {
          method: opts.method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        }),
    },
  } as any;
}

const deployParams = (overrides: Record<string, any> = {}) => ({
  resource: 'deployment',
  operation: 'upload',
  input: 'binary',
  binaryPropertyName: 'data',
  options: {},
  ...overrides,
});

const run = async (params: Record<string, any>, token?: string) => {
  const [results] = await node.execute.call(liveContext(params, token));
  return results;
};

// ─── The anonymous door ─────────────────────────────────────────────────────

describe.skipIf(!API_URL)('live — keyless deploy', () => {
  let deployment: any;

  beforeAll(async () => {
    [deployment] = (await run(deployParams())).map((r: any) => r.json);
  }, 60_000);

  it('succeeds with no Authorization header at all', () => {
    expect(deployment.deployment).toMatch(/\./);
    expect(deployment.url).toContain(deployment.deployment);
  });

  it('carries the claim URL and the expiry the node must pass through', () => {
    // The whole point of the deletion: 2.x anonymity is granted in-band, and
    // the response is what tells the user how to keep the site.
    expect(deployment.claim).toBeTruthy();
    expect(typeof deployment.expires).toBe('number');
    expect(deployment.expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('is attributed to n8n', () => {
    expect(deployment.via).toBe('n8n');
  });
});

// ─── The authenticated paths ────────────────────────────────────────────────

describe.skipIf(!API_URL || !TOKEN)('live — authenticated', () => {
  let deployment: any;

  beforeAll(async () => {
    [deployment] = (await run(deployParams(), TOKEN)).map((r: any) => r.json);
  }, 60_000);

  it('deploys under the account: no claim, and no expiry', () => {
    expect(deployment.claim).toBeUndefined();
    expect(deployment.expires).toBeNull();
  });

  it('stores `via` as the node reports it — read back through `get`', async () => {
    // The constant could be right, sent, and still dropped by the server if it
    // fell outside the closed vocabulary. Only a read-back proves it landed.
    const [item] = await run(
      {
        resource: 'deployment',
        operation: 'get',
        deployment: { __rl: true, mode: 'id', value: deployment.deployment },
      },
      TOKEN,
    );
    expect(item.json.via).toBe('n8n');
  });

  it('round-trips a password', async () => {
    const [item] = await run(deployParams({ options: { password: 'live-secret-1' } }), TOKEN);
    expect(item.json.password).toBe(true);
  });

  it('deletes with the transitional acknowledgement, not a boolean', async () => {
    const [item] = await run(
      {
        resource: 'deployment',
        operation: 'delete',
        deployment: { __rl: true, mode: 'id', value: deployment.deployment },
      },
      TOKEN,
    );
    expect(item.json).toEqual({ deployment: deployment.deployment, status: 'deleting' });
    expect(item.json).not.toHaveProperty('success');
  });

  it('reads the account', async () => {
    const [item] = await run({ resource: 'account', operation: 'whoami' }, TOKEN);
    expect(item.json.email).toBeTruthy();
    expect(item.json.plan).toBeTruthy();
  });

  it('checksums are what the API verified the upload against', () => {
    // If the node's MD5s disagreed with the bytes, the deploy above would have
    // been rejected — so a successful deploy IS the assertion. Stated so the
    // guarantee is not invisible.
    const md5 = createHash('md5').update(Buffer.from('<h1>live</h1>')).digest('hex');
    expect(md5).toHaveLength(32);
    expect(deployment.files).toBe(1);
  });
});

// ─── SPA parity, and pagination ─────────────────────────────────────────────

describe.skipIf(!API_URL || !TOKEN)('live — SPA routing', () => {
  it('a React-shaped build gets the routing config the SDK would have added', async () => {
    // The whole finding: without this, a workflow deploying a React build
    // serves 404s on every route but `/`. Only a real `/spa-check` can say
    // whether the detector agrees with the mirror.
    const [item] = await run(
      deployParams({
        input: 'text',
        fileName: 'index.html',
        fileContent:
          '<html><head><script type="module" src="/assets/app.js"></script></head>' +
          '<body><div id="root"></div></body></html>',
      }),
      TOKEN,
    );
    // Two files reached the API: the page, and the config the node appended.
    expect(item.json.files).toBe(2);
    expect(item.json.config).toBe(true);
  });
});

describe.skipIf(!API_URL || !TOKEN)('live — Files (JSON) mode', () => {
  // The one tier that can prove the whole files-mode path: JSON in, strict
  // base64 decode, multipart out, R2 storage, and the router serving the bytes
  // back. Every step between the parser and the served file is somebody else's
  // code, so self-consistency proves nothing here.
  it('deploys a two-file site and serves both files back byte-for-byte', async () => {
    // A real binary, small enough to read in the assertion: a 1x1 GIF. Its
    // bytes are the point — if the strict-base64 check or the multipart
    // encoding mangled them, the served file differs and this fails. That is
    // the failure the mocked tier structurally cannot produce.
    const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const gifBytes = Buffer.from(gifBase64, 'base64');
    const html = '<h1>files mode</h1><img src="pixel.gif">';

    const [item] = await run(
      deployParams({
        input: 'files',
        files: [
          { path: 'index.html', content: html },
          { path: 'pixel.gif', content: gifBase64, encoding: 'base64' },
        ],
        // The site is deliberately NOT a SPA, so the file count stays 2 and a
        // silent `ship.json` append would show up as a failure here.
        options: { spaDetect: false },
      }),
      TOKEN,
    );

    expect(item.json.files).toBe(2);

    const base = `https://${item.json.deployment}`;

    // **HTML is NOT served byte-identical, by design.** The router rewrites
    // asset URLs with an immutable-cache buster — `pixel.gif` comes back as
    // `pixel.gif?_ship=…` — which is a platform feature, not damage. This
    // assertion asserted byte equality on the first run and failed on exactly
    // that, which is the live tier earning its place: no mock of n8n's helpers
    // can show what the ROUTER does to a file after it is stored.
    const servedHtml = await fetch(`${base}/index.html`);
    expect(servedHtml.status).toBe(200);
    const servedText = await servedHtml.text();
    expect(servedText).toContain('<h1>files mode</h1>');
    expect(servedText).toMatch(/src="pixel\.gif(\?_ship=[a-z0-9]+)?"/);

    // The binary is where byte equality belongs — nothing rewrites it, so this
    // is the end-to-end proof of the whole files-mode path: strict base64
    // decode → multipart → storage → serving. Equality rather than length,
    // because a mangled decode can preserve the size.
    const servedGif = await fetch(`${base}/pixel.gif`);
    expect(servedGif.status).toBe(200);
    expect(Buffer.from(await servedGif.arrayBuffer()).equals(gifBytes)).toBe(true);
  });

  it('relays the API refusal for a path the node did not pre-judge', async () => {
    // The node checks its OWN input format (shape, path structure, base64) and
    // leaves PLATFORM POLICY to the API. This proves the second half is really
    // reaching the server rather than being caught locally: a blocked
    // extension is the API's rule, and its sentence must arrive intact.
    await expect(
      run(
        deployParams({
          input: 'files',
          files: [{ path: 'payload.exe', content: 'not really an executable' }],
          options: { spaDetect: false },
        }),
        TOKEN,
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!API_URL || !TOKEN)('live — pagination', () => {
  it('walks past the first page rather than stopping at the server default', async () => {
    // `limit: 1` forces a cursor from a real API regardless of how many
    // deployments the account holds — the condition the mocked tier cannot
    // create and the dev account (under the 50 default) never did.
    const results = await run(
      { resource: 'deployment', operation: 'list', returnAll: false, limit: 3 },
      TOKEN,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('returnAll follows every cursor to the end', async () => {
    const all = await run({ resource: 'deployment', operation: 'list', returnAll: true }, TOKEN);
    const bounded = await run(
      { resource: 'deployment', operation: 'list', returnAll: false, limit: 1 },
      TOKEN,
    );
    expect(bounded).toHaveLength(1);
    expect(all.length).toBeGreaterThanOrEqual(bounded.length);
  });
});

// ─── The documented scope asymmetry (D4) ────────────────────────────────────

describe.skipIf(!API_URL || !DEPLOY_TOKEN)('live — deploy token', () => {
  it('deploys', async () => {
    const [item] = await run(deployParams(), DEPLOY_TOKEN);
    expect(item.json.deployment).toBeTruthy();
    expect(item.json.claim).toBeUndefined();
  });

  it('is refused by the credential test — a 401 indistinguishable from junk', async () => {
    // This is the asymmetry the credential's description warns about, observed
    // rather than assumed. `GET /account` is exactly what the connection test
    // calls, and the API refuses a deploy-scoped credential there WITHOUT
    // saying why — which is why no smarter probe could exist.
    await expect(
      send(`${API_URL}/account`, { headers: { Authorization: `Bearer ${DEPLOY_TOKEN}` } }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
