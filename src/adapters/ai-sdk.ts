/**
 * Vercel AI SDK adapter and middleware (AI SDK 7, provider spec v4; v3 models work through the SDK's own compatibility layer).
 *
 *   import { wrapLanguageModel, generateText, tool, jsonSchema } from 'ai';
 *   import { MemoryArchive } from 'windowkeeper';
 *   import { windowkeeperMiddleware, recallToolAiSdk, recallInputSchema } from 'windowkeeper/ai-sdk';
 *
 *   const archive = new MemoryArchive();
 *   const model = wrapLanguageModel({ model: anthropic('claude-sonnet-5'), middleware: windowkeeperMiddleware({ archive, policy }) });
 *   const tools = { ...yourTools, recall: tool({ ...recallToolAiSdk(archive), inputSchema: jsonSchema<{ id: string }>(recallInputSchema) }) };
 *   await generateText({ model, tools, messages });
 *
 * Types come from `@ai-sdk/provider` (an optional peer); nothing from the AI SDK
 * is imported at runtime, so the core stays dependency-free.
 */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Message,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from '@ai-sdk/provider';
import type { Archive } from '../archive.js';
import { contentId } from '../ids.js';
import { keep, type KeepResult } from '../keep.js';
import type { LedgerSink } from '../ledger.js';
import { assignTurns } from '../normalize.js';
import type { PolicyInput } from '../policy.js';
import { handleRecall, recallInputSchema, recallToolDescription } from '../recall.js';

export { recallInputSchema, recallToolDescription };
import type { Tokenizer } from '../tokenizer.js';
import { safeJson, type Block, type Item, type RawItem } from '../types.js';

type Part = LanguageModelV4Message['content'] extends string | infer P ? (P extends Array<infer X> ? X : never) : never;
type ToolPart = Extract<LanguageModelV4Message, { role: 'tool' }>['content'][number];

/** Marker for tool-role parts that are not tool results, so they round-trip in a tool message. */
const TOOL_PART = '__windowkeeperToolPart';

export function fromAiSdk(prompt: LanguageModelV4Prompt): Item[] {
  const items: RawItem[] = [];
  const meta = (m: LanguageModelV4Message) => ({
    tokens: 0,
    pinned: false,
    tags: [] as string[],
    ...(m.providerOptions ? { providerOptions: m.providerOptions } : {}),
  });

  for (const m of prompt) {
    switch (m.role) {
      case 'system':
        items.push({ kind: 'system', id: '', turn: 0, text: m.content, meta: meta(m) });
        break;
      case 'user':
        items.push({ kind: 'user', id: '', turn: 0, blocks: m.content.map(partToBlock), meta: meta(m) });
        break;
      case 'assistant':
        items.push({ kind: 'assistant', id: '', turn: 0, blocks: m.content.map(partToBlock), meta: meta(m) });
        break;
      case 'tool': {
        const other: Block[] = [];
        for (const p of m.content) {
          if (p.type === 'tool-result') {
            items.push({
              kind: 'tool_result',
              id: '',
              turn: 0,
              callId: p.toolCallId,
              tool: p.toolName,
              blocks: outputToBlocks(p.output),
              isError: p.output.type === 'error-text' || p.output.type === 'error-json',
              meta: meta(m),
            });
          } else {
            other.push({ type: 'opaque', raw: { [TOOL_PART]: p } });
          }
        }
        if (other.length) items.push({ kind: 'user', id: '', turn: 0, blocks: other, meta: meta(m) });
        break;
      }
    }
  }

  assignTurns(items);
  for (const item of items) item.id = contentId(item);
  return items;
}

function partToBlock(p: Part): Block {
  switch (p.type) {
    case 'text':
      return { type: 'text', text: p.text };
    case 'tool-call':
      // Provider-executed calls need no client result; pass them through untouched.
      if (p.providerExecuted) return { type: 'opaque', raw: p };
      return { type: 'tool_use', id: p.toolCallId, name: p.toolName, input: p.input };
    case 'file':
      if (p.data.type === 'data' && typeof p.data.data === 'string' && p.mediaType.startsWith('image/')) {
        return { type: 'image', mediaType: p.mediaType, data: p.data.data };
      }
      return { type: 'opaque', raw: p };
    default:
      return { type: 'opaque', raw: p };
  }
}

function outputToBlocks(o: LanguageModelV4ToolResultOutput): Block[] {
  switch (o.type) {
    case 'text':
    case 'error-text':
      return [{ type: 'text', text: o.value }];
    case 'json':
    case 'error-json':
      return [{ type: 'text', text: safeJson(o.value) }];
    case 'execution-denied':
      return [{ type: 'text', text: `[tool execution denied${o.reason ? `: ${o.reason}` : ''}]` }];
    case 'content':
      return o.value.map((c): Block => {
        if (c.type === 'text') return { type: 'text', text: c.text };
        const img = c as { type: string; data?: unknown; mediaType?: string };
        if (img.type === 'image-data' && typeof img.data === 'string' && img.mediaType) {
          return { type: 'image', mediaType: img.mediaType, data: img.data };
        }
        return { type: 'opaque', raw: c };
      });
    default:
      return [{ type: 'text', text: safeJson(o) }];
  }
}

