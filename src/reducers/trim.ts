import { groupUnits } from '../protect.js';
import { totalTokens } from '../tokenizer.js';
import type { Item } from '../types.js';
import type { ReducerContext } from './context.js';

/**
 * Last resort when truncation and eviction were not enough: whole units leave
 * the window, oldest and cheapest kind first, until the total is at or below
 * `budget.target`. Nothing is deleted; every item is in the archive.
 */
export function trim(items: Item[], ctx: ReducerContext): Item[] {
  const { policy, ledger, protectedIds } = ctx;
  let total = totalTokens(items);
  if (total <= policy.budget.target) return items;

  const candidates = groupUnits(items)
    .filter((u) => !u.ids.some((id) => protectedIds.has(id)))
    .sort((a, b) => a.turn - b.turn || a.weight - b.weight || a.indices[0]! - b.indices[0]!);

  const drop = new Set<number>();
  for (const unit of candidates) {
    if (total <= policy.budget.target) break;
    for (const i of unit.indices) drop.add(i);
    total -= unit.tokens;
    for (const i of unit.indices) {
      const it = items[i]!;
      ledger.add({
        rule: 'budget.target',
        action: 'trim',
        item: it.id,
        refs: it.kind === 'stub' ? it.refs : it.kind === 'recalled' ? [it.ref] : [it.id],
        tokensBefore: it.meta.tokens,
        detail: `${it.kind} at turn ${it.turn}`,
      });
    }
  }
  if (drop.size === 0) return items;
  return items.filter((_, i) => !drop.has(i));
}
