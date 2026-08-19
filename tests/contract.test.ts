/**
 * @file Fences: every contract this repo holds that no other test can see.
 *
 * This node is the one consumer in the constellation that cannot IMPORT the
 * facts it depends on. `@n8n/community-nodes/no-restricted-imports` refuses any
 * non-relative import in `nodes/` and `credentials/` — including `import type`,
 * which it rejects syntactically even though it provably erases — because n8n
 * Cloud's zero-dependency contract does not read TypeScript. So the node
 * RESTATES the platform's values as literals.
 *
 * The constellation law's second clause is exactly about that case: where a
 * restatement is forced, a fence compares the copies. The suite may import
 * `@shipstatic/types` freely (it is a devDependency and never ships), so every
 * literal below is checked against its owner here.
 *
 * The artifact fence is the other half — it proves the zero-dependency claim
 * empirically, over the bytes that actually ship, rather than trusting the lint
 * rule that motivated all of this.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorResponse } from '@shipstatic/types';
import {
  API_KEY,
  DEFAULT_API,
  DEPLOY_TOKEN,
  DEPLOYMENT_CONFIG_FILENAME,
  DeploymentVia,
  IDEMPOTENCY_KEY_CONSTRAINTS,
  MY_API_KEY_URL,
  PASSWORD_CONSTRAINTS,
  PUBLIC_DEPLOYMENT_TTL_SECONDS,
  SPA_DEFAULT_CONFIG,
  TTL_CONSTRAINTS,
} from '@shipstatic/types';
import type { INodePropertyOptions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { ShipstaticApi } from '../credentials/ShipstaticApi.credentials';
import { API } from '../nodes/Shipstatic/api';
import {
  FILES_GRAMMAR,
  IDEMPOTENCY_HEADER,
  SHIP_JSON,
  Shipstatic,
  SPA_CONFIG,
  VIA,
  type WireError,
} from '../nodes/Shipstatic/Shipstatic.node';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const README = read('README.md');
const PKG = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>;
  files: string[];
  main: string;
  n8n: { nodes: string[]; credentials: string[] };
};

const node = new Shipstatic();

/**
 * The operation surface, pinned. Fifteen operations across three resources —
 * so a renamed or dropped value is a decision someone makes here, not a drift
 * that reaches a user's saved workflow as a value that no longer resolves.
 */
const CATALOGUE: Record<string, string[]> = {
  deployment: ['delete', 'deploy', 'get', 'list', 'set'],
  domain: ['delete', 'dns', 'get', 'list', 'records', 'set', 'share', 'validate', 'verify'],
  account: ['get'],
};

function operationOptions(resource: string): INodePropertyOptions[] {
  const prop = node.description.properties.find(
    (p) =>
      p.name === 'operation' &&
      (p.displayOptions?.show?.resource as string[] | undefined)?.includes(resource),
  );
  if (!prop) throw new Error(`no operation property declared for resource '${resource}'`);
  return (prop.options ?? []) as INodePropertyOptions[];
}

// ─── The platform's values, restated under duress ───────────────────────────

