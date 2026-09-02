/**
 * Anthropic Messages adapter. Pure data transforms, no SDK dependency.
 *
 *   const items = fromAnthropic({ system, messages });
 *   const { window } = keep(items, policy, { archive });
 *   const params = toAnthropic(window);
 *   await client.messages.create({ ...params, model, max_tokens, tools: [...tools, recallToolAnthropic] });
 */
import { contentId } from '../ids.js';
import { assignTurns } from '../normalize.js';
import type { Block, Item, RawItem } from '../types.js';

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } };
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>; is_error?: boolean };
type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | { type: string; [k: string]: unknown };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicParams {
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
}

export function fromAnthropic(params: AnthropicParams): Item[] {
  const items: RawItem[] = [];
  const meta = () => ({ tokens: 0, pinned: false, tags: [] as string[] });

  if (params.system) {
    const text = typeof params.system === 'string' ? params.system : params.system.map((b) => b.text).join('\n');
    items.push({ kind: 'system', id: '', turn: 0, text, meta: meta() });
  }

  for (const msg of params.messages) {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content } as AnthropicTextBlock] : msg.content;
    if (msg.role === 'assistant') {
      items.push({ kind: 'assistant', id: '', turn: 0, blocks: blocks.map(fromBlock), meta: meta() });
      continue;
    }
    const rest: Block[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const tr = b as AnthropicToolResultBlock;
        const content: Block[] =
          tr.content === undefined
            ? []
            : typeof tr.content === 'string'
              ? [{ type: 'text', text: tr.content }]
              : tr.content.map(fromBlock);
        items.push({
          kind: 'tool_result',
          id: '',
          turn: 0,
          callId: tr.tool_use_id,
          blocks: content,
          isError: tr.is_error === true,
          meta: meta(),
        });
      } else {
        rest.push(fromBlock(b));
      }
    }
    if (rest.length) items.push({ kind: 'user', id: '', turn: 0, blocks: rest, meta: meta() });
  }

  assignTurns(items);
  for (const item of items) item.id = contentId(item);
  return items;
}

function fromBlock(b: AnthropicBlock): Block {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: (b as AnthropicTextBlock).text };
    case 'tool_use': {
      const t = b as AnthropicToolUseBlock;
      return { type: 'tool_use', id: t.id, name: t.name, input: t.input };
    }
    case 'image': {
      const img = b as AnthropicImageBlock;
      if (img.source.type === 'base64') return { type: 'image', mediaType: img.source.media_type, data: img.source.data };
      return { type: 'opaque', raw: b };
    }
    default:
      return { type: 'opaque', raw: b };
  }
}

export function toAnthropic(items: Item[]): AnthropicParams {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const item of items) {
    switch (item.kind) {
      case 'system':
        systemParts.push(item.text);
        break;
      case 'user':
        push('user', item.blocks.map(toBlock));
        break;
      case 'assistant':
        push('assistant', item.blocks.map(toBlock));
        break;
      case 'tool_result':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: item.callId,
            content: item.blocks.map(toBlock) as Array<AnthropicTextBlock | AnthropicImageBlock>,
            ...(item.isError ? { is_error: true } : {}),
          },
        ]);
        break;
      case 'stub':
        if (item.callId) push('user', [{ type: 'tool_result', tool_use_id: item.callId, content: item.text }]);
        else push('user', [{ type: 'text', text: item.text }]);
        break;
      case 'view':
      case 'recalled':
        push('user', [{ type: 'text', text: item.text }]);
        break;
    }
  }

  // Anthropic requires tool_result blocks to lead a user message.
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const results = msg.content.filter((b) => b.type === 'tool_result');
      const others = msg.content.filter((b) => b.type !== 'tool_result');
      msg.content = [...results, ...others];
    }
  }

  const out: AnthropicParams = { messages };
  if (systemParts.length) out.system = systemParts.join('\n\n');
  return out;
}

function toBlock(b: Block): AnthropicBlock {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: typeof b.content === 'string' ? b.content : (b.content.map(toBlock) as Array<AnthropicTextBlock | AnthropicImageBlock>),
        ...(b.isError ? { is_error: true } : {}),
      };
    case 'opaque':
      return b.raw as AnthropicBlock;
  }
}
