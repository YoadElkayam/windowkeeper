import type { Plan } from '../archive.js';
import type { Item } from '../types.js';
import type { ReducerContext } from './context.js';
import { makeStub } from './evict.js';
import { truncateToolResult } from './truncate.js';

/**
 * Apply the standing plan from the last re-plan: the same items dropped, the
 * same tool results stubbed or truncated. No new decisions. Items that
 * re-surfacing protected this call are shown in full even if the plan moved
 * them; the next re-plan reconciles that.
 */
export function replay(items: Item[], plan: Plan | undefined, ctx: ReducerContext): { items: Item[]; replayed: Set<string> } {
  const replayed = new Set<string>();
  if (!plan) return { items, replayed };
  const dropped = new Set(plan.dropped);
  const evicted = new Set(plan.evicted);
  const truncated = new Set(plan.truncated);
  const { protectedIds } = ctx;

  const out: Item[] = [];
  for (const item of items) {
    if (protectedIds.has(item.id)) {
      out.push(item);
      continue;
    }
    if (dropped.has(item.id)) {
      replayed.add(item.id);
      continue;
    }
    if (item.kind === 'tool_result' && evicted.has(item.id)) {
      replayed.add(item.id);
      out.push(makeStub(item, ctx, 'evict'));
      continue;
    }
    if (item.kind === 'tool_result' && truncated.has(item.id) && !item.meta.truncated) {
      replayed.add(item.id);
      out.push(truncateToolResult(item, ctx));
      continue;
    }
    out.push(item);
  }
  if (replayed.size) {
    ctx.ledger.add({
      rule: 'plan.replay',
      action: 'replay',
      detail: `replayed the plan from call ${plan.call}: ${replayed.size} items already moved`,
    });
  }
  return { items: out, replayed };
}

/** Derive the plan to persist from what this call's window ended up showing. */
export function derivePlan(input: Item[], window: Item[], call: number): Plan {
  const shown = new Set<string>();
  const evicted: string[] = [];
  const truncated: string[] = [];
  for (const item of window) {
    if (item.kind === 'stub') {
      for (const ref of item.refs) {
        shown.add(ref);
        evicted.push(ref);
      }
      continue;
    }
    shown.add(item.id);
    if (item.kind === 'tool_result' && item.meta.truncated) truncated.push(item.id);
  }
  const dropped: string[] = [];
  for (const item of input) {
    if (item.kind === 'recalled' || item.kind === 'view') continue;
    if (!shown.has(item.id)) dropped.push(item.id);
  }
  return { call, evicted, truncated, dropped };
}
