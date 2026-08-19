import { defineConfig } from 'vitest/config';

/**
 * One project. The node has one runtime (n8n's Node process) and one
 * collaborator (n8n's request helpers) — the tier split a larger suite needs
 * would be several names for the same thing here.
 *
 * `tests/live.test.ts` is the exception, and it excludes ITSELF: it drives the
 * same `execute()` against a real API and skips unless `SHIP_API_URL` and a
 * token are present, so it never runs in CI and never needs a second config.
 */
export default defineConfig({
  test: {
    // Mock hygiene as config rather than per-file boilerplate: call history
    // clears before every test, so an assertion can never pass on a previous
    // test's calls.
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Only what ships. `tests/**` is instrumentation, and counting it would
      // let the suite raise its own score.
      include: ['nodes/**/*.ts', 'credentials/**/*.ts'],
      /**
       * The 2026-08-07 measurement, held. A ratchet — raised, never lowered.
       *
       * Statements, functions and lines sit at 100 and stay there: the whole
       * shipped surface is three files driven through a mock of the n8n helper
       * contract, so there is no in-process blind corner. An operation that
       * arrives without a test fails the run.
       *
       * BRANCHES is 98.2 for exactly three arms, named rather than rounded
       * away — the implicit `else` on each of the three `operation` chains in
       * `execute()` (deployment, domain, account). They are unreachable through
       * the real collaborator: n8n only ever passes a value from the `options`
       * array it rendered, and `tests/contract.test.ts` pins that array. The
       * fractional floor is deliberate — one more uncovered arm costs well
       * under a point, so an integer floor would let it through.
       *
       * Raised from 97.7 on 2026-08-07 with the pagination / SPA / typed-error
       * wave: a ratchet that is not raised when coverage rises is a floor the
       * next gains erode back through.
       *
       * It moved 98.2 → 98.18 → 98.2 across that wave, and the dip was NOT decay — the uncovered set
       * is byte-identical, still those three arms. Deleting the SPA index-size
       * guard removed two COVERED arms, which shrinks the denominator and
       * lowers the ratio while improving the code. Worth naming because it is
       * the instrument's blind spot: a percentage answers "what fraction is
       * covered", and the invariant actually being held here is "exactly three
       * arms, and they are these three". When the two disagree, the enumerated
       * arms are the claim; the number is only how it is enforced.
       *
       * Raised 98.2 → 98.22 on 2026-08-19 with the TTL option (T1): 164/167
       * became 166/169. The uncovered SET did not move — still exactly the
       * three `operation` chain `else` arms — but adding two covered branches
       * grew the denominator, so the ratio rose and the floor rises with it.
       * That is the ratchet working in the direction the wobble above went in
       * reverse: re-measure and re-raise every time, or the next regression
       * hides in the slack the last improvement created.
       *
       * Raised again 98.22 → 98.62 the same day with Files (JSON) mode (T2):
       * 215/218. **And here the ratchet did the job the enumeration exists
       * for.** T2's first pass measured 98.14 with FOUR uncovered arms, so the
       * floor refused it. The fourth was not a missing test — it was an
       * `Array.isArray(parsed) ? 'array' : …` arm written inside a block
       * already guarded by `!Array.isArray(parsed)`, unreachable by
       * construction. A percentage alone would have invited a test for it; the
       * enumerated-arms invariant said "these three, and they are these", so
       * the honest fix was deleting the dead arm. Coverage caught dead code,
       * which is not what coverage is usually for.
       *
       * 98.62 → 98.64 with the attached-but-empty credential refusal
       * (219/222), same three arms.
       *
       * 98.64 → 98.63 (217/220) with the `runOperation` extraction, and this
       * one is a DIP rather than a raise — the second in this file's history,
       * and the same cause as the first. Extracting the dispatch let the
       * strict path drop its try/catch entirely (a bare re-throw is refused by
       * the verification scanner's ruleset, which ignores inline disables), so
       * two COVERED branches disappeared: the per-item `continueOnFail` check
       * and the `instanceof` guard that used to attach `itemIndex` at the
       * catch. The uncovered set did not move — still exactly those three
       * `else` arms, now living inside `runOperation`. Lowering the number
       * while the invariant holds is the ratchet's own rule, not an exception
       * to it: the enumerated arms are the claim.
       *
       * NOTE: thresholds catch coverage DECAY. They cannot catch a test that
       * asserts nothing; a tautology neither raises nor lowers coverage. The
       * fences in `tests/contract.test.ts` are what hold the contracts a
       * percentage cannot see.
       */
      thresholds: {
        statements: 100,
        branches: 98.63,
        functions: 100,
        lines: 100,
      },
    },
  },
});
