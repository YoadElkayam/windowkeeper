import type { Policy } from './policy.js';
import type { Item } from './types.js';

/**
 * The protected set: ids that no reducer may evict, fold, or trim.
 *
 * - system items, always
 * - pinned items, when policy.protect.pinned
 * - items carrying a protected tag
 * - items from the last `recentTurns` turns
 * - the last `latestUserTurns` user items and everything after them
 */
export function protectedIds(items: Item[], policy: Policy, currentTurn: number): Set<string> {
  const out = new Set<string>();
  const tags = new Set(policy.protect.tags);
  const recentFrom = currentTurn - policy.protect.recentTurns + 1;

  let userSeen = 0;
  let latestUserIndex = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'user') {
      userSeen++;
      latestUserIndex = i;
      if (userSeen === policy.protect.latestUserTurns) break;
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (
      item.kind === 'system' ||
      (policy.protect.pinned && item.meta.pinned) ||
      item.meta.tags.some((t) => tags.has(t)) ||
      item.turn >= recentFrom ||
      i >= latestUserIndex
    ) {
      out.add(item.id);
    }
  }
  return out;
}

/**
 * A unit is the smallest group that can leave the window without orphaning a
 * tool call: an assistant item plus every tool result or stub answering its
 * tool_use blocks. Everything else is a unit of one.
 */
export interface Unit {
  indices: number[];
  ids: string[];
  turn: number;
  /** Lower leaves first. */
  weight: number;
  tokens: number;
}

const WEIGHT: Record<Item['kind'], number> = {
  tool_result: 0,
  stub: 0,
  recalled: 1,
  view: 1,
  assistant: 2,
  user: 3,
  system: 9,
};

export function groupUnits(items: Item[]): Unit[] {
  const units: Unit[] = [];
  const callToUnit = new Map<string, Unit>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const callId = item.kind === 'tool_result' ? item.callId : item.kind === 'stub' ? item.callId : undefined;
    const owner = callId ? callToUnit.get(callId) : undefined;
    if (owner) {
      owner.indices.push(i);
      owner.ids.push(item.id);
      owner.tokens += item.meta.tokens;
      continue;
    }
    const unit: Unit = {
      indices: [i],
      ids: [item.id],
      turn: item.turn,
      weight: WEIGHT[item.kind],
      tokens: item.meta.tokens,
    };
    units.push(unit);
    if (item.kind === 'assistant') {
      for (const b of item.blocks) if (b.type === 'tool_use') callToUnit.set(b.id, unit);
    }
  }
  return units;
}
