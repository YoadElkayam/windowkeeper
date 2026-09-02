import type { Archive } from './archive.js';
import { heuristicTokenizer, sliceByTokens, type Tokenizer } from './tokenizer.js';
import { itemText, safeJson } from './types.js';

/**
 * The one tool the model gets: recall by archive id. Every stub, truncation
 * marker, and recalled item names the id to pass here.
 */
export const RECALL_TOOL_NAME = 'recall';

export const recallToolDescription =
  'Read an item that windowkeeper moved out of the context window. Pass the archive id shown in a "[windowkeeper]" marker. Returns the verbatim content.';

export const recallInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Archive id from a [windowkeeper] marker' },
  },
  required: ['id'],
  additionalProperties: false,
} as const;

/** Anthropic Messages tool definition. */
export const recallToolAnthropic = {
  name: RECALL_TOOL_NAME,
  description: recallToolDescription,
  input_schema: recallInputSchema,
} as const;

/** OpenAI function-calling tool definition. */
export const recallToolOpenAI = {
  type: 'function',
  function: { name: RECALL_TOOL_NAME, description: recallToolDescription, parameters: recallInputSchema },
} as const;

export interface RecallOptions {
  tokenizer?: Tokenizer;
  /** Cap on the returned text. Longer items are cut with a note. Defaults to 8000. */
  maxTokens?: number;
}

export function handleRecall(archive: Archive, input: { id?: unknown }, options: RecallOptions = {}): string {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) return '[windowkeeper] recall needs an archive id.';
  const item = archive.get(id);
  if (!item) return `[windowkeeper] no archived item with id ${id}.`;
  const tokenizer = options.tokenizer ?? heuristicTokenizer;
  const max = options.maxTokens ?? 8000;
  const header =
    item.kind === 'tool_result'
      ? `[windowkeeper archive ${id}: ${item.tool ?? 'tool'} result from turn ${item.turn}${item.args !== undefined ? `, args ${safeJson(item.args)}` : ''}]`
      : `[windowkeeper archive ${id}: ${item.kind} from turn ${item.turn}]`;
  const text = itemText(item);
  if (tokenizer.count(text) <= max) return `${header}\n${text}`;
  return `${header}\n${sliceByTokens(text, max, 'head', tokenizer)}\n[windowkeeper] cut at ${max} tokens.`;
}
