import { describe, expect, it } from 'vitest';
import { fromOpenAI, toOpenAI, type OpenAIMessage } from '../src/adapters/openai.js';
import { keep } from '../src/keep.js';

const messages: OpenAIMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Read src/a.ts' },
  { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1;' },
  { role: 'assistant', content: 'It exports a.' },
  { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
];

describe('openai adapter', () => {
  it('round-trips a transcript, parsing tool arguments', () => {
    const items = fromOpenAI(messages);
    expect(items.map((i) => i.kind)).toEqual(['system', 'user', 'assistant', 'tool_result', 'assistant', 'user']);
    const tr = items[3];
    expect(tr?.kind === 'tool_result' && tr.callId).toBe('call_1');
    const back = toOpenAI(items);
    expect(back[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(back[2]).toEqual({ role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] });
    expect(back[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1;' });
    expect(Array.isArray(back[5]!.content) && (back[5]!.content as Array<{ type: string }>).some((p) => p.type === 'image_url')).toBe(true);
  });

  it('links tool names through keep() so stubs name the tool and stay paired', () => {
    const many: OpenAIMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 12; i++) {
      many.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'grep', arguments: `{"i":${i}}` } }] });
      many.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x '.repeat(400) });
    }
    many.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'now what' });
    const r = keep(fromOpenAI(many), { budget: { max: 2500, reserve: 200, target: 1500 }, toolResults: { evictAfterTurns: 1, keepLatestPerTool: 0 }, protect: { recentTurns: 1 } }, { strict: true });
    const out = toOpenAI(r.window);
    const calls = out.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : []));
    const answered = out.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(answered).toContain(c);
    const stubs = out.filter((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('[windowkeeper] grep result'));
    expect(stubs.length).toBeGreaterThan(0);
  });
});
