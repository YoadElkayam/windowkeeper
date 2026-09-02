import { countItem, sliceByTokens } from '../tokenizer.js';
import { blocksText, type Block, type Item, type ToolResultItem } from '../types.js';
import type { ReducerContext } from './context.js';

/**
 * Tool results above `toolResults.maxTokensEach` keep their head and tail; the
 * middle is replaced by a marker carrying the omitted count and the archive id.
 * The current turn's results are exempt: the model must see what it just asked
 * for. Pinned items are exempt.
 */
export function truncate(items: Item[], ctx: ReducerContext): Item[] {
  const { policy, tokenizer, ledger, currentTurn } = ctx;
  const cap = policy.toolResults.maxTokensEach;
  if (cap <= 0) return items;
  let changed = false;
  const out = items.map((item) => {
    if (item.kind !== 'tool_result' || (policy.protect.pinned && item.meta.pinned) || item.meta.truncated) return item;
    if (item.turn >= currentTurn) return item;
    if (item.meta.tokens <= cap) return item;
    const truncated = truncateToolResult(item, ctx);
    changed = true;
    ledger.add({
      rule: 'toolResults.maxTokensEach',
      action: 'truncate',
      item: item.id,
      refs: [item.id],
      tokensBefore: item.meta.tokens,
      tokensAfter: truncated.meta.tokens,
      detail: `${item.tool ?? 'tool'} at turn ${item.turn}; kept head ${policy.toolResults.headTokens} + tail ${policy.toolResults.tailTokens}`,
    });
    return truncated;
  });
  return changed ? out : items;
}

export function truncateToolResult(item: ToolResultItem, ctx: ReducerContext): ToolResultItem {
  const { policy, tokenizer } = ctx;
  const text = blocksText(item.blocks.filter((b) => b.type !== 'image'));
  const head = sliceByTokens(text, policy.toolResults.headTokens, 'head', tokenizer);
  const tail = sliceByTokens(text, policy.toolResults.tailTokens, 'tail', tokenizer);
  const omitted = Math.max(0, tokenizer.count(text) - tokenizer.count(head) - tokenizer.count(tail));
  const marker = `\n[windowkeeper] ${omitted} tokens omitted here; the full result is archived as ${item.id}. Use recall({ id: "${item.id}" }) to read it.\n`;
  const images: Block[] = item.blocks.filter((b) => b.type === 'image');
  const blocks: Block[] = [{ type: 'text', text: head + marker + tail }, ...images];
  const next: ToolResultItem = {
    ...item,
    blocks,
    meta: { ...item.meta, truncated: true, tokens: 0 },
  };
  next.meta.tokens = countItem(next, tokenizer);
  return next;
}
