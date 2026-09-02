import { archiveAll, MemoryArchive, type Archive } from './archive.js';
import { checkInvariants, type Violation } from './invariants.js';
import { Ledger, type LedgerEntry, type LedgerSink, type LedgerSummary } from './ledger.js';
import { currentTurnOf, prepare } from './normalize.js';
import { resolvePolicy, type Policy, type PolicyInput } from './policy.js';
import { protectedIds } from './protect.js';
import type { ReducerContext } from './reducers/context.js';
import { evict } from './reducers/evict.js';
import { expire } from './reducers/expire.js';
import { derivePlan, replay } from './reducers/replay.js';
import { resurface } from './reducers/resurface.js';
import { trim } from './reducers/trim.js';
import { truncate } from './reducers/truncate.js';
import { heuristicTokenizer, totalTokens, type Tokenizer } from './tokenizer.js';
import { isRaw, safeJson, type Item } from './types.js';

export interface KeepOptions {
  tokenizer?: Tokenizer;
  /** Defaults to a fresh in-memory archive per call. Pass one to keep it across calls. */
  archive?: Archive;
  /** Receives each ledger entry as it is written. */
  ledger?: LedgerSink;
  /** Monotonic call counter for the ledger. */
  call?: number;
  /** Clock for TTL expiry. Defaults to Date.now(). */
  now?: number;
  /** Throw on any invariant violation instead of degrading to a no-op. */
  strict?: boolean;
}

export interface KeepResult {
  /** The curated window, in provider-neutral form. */
  window: Item[];
  ledger: LedgerEntry[];
  summary: LedgerSummary;
  /** Raw items that were in the input and are not in the window in full. All are in the archive. */
  moved: Item[];
  violations: Violation[];
  policy: Policy;
}

export class InvariantError extends Error {
  override name = 'InvariantError';
  constructor(readonly violations: Violation[]) {
    super(`windowkeeper invariant violation: ${violations.map((v) => `[${v.invariant}] ${v.detail}`).join('; ')}`);
  }
}

/**
 * The whole core. Pure over its inputs; synchronous; zero dependencies.
 *
 * 1. prepare: copy, dedupe, link tool results, count tokens
 * 2. archive every raw item
 * 3. resurface: deterministic recall, recorded per user message and replayed
 * 4. expire: TTL
 * 5. replay the standing plan: same drops, stubs, and truncations as last time
 * 6. only if the replayed window is over `budget.max - reserve`: re-plan by
 *    truncating, evicting, and trimming to `budget.target`, and store the plan
 * 7. check invariants; write the summary
 */
export function keep(transcript: Item[], policyInput: PolicyInput | Policy = {}, options: KeepOptions = {}): KeepResult {
  const policy = resolvePolicy(policyInput);
  const tokenizer = options.tokenizer ?? heuristicTokenizer;
  const archive = options.archive ?? new MemoryArchive();
  const ledger = new Ledger(options.call ?? 1, options.ledger);
  const now = options.now ?? Date.now();

  const input = prepare(transcript, tokenizer);
  archiveAll(input, archive);
  const currentTurn = currentTurnOf(input);
  const ctx: ReducerContext = {
    policy,
    tokenizer,
    archive,
    ledger,
    currentTurn,
    now,
    protectedIds: protectedIds(input, policy, currentTurn),
  };

  const tokensBefore = totalTokens(input);
  const limit = policy.budget.max - policy.budget.reserve;

  let items = resurface(input, ctx);
  const beforeExpire = items;
  items = expire(items, ctx);
  const expiredAny = items !== beforeExpire;

  const replayResult = replay(items, archive.getPlan(), ctx);
  items = replayResult.items;

  const budgetTripped = totalTokens(items) > limit;
  if (budgetTripped) {
    items = truncate(items, ctx);
    items = evict(items, ctx);
    items = trim(items, ctx);
    if (totalTokens(items) > limit) {
      ledger.add({
        rule: 'budget.unshrinkable',
        action: 'violation',
        tokensAfter: totalTokens(items),
        detail: `protected items alone exceed the limit of ${limit} tokens; loosen protect.* or raise budget.max`,
      });
    }
  }

  const violations = checkInvariants({ input, output: items, policy, archive, ledger: ledger.entries, budgetTripped, expiredAny, replayed: replayResult.replayed });
  if (violations.length > 0) {
    if (options.strict) throw new InvariantError(violations);
    for (const v of violations) ledger.add({ rule: `invariant.${v.invariant}.${v.name}`, action: 'violation', detail: v.detail });
    items = input;
  }

  if (budgetTripped || archive.getPlan()) archive.setPlan(derivePlan(input, items, ledger.call));

  const summary: LedgerSummary = {
    call: ledger.call,
    rule: 'call',
    action: 'summary',
    tokensBefore,
    tokensAfter: totalTokens(items),
    budgetTripped,
    moved: ledger.moved,
    replayed: replayResult.replayed.size,
    recalled: ledger.recalled,
    prefixIntactToTurn: prefixIntactToTurn(input, items),
    tokenizer: tokenizer.name,
  };
  ledger.add(summary);

  const present = new Set(items.filter(isRaw).map((it) => it.id));
  const moved = input.filter((it) => isRaw(it) && !present.has(it.id));

  return { window: items, ledger: ledger.entries, summary, moved, violations, policy };
}

/** Deepest turn whose items are unchanged from the input, for cache reasoning. */
function prefixIntactToTurn(input: Item[], output: Item[]): number {
  let turn = 0;
  for (let i = 0; i < input.length && i < output.length; i++) {
    const a = input[i]!;
    const b = output[i]!;
    if (a.id !== b.id || safeJson(a) !== safeJson(b)) break;
    turn = a.turn;
  }
  return turn;
}
