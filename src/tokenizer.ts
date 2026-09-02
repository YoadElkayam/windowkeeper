import { type Block, type Item, itemText } from './types.js';

/**
 * Token counting is pluggable. The heuristic is honest about being a heuristic:
 * its name lands in the ledger so nobody mistakes its numbers for billing.
 *
 * To plug a real tokenizer:
 *
 *   import { countTokens } from '@anthropic-ai/tokenizer';
 *   const anthropic: Tokenizer = { name: 'anthropic', count: countTokens };
 *
 *   import { encodingForModel } from 'js-tiktoken';
 *   const enc = encodingForModel('gpt-4o');
 *   const openai: Tokenizer = { name: 'openai', count: (t) => enc.encode(t).length };
 */
export interface Tokenizer {
  name: string;
  count(text: string): number;
  /** Tokens charged for one image block. Defaults to 1500 when absent. */
  imageTokens?: number;
}

const IMAGE_TOKENS = 1500;

/**
 * Blend of word and character estimates. Word-based undercounts code and
 * punctuation-heavy text; char-based overcounts prose. The average tracks real
 * tokenizers within roughly ten percent on mixed agent transcripts.
 */
export const heuristicTokenizer: Tokenizer = {
  name: 'heuristic',
  count(text: string): number {
    if (!text) return 0;
    const words = text.split(/\s+/).filter(Boolean).length;
    const chars = text.length;
    return Math.ceil((words * 1.3 + chars / 4) / 2);
  },
};

export function countItem(item: Item, tokenizer: Tokenizer): number {
  let images = 0;
  const blocks: Block[] | undefined =
    item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool_result'
      ? item.blocks
      : undefined;
  if (blocks) {
    for (const b of blocks) {
      if (b.type === 'image') images++;
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const inner of b.content) if (inner.type === 'image') images++;
      }
    }
  }
  // Small fixed overhead per item for role and framing tokens.
  return tokenizer.count(itemText(item)) + images * (tokenizer.imageTokens ?? IMAGE_TOKENS) + 4;
}

export function totalTokens(items: Item[]): number {
  let sum = 0;
  for (const item of items) sum += item.meta.tokens;
  return sum;
}

/**
 * Cut `text` to roughly `tokens` tokens, measured by the tokenizer, from the
 * start (`'head'`) or the end (`'tail'`). Binary search on character length so
 * it works for any tokenizer without assuming a chars-per-token ratio.
 */
export function sliceByTokens(
  text: string,
  tokens: number,
  side: 'head' | 'tail',
  tokenizer: Tokenizer,
): string {
  if (tokens <= 0) return '';
  if (tokenizer.count(text) <= tokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = side === 'head' ? text.slice(0, mid) : text.slice(text.length - mid);
    if (tokenizer.count(candidate) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return side === 'head' ? text.slice(0, lo) : text.slice(text.length - lo);
}
