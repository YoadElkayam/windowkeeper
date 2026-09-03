import type { Plan } from '../archive.js';
import { archiveRef } from '../ids.js';
import { groupUnits } from '../protect.js';
import type { Item } from '../types.js';
import type { ReducerContext } from './context.js';
import { makeStub } from './evict.js';
import { truncateToolResult } from './truncate.js';

/**
 * Apply the standing plan from the last re-plan: the same items dropped, the
 * same tool results stubbed or truncated. No new decisions.
 *
 * Items are matched by archive reference, so a stub already standing in for a
 * dropped result is dropped with it. A unit that holds an item re-surfacing
 * protected this call is never dropped, so a kept tool result keeps its call.
 */
export function replay(items: Item[], plan: Plan | undefined, ctx: ReducerContext): { items: Item[]; replayed: Set<string> } {
  const replayed = new Set<string>();
  if (!plan) return { items, replayed };
  const dropped = new Set(plan.dropped);
  const evicted = new Set(plan.evicted);
  const truncated = new Set(plan.truncated);
  const { protectedIds } = ctx;

  const undroppable = new Set<number>();
  for (const unit of groupUnits(items)) {
    if (unit.ids.some((id) => protectedIds.has(id) || protectedIds.has(archiveRefOf(items, id)))) {
      for (const i of unit.indices) undroppable.add(i);
    }
  }

  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const ref = archiveRef(item);
    // Protection gates drops and evictions, exactly as it does in trim and evict.
    // Truncation is gated only by pinning, exactly as it is in truncate.
    const isProtected = protectedIds.has(item.id) || protectedIds.has(ref);
    if (dropped.has(ref) && !undroppable.has(i) && !isProtected) {
      replayed.add(ref);
      continue;
    }
    if (item.kind === 'tool_result' && evicted.has(ref) && !isProtected) {
      replayed.add(ref);
      out.push(makeStub(item, ctx, 'evict'));
      continue;
    }
    if (item.kind === 'tool_result' && truncated.has(ref) && !item.meta.truncated && !(ctx.policy.protect.pinned && item.meta.pinned)) {
      replayed.add(ref);
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

function archiveRefOf(items: Item[], id: string): string {
  const item = items.find((it) => it.id === id);
  return item ? archiveRef(item) : id;
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
    if (!shown.has(archiveRef(item))) dropped.push(archiveRef(item));
  }
  return { call, evicted, truncated, dropped };
}
