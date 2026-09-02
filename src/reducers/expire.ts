import { groupUnits } from '../protect.js';
import type { Item } from '../types.js';
import type { ReducerContext } from './context.js';
import { makeStub } from './evict.js';

/**
 * Items past their TTL leave the window. An expired tool result becomes a stub
 * in place so its tool call stays paired. An expired user or assistant item
 * leaves with its unit (an assistant takes its tool results along). System
 * items and protected items never expire.
 */
export function expire(items: Item[], ctx: ReducerContext): Item[] {
  const { now, ledger, protectedIds } = ctx;
  const isExpired = (item: Item) =>
    item.meta.ttl !== undefined && item.meta.ttl <= now && item.kind !== 'system' && !protectedIds.has(item.id);

  if (!items.some(isExpired)) return items;

  // Pass 1: expired tool results become stubs in place.
  const out: Item[] = items.map((item) => {
    if (item.kind !== 'tool_result' || !isExpired(item)) return item;
    const stub = makeStub(item, ctx, 'expire');
    ledger.add({ rule: 'ttl', action: 'expire', item: item.id, refs: [item.id], tokensBefore: item.meta.tokens, tokensAfter: stub.meta.tokens, detail: 'stubbed in place' });
    return stub;
  });

  // Pass 2: units whose head expired leave entirely.
  const drop = new Set<number>();
  for (const unit of groupUnits(out)) {
    const head = out[unit.indices[0]!]!;
    if (head.kind === 'tool_result' || head.kind === 'stub' || !isExpired(head)) continue;
    // A unit that holds a protected item (a pinned tool result, say) cannot leave without orphaning it.
    if (unit.ids.some((id) => protectedIds.has(id))) continue;
    for (const i of unit.indices) {
      drop.add(i);
      const it = out[i]!;
      ledger.add({
        rule: 'ttl',
        action: 'expire',
        item: it.kind === 'stub' ? it.refs[0]! : it.id,
        refs: it.kind === 'stub' ? it.refs : [it.id],
        tokensBefore: it.meta.tokens,
        detail: i === unit.indices[0] ? 'expired' : 'left with its expired assistant',
      });
    }
  }
  return drop.size ? out.filter((_, i) => !drop.has(i)) : out;
}
