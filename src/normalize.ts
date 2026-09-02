import { countItem, type Tokenizer } from './tokenizer.js';
import type { Item, ToolResultItem } from './types.js';

/**
 * Assign turn numbers. Leading system items are turn 0. The counter starts at 1
 * and increments after every assistant item, so one turn is one model call.
 * Adapters call this after building items.
 */
export function assignTurns<T extends { kind: Item['kind']; turn: number }>(items: T[]): T[] {
  let turn = 1;
  let leading = true;
  for (const item of items) {
    if (item.kind === 'system' && leading) {
      item.turn = 0;
      continue;
    }
    leading = false;
    item.turn = turn;
    if (item.kind === 'assistant') turn++;
  }
  return items;
}

/**
 * Fill `tool` and `args` on tool results from the matching tool_use, so the
 * archive can index repeat calls and stubs can name the tool.
 */
export function link(items: Item[]): void {
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const item of items) {
    if (item.kind === 'assistant') {
      for (const b of item.blocks) {
        if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input });
      }
    } else if (item.kind === 'tool_result') {
      const call = calls.get(item.callId);
      if (call) {
        item.tool = call.name;
        item.args = call.input;
      }
    }
  }
}

/** Deep-copy, de-duplicate by id, link tool results, and count tokens. */
export function prepare(items: Item[], tokenizer: Tokenizer): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const copy = structuredClone(item);
    out.push(copy);
  }
  link(out);
  for (const item of out) item.meta.tokens = countItem(item, tokenizer);
  return out;
}

export function currentTurnOf(items: Item[]): number {
  let max = 0;
  for (const item of items) if (item.turn > max) max = item.turn;
  return max;
}

export function lastIndexOfKind(items: Item[], kind: Item['kind']): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === kind) return i;
  return -1;
}

export function isToolResultLike(item: Item): item is ToolResultItem | (Item & { kind: 'stub'; callId: string }) {
  return item.kind === 'tool_result' || (item.kind === 'stub' && typeof item.callId === 'string');
}