describe('restated platform facts', () => {
  it('the API base URL is the one @shipstatic/types owns', () => {
    expect(API).toBe(DEFAULT_API);
  });

  it('every console link is the URL types owns', () => {
    // `MY_API_KEY_URL` was written out in five files across three repos until
    // types 2.5.0-beta.21. This node cannot import it (the sandbox), so its
    // three prose copies — the rate-limit hint, the credential-gate message,
    // the credential description, plus the README — are held to the owner
    // here. Prose links rot silently, which is exactly what earns the fence.
    const node = readFileSync(join(ROOT, 'nodes/Shipstatic/Shipstatic.node.ts'), 'utf8');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const credential = new ShipstaticApi();

    expect(node).toContain(MY_API_KEY_URL);
    expect(readme).toContain(MY_API_KEY_URL);
    expect(String(credential.properties[0].description)).toContain(MY_API_KEY_URL);
  });

  it('every restated credential prefix is the one types owns', () => {
    // The prefixes are the node's last unfenced restatement, and they are
    // restated for the same reason everything else here is: n8n Cloud's
    // zero-dependency rule refuses the import syntactically, so the strings
    // are typed out in the credential placeholder, its description, and the
    // node's own gate message. `integrations/vscode` builds the identical
    // sentence FROM the constants — this fence is what buys this repo the
    // same guarantee without the import.
    //
    // Silent by construction, which is what earns it: a stale prefix reads
    // perfectly and simply tells a user to paste a credential the platform
    // classifies as OPAQUE and refuses. `token-` was the deploy prefix until
    // 2.0 and still appears in older docs, so this is drift with a precedent.
    const node = readFileSync(join(ROOT, 'nodes/Shipstatic/Shipstatic.node.ts'), 'utf8');
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const credential = new ShipstaticApi();
    const slot = credential.properties[0];

    expect(String(slot.placeholder)).toContain(API_KEY.PREFIX);
    expect(String(slot.placeholder)).toContain(DEPLOY_TOKEN.PREFIX);
    expect(String(slot.description)).toContain(DEPLOY_TOKEN.PREFIX);
    expect(node).toContain(DEPLOY_TOKEN.PREFIX);
    expect(readme).toMatch(new RegExp(`${API_KEY.PREFIX}|${DEPLOY_TOKEN.PREFIX}`));
  });

  it('the failure item can carry every wire error', () => {
    // `WireError` restates `ErrorResponse`'s shape — the sandbox forbids the
    // import in shipped code, so the suite proves assignability instead: a
    // reshaped wire error would fail to compile here, not quietly hand
    // workflows a wrong structure. (`tsconfig.check.json` covers tests, which
    // is what makes this line a fence rather than decoration.)
    const wire: WireError = {} as ErrorResponse;
    expect(wire).toBeDefined();
  });

  it('`via` is a member of the platform vocabulary', () => {
    // The server silently ignores a value outside the closed set, so a typo
    // here would cost analytics and fail nowhere. This is the failure.
    expect(VIA).toBe(DeploymentVia.N8N);
    expect(Object.values(DeploymentVia)).toContain(VIA);
  });

  it('the SPA routing config is the one the SDK injects', () => {
    // Every SDK-riding surface appends `SPA_DEFAULT_CONFIG`; this node restates
    // it because it may not import it. Two surfaces writing two different
    // rewrite rules is exactly the drift the fence table exists for.
    expect(SPA_CONFIG).toEqual(SPA_DEFAULT_CONFIG);
  });

  it('the config filename is the one the platform reads', () => {
    // It gates BOTH halves of the SPA mirror: whether the user already shipped
    // a config, and what the appended file is called. Drift would silently
    // break the escape hatch — the node would overwrite a `ship.json` it no
    // longer recognised.
    expect(SHIP_JSON).toBe(DEPLOYMENT_CONFIG_FILENAME);
  });

  it('the idempotency header is the one the platform reads', () => {
    // A header name has two ends, and the package that owns the format is the
    // only place both can read it from. Misspell it here and the key is
    // silently ignored — a retry deploys twice and nothing fails.
    expect(IDEMPOTENCY_HEADER).toBe(IDEMPOTENCY_KEY_CONSTRAINTS.HEADER);
  });

  it('every deploy sends that exact value', () => {
    // The constant could be right and unused. Proven end-to-end in the deploy
    // suite too; asserted here so the fence stands on its own.
    expect(VIA).toBe('n8n');
  });
});

// ─── The credential ─────────────────────────────────────────────────────────

