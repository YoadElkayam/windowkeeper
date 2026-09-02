/**
 * Policy is data. A harness ships a default, a user overrides a few keys, and
 * the same object drives the SDK middleware, the CLI, and the proxy.
 */

export interface Policy {
  budget: {
    /** Hard ceiling on window tokens, including reserve. */
    max: number;
    /** Where to land when `max - reserve` is crossed. */
    target: number;
    /** Headroom for the reply. The trigger fires at `max - reserve`. */
    reserve: number;
  };
  protect: {
    /** The last N user items and everything after them are untouchable. */
    latestUserTurns: number;
    /** Items from the last N turns are never evicted, folded, or trimmed. */
    recentTurns: number;
    pinned: boolean;
    /** Items carrying any of these tags are never evicted, folded, or trimmed. */
    tags: string[];
  };
  toolResults: {
    /** Truncate any tool result above this many tokens. 0 disables. */
    maxTokensEach: number;
    headTokens: number;
    tailTokens: number;
    /** Evict tool results older than this many turns to stubs. 0 disables. */
    evictAfterTurns: number;
    /** Never evict error results; the model may still be reasoning about them. */
    keepErrors: boolean;
    /** Keep the N most recent results per tool name in full. */
    keepLatestPerTool: number;
    /** Tools whose repeated calls must never be served from the archive. */
    volatile: string[];
  };
  resurface: {
    /** Match identifiers in the latest user message against the archive. */
    identifiers: boolean;
    /** Serve an identical repeated tool call from the archive (middleware only). */
    repeatToolCalls: boolean;
    /** Upper bound on items brought back per call. */
    maxItems: number;
    /** Cap on tokens per re-surfaced item; longer ones are truncated with a marker. */
    maxTokensEach: number;
  };
  cache: {
    /** Apply all eligible evictions in one batch rather than the minimum needed. */
    batchEvictions: boolean;
  };
}

export type PolicyInput = DeepPartial<Policy>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

/** Realistic defaults for a coding agent on a 200k model. */
export const DEFAULT_POLICY: Policy = {
  budget: { max: 160_000, target: 110_000, reserve: 16_000 },
  protect: { latestUserTurns: 1, recentTurns: 6, pinned: true, tags: ['decision', 'requirement'] },
  toolResults: {
    maxTokensEach: 4000,
    headTokens: 2400,
    tailTokens: 800,
    evictAfterTurns: 8,
    keepErrors: true,
    keepLatestPerTool: 1,
    volatile: ['bash', 'shell', 'exec', 'fetch', 'http', 'curl', 'now', 'date'],
  },
  resurface: { identifiers: true, repeatToolCalls: true, maxItems: 4, maxTokensEach: 2000 },
  cache: { batchEvictions: true },
};

export class PolicyError extends Error {
  override name = 'PolicyError';
}

/** Merge a partial policy over the defaults and validate the result. */
export function resolvePolicy(input: PolicyInput = {}): Policy {
  const p: Policy = {
    budget: { ...DEFAULT_POLICY.budget, ...input.budget },
    protect: { ...DEFAULT_POLICY.protect, ...input.protect },
    toolResults: { ...DEFAULT_POLICY.toolResults, ...input.toolResults },
    resurface: { ...DEFAULT_POLICY.resurface, ...input.resurface },
    cache: { ...DEFAULT_POLICY.cache, ...input.cache },
  };
  validatePolicy(p);
  return p;
}

export function validatePolicy(p: Policy): void {
  const { budget, protect, toolResults, resurface } = p;
  if (budget.max <= 0) throw new PolicyError('budget.max must be positive');
  if (budget.reserve < 0 || budget.reserve >= budget.max)
    throw new PolicyError('budget.reserve must be between 0 and budget.max');
  if (budget.target <= 0 || budget.target > budget.max - budget.reserve)
    throw new PolicyError('budget.target must be positive and at most budget.max - budget.reserve');
  if (protect.latestUserTurns < 1) throw new PolicyError('protect.latestUserTurns must be at least 1');
  if (protect.recentTurns < 0) throw new PolicyError('protect.recentTurns must be non-negative');
  if (toolResults.maxTokensEach < 0) throw new PolicyError('toolResults.maxTokensEach must be non-negative');
  if (toolResults.maxTokensEach > 0 && toolResults.headTokens + toolResults.tailTokens >= toolResults.maxTokensEach)
    throw new PolicyError('toolResults.headTokens + tailTokens must be below maxTokensEach');
  if (toolResults.evictAfterTurns < 0) throw new PolicyError('toolResults.evictAfterTurns must be non-negative');
  if (toolResults.keepLatestPerTool < 0) throw new PolicyError('toolResults.keepLatestPerTool must be non-negative');
  if (resurface.maxItems < 0) throw new PolicyError('resurface.maxItems must be non-negative');
  if (resurface.maxTokensEach <= 0) throw new PolicyError('resurface.maxTokensEach must be positive');
}
