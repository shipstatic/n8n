/**
 * The API base URL — one fact with two readers (every request this node makes,
 * and the credential's connection test), so it is owned here rather than
 * stated twice.
 *
 * **Production, and nothing else.** Published artifacts name the product, not
 * an environment (root `CLAUDE.md`, "Environment-Aware URLs"), and this node
 * has no runway for the usual `SHIP_API_URL` parametrization the SDK and CLI
 * honor: `@n8n/community-nodes/no-restricted-globals` bans `process` outright,
 * and that rule is the n8n Cloud SANDBOX contract, not a style preference —
 * reading `process.env` here would be a ReferenceError before the node loads,
 * taking every operation with it, not just the override.
 *
 * The environment dimension therefore belongs to the harness, not the
 * artifact: `tests/live.test.ts` substitutes this module to point the same
 * `execute()` at a non-production API. This file being the sole owner of the
 * fact is what makes that seam a one-line mock instead of a fork.
 *
 * The value is a restatement of `DEFAULT_API` in `@shipstatic/types`, forced
 * by the same zero-import rule — so `tests/contract.test.ts` compares the two.
 */
export const API = 'https://api.shipstatic.com';