describe('credential', () => {
  const credential = new ShipstaticApi();

  it('keeps the type id that names the platform', () => {
    // Renaming it would orphan every stored credential. The FIELD renamed in
    // the one-slot sweep; the type did not.
    expect(credential.name).toBe('shipstaticApi');
  });

  it('declares exactly one slot, named for what it holds', () => {
    // One slot means multiplicity is inexpressible — the same property the SDK
    // has. A second field would only let a user contradict themselves.
    expect(credential.properties).toHaveLength(1);
    expect(credential.properties[0].name).toBe('token');
  });

  it('sends that slot verbatim as a Bearer token', () => {
    // The node never inspects the prefix; the server classifies. The template
    // must therefore read the renamed field — a stale `$credentials.apiKey`
    // would resolve to undefined and send `Bearer undefined`.
    expect(credential.authenticate.properties.headers?.Authorization).toBe(
      '={{"Bearer " + $credentials.token}}',
    );
  });

  it('tests against the same API the node calls', () => {
    expect(credential.test.request.baseURL).toBe(API);
  });

  it('explains the 401 a deploy token will legitimately produce', () => {
    // A `deploy-` token is refused at the auth boundary with a 401
    // indistinguishable from a garbage credential, so the message has to be
    // honest about both readings.
    const rule = credential.test.rules?.[0];
    expect(rule?.properties.value).toBe(401);
    expect(rule?.properties.message).toMatch(/deploy token/i);
  });
});

// ─── The operation surface ──────────────────────────────────────────────────

