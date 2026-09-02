/**
 * Transcript model.
 *
 * Provider-neutral. Adapters convert to and from Anthropic Messages, OpenAI, and
 * the Vercel AI SDK. Every item has a stable content-hash id and a turn number.
 *
 * A "turn" is one model call. The counter increments after every assistant item,
 * so an agent loop with one user message and thirty tool cycles spans thirty
 * turns. Ages and protection windows are measured in turns.
 */

export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string | Block[]; isError?: boolean }
  /** Provider-specific block passed through untouched (thinking, citations, ...). */
  | { type: 'opaque'; raw: unknown };

export interface Meta {
  /** Token count as measured by the configured tokenizer. */
  tokens: number;
  /** Never moved, truncated, or altered. */
  pinned: boolean;
  /** Free-form tags. Policy `protect.tags` matches against these. */
  tags: string[];
  /** Absolute epoch ms after which the item leaves the window. It stays in the archive. */
  ttl?: number;
  /** Where the item came from, for the ledger. */
  source?: string;
  /** Set when a reducer truncated the content. The archive holds the full item. */
  truncated?: boolean;
  /** Message-level provider options carried through adapters untouched. */
  providerOptions?: unknown;
}

interface ItemBase {
  id: string;
  turn: number;
  meta: Meta;
}

export type SystemItem = ItemBase & { kind: 'system'; text: string };
export type UserItem = ItemBase & { kind: 'user'; blocks: Block[] };
export type AssistantItem = ItemBase & { kind: 'assistant'; blocks: Block[] };
export type ToolResultItem = ItemBase & {
  kind: 'tool_result';
  callId: string;
  /** Filled by `link()` from the matching tool_use. */
  tool?: string;
  args?: unknown;
  blocks: Block[];
  isError: boolean;
};
/** Replaces one item in place. `callId` is set when it stands in for a tool_result. */
export type StubItem = ItemBase & {
  kind: 'stub';
  refs: string[];
  text: string;
  callId?: string;
  tool?: string;
};
/** Summarizes a closed span. Written fresh, never from hindsight. Reserved for v0.2. */
export type ViewItem = ItemBase & { kind: 'view'; covers: string[]; text: string; depth: number };
/** An archived item brought back by re-surfacing, rendered as text, anchored to the user item that mentioned it. */
export type RecalledItem = ItemBase & { kind: 'recalled'; ref: string; anchor: string; text: string; match: string };

export type Item =
  | SystemItem
  | UserItem
  | AssistantItem
  | ToolResultItem
  | StubItem
  | ViewItem
  | RecalledItem;

export type Kind = Item['kind'];

export type Transcript = Item[];

/** Items that carry original content and live in the archive. */
export type RawItem = SystemItem | UserItem | AssistantItem | ToolResultItem;

export function isRaw(item: Item): item is RawItem {
  return (
    item.kind === 'system' ||
    item.kind === 'user' ||
    item.kind === 'assistant' ||
    item.kind === 'tool_result'
  );
}

/** Concatenated text of an item, used for token counting and identifier indexing. */
export function itemText(item: Item): string {
  switch (item.kind) {
    case 'system':
    case 'stub':
    case 'view':
    case 'recalled':
      return item.text;
    case 'user':
    case 'assistant':
      return blocksText(item.blocks);
    case 'tool_result':
      return blocksText(item.blocks);
  }
}

export function blocksText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        out.push(b.text);
        break;
      case 'tool_use':
        out.push(`${b.name}(${safeJson(b.input)})`);
        break;
      case 'tool_result':
        out.push(typeof b.content === 'string' ? b.content : blocksText(b.content));
        break;
      case 'image':
        out.push('[image]');
        break;
      case 'opaque':
        out.push(safeJson(b.raw));
        break;
    }
  }
  return out.join('\n');
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
