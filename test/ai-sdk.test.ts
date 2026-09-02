import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { generateText, jsonSchema, tool, wrapLanguageModel, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { fromAiSdk, recallInputSchema, recallToolAiSdk, toAiSdk, windowkeeperMiddleware } from '../src/adapters/ai-sdk.js';
import { MemoryArchive } from '../src/archive.js';
import { keep } from '../src/keep.js';
import type { LedgerEntry } from '../src/ledger.js';

const prompt: LanguageModelV4Prompt = [
  { role: 'system', content: 'You are terse.', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
  { role: 'user', content: [{ type: 'text', text: 'Read src/a.ts' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'I should read it.' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { path: 'src/a.ts' } },
    ],
  },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read_file', output: { type: 'text', value: 'export const a = 1;' } }] },
  { role: 'assistant', content: [{ type: 'text', text: 'It exports a.' }] },
  { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' }] },
];

describe('ai-sdk adapter', () => {
  it('round-trips a prompt, keeping reasoning parts and provider options', () => {
    const items = fromAiSdk(prompt);
    expect(items.map((i) => i.kind)).toEqual(['system', 'user', 'assistant', 'tool_result', 'assistant', 'user']);
    const tr = items[3];
    expect(tr?.kind === 'tool_result' && tr.tool).toBe('read_file');
    const back = toAiSdk(items);
    expect(back[0]).toEqual(prompt[0]);
    expect(back[2]).toEqual({ role: 'assistant', content: prompt[2]!.content });
    expect(back[3]).toEqual(prompt[3]);
    expect(back[5]).toEqual({ role: 'user', content: prompt[5]!.content });
  });

  it('maps error and json outputs and keeps non-result tool parts in a tool message', () => {
    const p: LanguageModelV4Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'q', input: {} }, { type: 'tool-call', toolCallId: 'c2', toolName: 'q', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'q', output: { type: 'error-text', value: 'boom' } },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'q', output: { type: 'json', value: { ok: true } } },
          { type: 'tool-approval-response', approvalId: 'a1', approved: true },
        ],
      },
    ];
    const items = fromAiSdk(p);
    expect(items.filter((i) => i.kind === 'tool_result').map((i) => i.kind === 'tool_result' && i.isError)).toEqual([true, false]);
    const back = toAiSdk(items);
    expect(back[2]!.role).toBe('tool');
    const content = back[2]!.content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(['tool-result', 'tool-result', 'tool-approval-response']);
  });
});

describe('windowkeeperMiddleware', () => {
  it('curates the prompt the model receives through wrapLanguageModel + generateText', async () => {
    const seen: LanguageModelV4CallOptions[] = [];
    const mock = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(options);
        return {
          content: [{ type: 'text', text: 'done' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        };
      },
    });
    const archive = new MemoryArchive();
    const ledger: LedgerEntry[] = [];
    const model = wrapLanguageModel({
      model: mock,
      middleware: windowkeeperMiddleware({
        archive,
        strict: true,
        ledger: (e) => ledger.push(e),
        policy: { budget: { max: 2500, reserve: 200, target: 1500 }, toolResults: { evictAfterTurns: 1, keepLatestPerTool: 0 }, protect: { recentTurns: 1 } },
      }),
    });

    const messages: ModelMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'grep', input: { i } }] });
      messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'grep', output: { type: 'text', value: 'x '.repeat(400) } }] });
    }
    messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'now what' });

    const result = await generateText({
      model,
      messages,
      tools: { recall: tool({ ...recallToolAiSdk(archive), inputSchema: jsonSchema<{ id: string }>(recallInputSchema) }) },
    });
    expect(result.text).toBe('done');
    expect(seen).toHaveLength(1);

    const sent = seen[0]!.prompt;
    const calls = sent.flatMap((m) => (m.role === 'assistant' ? m.content.filter((p) => p.type === 'tool-call').map((p) => (p.type === 'tool-call' ? p.toolCallId : '')) : []));
    const answered = sent.flatMap((m) => (m.role === 'tool' ? m.content.filter((p) => p.type === 'tool-result').map((p) => (p.type === 'tool-result' ? p.toolCallId : '')) : []));
    for (const c of calls) expect(answered).toContain(c);
    const stubbed = sent.flatMap((m) => (m.role === 'tool' ? m.content : [])).filter((p) => p.type === 'tool-result' && p.output.type === 'text' && p.output.value.includes('[windowkeeper] grep result'));
    expect(stubbed.length).toBeGreaterThan(0);
    const summary = ledger.find((e) => e.action === 'summary');
    expect(summary?.tokensAfter).toBeLessThanOrEqual(2300);
    expect(archive.size).toBeGreaterThan(20);
    // The last user message reached the model untouched.
    const lastUser = [...sent].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content).toEqual([{ type: 'text', text: 'now what' }]);
  });

  it('serves the recall tool from the archive', async () => {
    const archive = new MemoryArchive();
    const items = fromAiSdk(prompt);
    keep(items, {}, { archive });
    const tr = items.find((i) => i.kind === 'tool_result')!;
    const t = recallToolAiSdk(archive);
    expect(await t.execute({ id: tr.id })).toContain('export const a = 1;');
  });
});
