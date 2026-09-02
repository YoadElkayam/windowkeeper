import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryArchive } from '../src/archive.js';
import { keep } from '../src/keep.js';
import { policyArb, transcriptArb } from './fixtures.js';

/**
 * The conformance battery. Every generated transcript, under every generated
 * policy, must satisfy all checkable invariants (strict mode throws otherwise)
 * and must be deterministic.
 */
describe('invariants (property)', () => {
  it('hold for generated transcripts and policies', () => {
    fc.assert(
      fc.property(transcriptArb, policyArb, (items, policy) => {
        const archive = new MemoryArchive();
        const a = keep(items, policy, { archive, strict: true, now: 5 });
        const b = keep(items, policy, { archive, strict: true, now: 5 });
        expect(JSON.stringify(a.window)).toBe(JSON.stringify(b.window));
        expect(JSON.stringify(a.ledger)).toBe(JSON.stringify(b.ledger));
        // When the budget tripped and nothing was declared unshrinkable, the window is under the limit.
        if (a.summary.budgetTripped && !a.ledger.some((e) => e.rule === 'budget.unshrinkable')) {
          expect(a.summary.tokensAfter).toBeLessThanOrEqual(policy.budget.max - policy.budget.reserve);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('keep the archive as the truth across repeated calls with a growing transcript', () => {
    fc.assert(
      fc.property(transcriptArb, policyArb, (items, policy) => {
        const archive = new MemoryArchive();
        for (let n = 1; n <= items.length; n++) {
          keep(items.slice(0, n), policy, { archive, strict: true, now: 5, call: n });
        }
        for (const it of items) expect(archive.has(it.id)).toBe(true);
      }),
      { numRuns: 40 },
    );
  });
});