describe('operation catalogue', () => {
  it('declares exactly fifteen operations across three resources', () => {
    const total = Object.values(CATALOGUE).reduce((n, ops) => n + ops.length, 0);
    expect(total).toBe(15);
  });

  for (const [resource, expected] of Object.entries(CATALOGUE)) {
    it(`${resource} exposes exactly [${expected.join(', ')}]`, () => {
      const values = operationOptions(resource).map((o) => o.value);
      expect(values.slice().sort()).toEqual(expected.slice().sort());
    });

    it(`${resource} lists its operations alphabetically by display name`, () => {
      // n8n renders options in array order and this repo's convention is
      // alphabetical, so "where does the new op go" has one answer.
      const names = operationOptions(resource).map((o) => o.name);
      expect(names).toEqual(names.slice().sort((a, b) => a.localeCompare(b)));
    });
  }

  it('speaks the platform verb: `delete`, never `remove`', () => {
    // The 2026-07 rename swept the SDK (`delete()`), the CLI (`ship … delete`)
    // and the MCP (`*_delete`). n8n was the last surface saying `remove`.
    const all = Object.keys(CATALOGUE).flatMap((r) => operationOptions(r).map((o) => o.value));
    expect(all).not.toContain('remove');
  });

  it('keeps the claim promise in the deploy op an agent reads', () => {
    // `usableAsTool: true` makes these descriptions the tool catalogue an LLM
    // reads, and the claim URL is the ONLY way a keyless deployment is ever
    // kept. The destructive hints were fenced; this promise was not.
    const deploy = operationOptions('deployment').find((o) => o.value === 'deploy');
    expect(deploy?.description).toMatch(/claim URL/i);
    expect(deploy?.description).toMatch(/show both to the user/i);
  });

  it('states the password range the platform owns, in both places it appears', () => {
    // `PASSWORD_CONSTRAINTS` owns these numbers — the GitHub Action derives the
    // same pair. Hand-written in the node's option copy and again in the
    // README, and until now compared to nothing.
    const range = `${PASSWORD_CONSTRAINTS.MIN_LENGTH}–${PASSWORD_CONSTRAINTS.MAX_LENGTH} characters`;
    const password = node.description.properties
      .flatMap((p) => (p.options ?? []) as INodePropertyOptions[])
      .find((o) => (o as unknown as { name: string }).name === 'password');

    expect((password as unknown as { description: string })?.description).toContain(range);
    expect(README).toContain(range);
  });

  it("the TTL field's floor is the one @shipstatic/types owns", () => {
    // `typeOptions.minValue` is a RESTATEMENT of `TTL_CONSTRAINTS.MIN_SECONDS`
    // — the one number this field states — so it is fenced like every other
    // forced copy. There is deliberately no `maxValue` to fence: the ceiling is
    // a year, unreachable by accident, and a silently-clamping spinner teaches
    // worse than the server's own refusal sentence.
    const ttl = node.description.properties
      .flatMap((p) => (p.options ?? []) as INodePropertyOptions[])
      .find((o) => (o as unknown as { name: string }).name === 'ttl');

    expect((ttl as unknown as { typeOptions?: { minValue?: number } })?.typeOptions?.minValue).toBe(
      TTL_CONSTRAINTS.MIN_SECONDS,
    );
  });

  it('the TTL field teaches the domain incompatibility', () => {
    // A LOCAL presence pin, and the reason it is local is recorded rather than
    // assumed. `PARAM_DESCRIPTIONS.ttl` in `@shipstatic/mcp` states the same
    // three facts, and a cross-repo prose fence against it was REFUSED: that
    // sentence is written for an LLM reading a tool catalogue, this one for a
    // person reading a field description in a browser. Same different-domains
    // reason this repo already records for `parseLabels` vs `deserializeLabels`
    // — and taking the dependency would drag the MCP SDK into this suite's
    // graph to fence one sentence.
    //
    // EXPIRY: if this description ever teaches a VALUE (a range, a ceiling),
    // that value gets fenced against `TTL_CONSTRAINTS`, which this file already
    // imports. Prose that teaches a number is a restatement; prose that teaches
    // a rule is this node's own voice.
    //
    // The clause is pinned because it is the one fact a user meets as a failure
    // rather than as a limit: this README's example workflow is
    // Deploy → Domain: Set, which is exactly the combination a TTL forbids.
    const ttl = node.description.properties
      .flatMap((p) => (p.options ?? []) as INodePropertyOptions[])
      .find((o) => (o as unknown as { name: string }).name === 'ttl');

    expect((ttl as unknown as { description: string })?.description).toContain(
      'cannot be linked to a custom domain',
    );
  });

  it('pins the Files (JSON) grammar — a LOCAL pin, and it says so', () => {
    // **This is a self-consistency pin, not an owner-compare, and the
    // difference is the whole reason it carries a comment this long.**
    //
    // `{ path, content, encoding? }` with a `utf-8` default has THREE holders:
    // the API's `jsonUploadSchema` (the wire original — same three names, same
    // two literals, same default), the hosted MCP's `FileSpec` (itself a
    // restatement of that), and this node. Three holders and silent drift is
    // exactly what the constellation law's stopping rule promotes, and the
    // owner is `@shipstatic/types` beside `DEPLOY_FIELDS`, whose MULTIPART half
    // already lives there — the JSON field names are the member that never got
    // promoted.
    //
    // It is not promoted YET because a constitution change moves as a full
    // constellation convoy, and the urgent problem is a broken public listing.
    // Coupling the fix to the convoy inverts the priorities.
    //
    // So this fence is honest about being weaker than the ones above it: it
    // catches a typo inside this repo and CANNOT catch the API changing its
    // wire names. EXPIRY: when types exports the grammar, this becomes a real
    // comparison and the local table goes away.
    expect(FILES_GRAMMAR.PATH).toBe('path');
    expect(FILES_GRAMMAR.CONTENT).toBe('content');
    expect(FILES_GRAMMAR.ENCODING).toBe('encoding');
    expect(FILES_GRAMMAR.DEFAULT_ENCODING).toBe('utf-8');
    expect([...FILES_GRAMMAR.ENCODINGS]).toEqual(['utf-8', 'base64']);

    // …and the field's own description must teach that grammar, because for a
    // `usableAsTool` node this text IS the tool catalogue an LLM reads. A
    // description that drifted from the parser would produce tool calls the
    // node then refuses.
    const files = node.description.properties.find((p) => p.name === 'files');
    const description = String(files?.description);
    for (const token of [FILES_GRAMMAR.PATH, FILES_GRAMMAR.CONTENT, ...FILES_GRAMMAR.ENCODINGS]) {
      expect(description).toContain(token);
    }
  });

  it('the README documents all three input modes and every 0.x break', () => {
    // The README is the only upgrade instruction a 0.x user gets, and one of
    // the four breaks it lists cannot be guarded in code (a stored-but-
    // undeclared `binaryData` is invisible to `getNodeParameter` — measured).
    // So for that one, this prose IS the mitigation, which is what earns it a
    // fence rather than a review.
    for (const mode of ['Binary Files', 'Text Content', 'Files (JSON)']) {
      expect(README).toContain(mode);
    }
    expect(README).toContain('## Upgrading from 0.x');
    for (const clause of [
      'Re-enter your credential',
      'Re-pick the operation',
      'Re-select your Deploy input mode',
      'Keyless deploys changed',
    ]) {
      expect(README).toContain(clause);
    }
  });

  it('the README teaches the files grammar it asks agents to produce', () => {
    for (const token of [FILES_GRAMMAR.PATH, FILES_GRAMMAR.CONTENT, 'base64']) {
      expect(README).toContain(token);
    }
  });

  it('offers exactly the three documented input modes', () => {
    // The selector that replaced 0.x's `binaryData` boolean. Pinned like the
    // operation catalogue and for the same reason: a renamed value reaches a
    // saved workflow as a mode that no longer resolves.
    const input = node.description.properties.find((p) => p.name === 'input');
    expect(((input?.options ?? []) as INodePropertyOptions[]).map((o) => o.value)).toEqual([
      'binary',
      'files',
      'text',
    ]);
    expect(input?.default).toBe('binary');
  });

  it('warns the agent before every destructive operation', () => {
    // `usableAsTool: true` means these descriptions ARE the tool catalogue an
    // LLM reads. Both deletes must carry the confirmation hint.
    for (const resource of ['deployment', 'domain']) {
      const del = operationOptions(resource).find((o) => o.value === 'delete');
      expect(del?.description).toMatch(/confirm with the user/i);
    }
  });
});

