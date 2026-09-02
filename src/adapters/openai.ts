/**
 * OpenAI Chat Completions adapter. Pure data transforms, no SDK dependency.
 *
 *   const items = fromOpenAI(messages);
 *   const { window } = keep(items, policy, { archive });
 *   await client.chat.completions.create({ model, messages: toOpenAI(window), tools: [...tools, recallToolOpenAI] });
 *
 * Stubs for evicted tool results render as `tool` messages with the same
 * `tool_call_id`, so every assistant `tool_calls` entry stays answered.
 */
import { contentId } from '../ids.js';
import { assignTurns } from '../normalize.js';
import type { Block, Item, RawItem } from '../types.js';

type OpenAITextPart = { type: 'text'; text: string };
type OpenAIImagePart = { type: 'image_url'; image_url: { url: string; detail?: string } };
type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | { type: string; [k: string]: unknown };

export type OpenAIMessage =
  | { role: 'system' | 'developer'; content: string | OpenAITextPart[]; name?: string }
  | { role: 'user'; content: string | OpenAIContentPart[]; name?: string }
  | {
      role: 'assistant';
      content?: string | OpenAIContentPart[] | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      name?: string;
      refusal?: string | null;
    }
  | { role: 'tool'; tool_call_id: string; content: string | OpenAITextPart[] };

export function fromOpenAI(messages: OpenAIMessage[]): Item[] {
  const items: RawItem[] = [];
  const meta = () => ({ tokens: 0, pinned: false, tags: [] as string[] });

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
      case 'developer':
        items.push({ kind: 'system', id: '', turn: 0, text: partsText(msg.content), meta: meta() });
        break;
      case 'user':
        items.push({ kind: 'user', id: '', turn: 0, blocks: toBlocks(msg.content), meta: meta() });
        break;
      case 'assistant': {
        const blocks: Block[] = msg.content ? toBlocks(msg.content) : [];
        for (const call of msg.tool_calls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
        }
        items.push({ kind: 'assistant', id: '', turn: 0, blocks, meta: meta() });
        break;
      }
      case 'tool':
        items.push({
          kind: 'tool_result',
          id: '',
          turn: 0,
          callId: msg.tool_call_id,
          blocks: [{ type: 'text', text: partsText(msg.content) }],
          isError: false,
          meta: meta(),
        });
        break;
    }
  }

  assignTurns(items);
  for (const item of items) item.id = contentId(item);
  return items;
}

export function toOpenAI(items: Item[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'system':
        out.push({ role: 'system', content: item.text });
        break;
      case 'user':
        out.push({ role: 'user', content: fromBlocks(item.blocks) });
        break;
      case 'assistant': {
        const calls = item.blocks.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
        const rest = item.blocks.filter((b) => b.type !== 'tool_use');
        const msg: Extract<OpenAIMessage, { role: 'assistant' }> = { role: 'assistant' };
        const content = fromBlocks(rest);
        if (typeof content === 'string') {
          if (content) msg.content = content;
        } else if (content.length) msg.content = content;
        if (!msg.content && calls.length === 0) msg.content = '';
        if (calls.length) {
          msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
        }
        out.push(msg);
        break;
      }
      case 'tool_result':
        out.push({ role: 'tool', tool_call_id: item.callId, content: partsText(fromBlocks(item.blocks)) });
        break;
      case 'stub':
        if (item.callId) out.push({ role: 'tool', tool_call_id: item.callId, content: item.text });
        else out.push({ role: 'user', content: item.text });
        break;
      case 'view':
      case 'recalled':
        out.push({ role: 'user', content: item.text });
        break;
    }
  }
  return out;
}

function toBlocks(content: string | OpenAIContentPart[]): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((p): Block => {
    if (p.type === 'text') return { type: 'text', text: (p as OpenAITextPart).text };
    if (p.type === 'image_url') {
      const url = (p as OpenAIImagePart).image_url.url;
      const m = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (m) return { type: 'image', mediaType: m[1]!, data: m[2]! };
      return { type: 'opaque', raw: p };
    }
    return { type: 'opaque', raw: p };
  });
}

/** Text-only block lists collapse to a string, which is what most callers expect. */
function fromBlocks(blocks: Block[]): string | OpenAIContentPart[] {
  if (blocks.every((b) => b.type === 'text')) return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return blocks.map((b): OpenAIContentPart => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'image':
        return { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } };
      case 'opaque':
        return b.raw as OpenAIContentPart;
      case 'tool_use':
        return { type: 'text', text: `${b.name}(${JSON.stringify(b.input)})` };
      case 'tool_result':
        return { type: 'text', text: typeof b.content === 'string' ? b.content : partsText(fromBlocks(b.content)) };
    }
  });
}

function partsText(content: string | OpenAIContentPart[] | null | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? (p as OpenAITextPart).text : '')).join('\n');
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
