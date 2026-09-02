import { stubId } from '../ids.js';
import { countItem } from '../tokenizer.js';
import type { Item, StubItem, ToolResultItem } from '../types.js';
import type { ReducerContext } from './context.js';

/**
 * Tool results older than `toolResults.evictAfterTurns` become stubs in place.
 * The stub keeps the call id so the tool_use stays paired, names the tool and
 * turn, and carries the archive id so the model can recall it.
 *
 * Exempt: protected items, error results when `keepErrors`, and the most recent
 * `keepLatestPerTool` results of each tool.
 */
export function evict(items: Item[], ctx: ReducerContext): Item[] {
  const { policy, ledger, currentTurn, protectedIds } = ctx;
  const after = policy.toolResults.evictAfterTurns;
  if (after <= 0) return items;

  const latestPerTool = new Map<string, number>();
  const keepLatest = new Set<string>();
  if (policy.toolResults.keepLatestPerTool > 0) {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.kind !== 'tool_result') continue;
      const tool = item.tool ?? '';
      const n = latestPerTool.get(tool) ?? 0;
      if (n < policy.toolResults.keepLatestPerTool) {
        keepLatest.add(item.id);
        latestPerTool.set(tool, n + 1);
      }
    }
  }

  let changed = false;
  const out = items.map((item) => {
    if (item.kind !== 'tool_result') return item;
    if (protectedIds.has(item.id) || keepLatest.has(item.id)) return item;
    if (item.isError && policy.toolResults.keepErrors) return item;
    if (currentTurn - item.turn <= after) return item;
    changed = true;
    const stub = makeStub(item, ctx, 'evict');
    ledger.add({
      rule: 'toolResults.evictAfterTurns',
      action: 'evict',
      item: item.id,
      refs: [item.id],
      tokensBefore: item.meta.tokens,
      tokensAfter: stub.meta.tokens,
      detail: `${item.tool ?? 'tool'} at turn ${item.turn}, age ${currentTurn - item.turn}`,
    });
    return stub;
  });
  return changed ? out : items;
}

export function makeStub(item: ToolResultItem, ctx: ReducerContext, reason: 'evict' | 'expire'): StubItem {
  const tool = item.tool ?? 'tool';
  const why = reason === 'expire' ? 'expired from the window' : 'moved out of the window';
  // Name the archived size, not the size of a possibly truncated copy, so the stub text
  // is identical whether it was made fresh or replayed.
  const fullTokens = ctx.archive.get(item.id)?.meta.tokens ?? item.meta.tokens;
  const stub: StubItem = {
    kind: 'stub',
    id: stubId(item.id),
    refs: [item.id],
    callId: item.callId,
    turn: item.turn,
    text: `[windowkeeper] ${tool} result from turn ${item.turn} (${fullTokens} tokens) ${why}; archived as ${item.id}. Use recall({ id: "${item.id}" }) to read it, or run the tool again.`,
    meta: { tokens: 0, pinned: false, tags: [], source: reason },
  };
  if (item.tool) stub.tool = item.tool;
  stub.meta.tokens = countItem(stub, ctx.tokenizer);
  return stub;
}