// ─── The published README ───────────────────────────────────────────────────

describe('README', () => {
  it('states every duration as the platform TTL, derived', () => {
    // The README ships in the tarball and renders on npm — for a human
    // deciding whether to install, it IS the product description, and nothing
    // else checks it. A TTL change turns this red until the prose follows.
    // The hyphen form is refused outright: one fact in two spellings is how
    // one of them goes stale.
    const expected = `${PUBLIC_DEPLOYMENT_TTL_SECONDS / 86_400} days`;
    const durations = README.match(/\b\d+ (?:day|hour)s?\b/g) ?? [];

    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) expect(d).toBe(expected);
    expect(README).not.toMatch(/\b\d+-(?:day|hour)/);
  });

  it('documents exactly the operations the node declares', () => {
    // A table row per operation: `| **Name** | description |`
    const documented = [...README.matchAll(/^\| \*\*([A-Za-z]+)\*\*/gm)].map((m) => m[1]);
    const declared = Object.keys(CATALOGUE).flatMap((r) => operationOptions(r).map((o) => o.name));

    expect(documented.slice().sort()).toEqual(declared.slice().sort());
  });

  it('teaches the one-slot credential vocabulary', () => {
    // `apiKey` was the 1.x credential field and `SHIP_API_KEY` the 1.x env
    // var; both were retired platform-wide. Prose may still say "API key" —
    // a `ship-` value IS one — but the retired identifiers may not appear.
    expect(README).not.toMatch(/SHIP_API_KEY|\bapiKey\b/);
  });

  it('never teaches the deleted agent-token mint', () => {
    expect(README).not.toMatch(/tokens\/agent|agent token/i);
  });
});

// ─── The artifact ───────────────────────────────────────────────────────────

