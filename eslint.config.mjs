// ESLint survives here, and it is NOT a second linter.
//
// The platform's tooling standard is Biome — one tool for lint and format, in
// every repo (`biome.jsonc`, root `CLAUDE.md` "Tooling Standard"). This file
// runs `@n8n/node-cli`'s preset for one reason Biome cannot cover: it carries
// `@n8n/eslint-plugin-community-nodes`, the ruleset n8n Cloud VERIFICATION is
// judged against. That is a contract with an external party, delivered as a
// plugin — the same category as the vscode repo's `bundle-integrity.mjs`, and
// a fence rather than a style preference.
//
// It is load-bearing, not ceremonial. Two of this rewrite's design decisions
// were caught here and nowhere else:
//
//   • `no-restricted-globals` bans `process`. That list IS the community-node
//     sandbox contract — reading `process.env` at module load would be a
//     ReferenceError on n8n Cloud, not a lint warning — which is why the API
//     base URL is a plain constant and the environment dimension lives in the
//     test harness instead (see `nodes/Shipstatic/api.ts`).
//   • `no-restricted-imports` refuses any non-relative import in shipped code,
//     matching syntactically, so even an `import type` that provably erases is
//     rejected. That is why `@shipstatic/types` is a devDependency the SUITE
//     imports and the node restates, with `tests/contract.test.ts` comparing
//     the copies.
//
// Formatting is Biome's alone; nothing here should report a style opinion.
import { config } from '@n8n/node-cli/eslint';

export default [
  ...config,
  {
    // Nothing here ships — `files: ["dist"]` publishes the build alone.
    ignores: ['coverage/**', 'dist/**'],
  },
  {
    // The suite and its config are not the artifact. The sandbox contract and
    // the zero-dependency rule govern what SHIPS — neither of these ever does,
    // and the suite exists precisely to import the platform values the node
    // may not.
    files: ['tests/**', 'vitest.config.ts'],
    rules: {
      '@n8n/community-nodes/no-restricted-imports': 'off',
      '@n8n/community-nodes/no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