export function toAiSdk(items: Item[]): LanguageModelV4Prompt {
  const out: LanguageModelV4Message[] = [];
  const withOptions = <T extends LanguageModelV4Message>(m: T, item: Item): T => {
    const po = item.meta.providerOptions;
    return po ? ({ ...m, providerOptions: po } as T) : m;
  };
  const pushToolPart = (part: ToolPart, item: Item) => {
    const last = out[out.length - 1];
    if (last && last.role === 'tool') {
      last.content.push(part);
      return;
    }
    out.push(withOptions({ role: 'tool', content: [part] }, item));
  };

  for (const item of items) {
    switch (item.kind) {
      case 'system':
        out.push(withOptions({ role: 'system', content: item.text }, item));
        break;
      case 'user': {
        const toolParts = item.blocks.filter((b) => b.type === 'opaque' && isToolPart(b.raw));
        if (toolParts.length && toolParts.length === item.blocks.length) {
          for (const b of toolParts) pushToolPart((b as { raw: Record<string, ToolPart> }).raw[TOOL_PART]!, item);
          break;
        }
        out.push(withOptions({ role: 'user', content: item.blocks.map(blockToUserPart) }, item));
        break;
      }
      case 'assistant':
        out.push(withOptions({ role: 'assistant', content: item.blocks.map(blockToAssistantPart) }, item));
        break;
      case 'tool_result':
        pushToolPart(
          {
            type: 'tool-result',
            toolCallId: item.callId,
            toolName: item.tool ?? 'unknown',
            output: { type: item.isError ? 'error-text' : 'text', value: item.blocks.map(blockText).join('\n') },
          },
          item,
        );
        break;
      case 'stub':
        if (item.callId) {
          pushToolPart({ type: 'tool-result', toolCallId: item.callId, toolName: item.tool ?? 'unknown', output: { type: 'text', value: item.text } }, item);
        } else out.push({ role: 'user', content: [{ type: 'text', text: item.text }] });
        break;
      case 'view':
      case 'recalled':
        out.push({ role: 'user', content: [{ type: 'text', text: item.text }] });
        break;
    }
  }
  return out;
}

function isToolPart(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && TOOL_PART in raw;
}

type UserPart = Extract<LanguageModelV4Message, { role: 'user' }>['content'][number];
type AssistantPart = Extract<LanguageModelV4Message, { role: 'assistant' }>['content'][number];

function blockToUserPart(b: Block): UserPart {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'image':
      return { type: 'file', data: { type: 'data', data: b.data }, mediaType: b.mediaType };
    case 'opaque':
      return b.raw as UserPart;
    default:
      return { type: 'text', text: blockText(b) };
  }
}

function blockToAssistantPart(b: Block): AssistantPart {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool-call', toolCallId: b.id, toolName: b.name, input: b.input };
    case 'image':
      return { type: 'file', data: { type: 'data', data: b.data }, mediaType: b.mediaType };
    case 'opaque':
      return b.raw as AssistantPart;
    case 'tool_result':
      return { type: 'text', text: blockText(b) };
  }
}

function blockText(b: Block): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'tool_use':
      return `${b.name}(${safeJson(b.input)})`;
    case 'tool_result':
      return typeof b.content === 'string' ? b.content : b.content.map(blockText).join('\n');
    case 'image':
      return '[image]';
    case 'opaque':
      return safeJson(b.raw);
  }
}

export interface MiddlewareOptions {
  /** One archive per session. Required: without it nothing is recoverable. */
  archive: Archive;
  policy?: PolicyInput;
  tokenizer?: Tokenizer;
  ledger?: LedgerSink;
  /** Throw on an invariant violation instead of sending the untouched prompt. */
  strict?: boolean;
  /** Called after every model call with the full keep() result. */
  onCall?: (result: KeepResult, params: LanguageModelV4CallOptions) => void;
}

/** `wrapLanguageModel({ model, middleware: windowkeeperMiddleware({ archive }) })`. */
export function windowkeeperMiddleware(options: MiddlewareOptions): LanguageModelV4Middleware {
  let call = 0;
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => {
      const items = fromAiSdk(params.prompt);
      const keepOptions: Parameters<typeof keep>[2] = { archive: options.archive, call: ++call };
      if (options.tokenizer) keepOptions.tokenizer = options.tokenizer;
      if (options.ledger) keepOptions.ledger = options.ledger;
      if (options.strict !== undefined) keepOptions.strict = options.strict;
      const result = keep(items, options.policy ?? {}, keepOptions);
      options.onCall?.(result, params);
      return { ...params, prompt: toAiSdk(result.window) };
    },
  };
}

/**
 * The recall tool for the AI SDK. Add the schema with `jsonSchema` from `ai` so
 * this module stays free of runtime imports:
 *
 *   tools: { recall: tool({ ...recallToolAiSdk(archive), inputSchema: jsonSchema<{ id: string }>(recallInputSchema) }) }
 */
export function recallToolAiSdk(archive: Archive) {
  return {
    description: recallToolDescription,
    execute: async ({ id }: { id: string }) => handleRecall(archive, { id }),
  };
}