describe('zero runtime dependencies', () => {
  it('declares none in the manifest', () => {
    // n8n Cloud verification requires it, and this node's identity is built on
    // it ("Direct HTTP — No SDK, No Dependencies"). Stated as a check rather
    // than remembered.
    expect(PKG.dependencies).toEqual({});
  });

  it('ships the two artifact trees, not whatever the build left in dist/', () => {
    // This said `['dist']` until 2026-08-19, and it was a value where an
    // invariant belonged. `@n8n/node-cli`'s `copyStaticFiles` globs
    // `**/*.{png,svg}` across the WHOLE REPO — ignoring only `dist` and
    // `node_modules` — and copies every match into `dist/`. So `pnpm coverage`
    // before a pack put `dist/coverage/favicon.png` and
    // `dist/coverage/sort-arrow-sprite.png` into the tarball, and the published
    // bytes depended on which untracked directories happened to exist at build
    // time. Measured by packing after a coverage run; `prepack` (added the same
    // day) makes local packing a sanctioned path, so the nondeterminism stopped
    // being theoretical.
    //
    // The fix is to enumerate the artifact rather than sweep a directory: a
    // stray asset can now land in `dist/` and still not ship.
    expect(PKG.files).toEqual(['dist/credentials', 'dist/nodes']);

    // …and the half that keeps the narrowing honest: every path the manifest
    // declares as an entry point must live inside a shipped tree. Narrowing
    // `files` without this could publish a package whose own `n8n` block points
    // at files it does not contain — installable, and broken at load.
    for (const entry of [PKG.main, ...PKG.n8n.nodes, ...PKG.n8n.credentials]) {
      expect(
        PKG.files.some((tree) => entry.startsWith(`${tree}/`)),
        `${entry} is declared by the manifest but is not inside any \`files\` entry`,
      ).toBe(true);
    }
  });

  it('the BUILT artifact is current — a stale one would certify the wrong bytes', () => {
    // `pnpm test` does not build. Without this, a local run certifies
    // yesterday's `dist/` while every other file tests today's source, which is
    // the precise shape of the bug the next assertion exists to catch: the
    // fence would pass on an artifact predating the very import that broke it.
    // Mirrors `integrations/vscode/tests/mcp-entry.test.ts`. CI is safe by
    // ordering (`pnpm build` precedes `pnpm coverage`); this is what makes the
    // local run trustworthy too.
    const artifacts = [...PKG.n8n.nodes, ...PKG.n8n.credentials].map((f) => join(ROOT, f));
    for (const artifact of artifacts) {
      expect(
        existsSync(artifact),
        `missing build — run \`pnpm build\` (expected ${artifact})`,
      ).toBe(true);
    }
    const builtAt = Math.min(...artifacts.map((f) => statSync(f).mtimeMs));

    // Every input that decides the emitted requires: the two shipped trees, the
    // tsconfig `tsc` reads, and the resolved dependency graph. The lockfile is
    // the one easiest to leave out and the one that matters most — a
    // devDependency promoted to a runtime import lands there first.
    const newest = (path: string): number => {
      const stat = statSync(path);
      if (!stat.isDirectory()) return stat.mtimeMs;
      return readdirSync(path).reduce((n, e) => Math.max(n, newest(join(path, e))), 0);
    };
    const sourcedAt = Math.max(
      ...['nodes', 'credentials', 'tsconfig.json', 'pnpm-lock.yaml'].map((p) =>
        newest(join(ROOT, p)),
      ),
    );

    expect(
      sourcedAt,
      'stale build — run `pnpm build`. The next assertion reads dist/, and its inputs have ' +
        'changed since it was built, so the run would certify bytes that no longer match the source.',
    ).toBeLessThanOrEqual(builtAt);
  });

  it('the BUILT artifact requires nothing but n8n-workflow and node builtins', () => {
    // The fence the manifest check cannot be: `n8n-node build` is a `tsc`
    // transpile, not a bundle, so every import in `nodes/` or `credentials/`
    // survives into `dist/` as a literal `require()`. A devDependency that
    // leaks into a value position would install fine here and be
    // MODULE_NOT_FOUND for every user. Proven over the bytes that ship.
    const ALLOWED = new Set(['n8n-workflow', 'node:crypto']);
    const entries = [...PKG.n8n.nodes, ...PKG.n8n.credentials];

    for (const entry of entries) {
      let source: string;
      try {
        source = read(entry);
      } catch {
        throw new Error(
          `${entry} is missing — run \`pnpm build\` before the suite. This fence reads the ` +
            'artifact, so an unbuilt tree must fail rather than skip.',
        );
      }
      const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
      expect(required.length).toBeGreaterThan(0);
      for (const mod of required) {
        if (mod.startsWith('./') || mod.startsWith('../')) continue;
        expect(ALLOWED, `${entry} requires '${mod}'`).toContain(mod);
      }
    }
  });
});
