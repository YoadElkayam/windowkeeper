import { describe, expect, it } from 'vitest';
import { fromAnthropic, toAnthropic } from '../src/adapters/anthropic.js';
import { keep } from '../src/keep.js';

const params = {
  system: 'You are terse.',
  messages: [
    { role: 'user' as const, content: 'Read src/a.ts' },
    {
      role: 'assistant' as const,
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/a.ts' } },
      ],
    },
    {
      role: 'user' as const,
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const a = 1;' }],
    },
    { role: 'assistant' as const, content: 'It exports a.' },
    { role: 'user' as const, content: [{ type: 'text', text: 'thanks' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  ],
};

describe('anthropic adapter', () => {
  it('round-trips a transcript', () => {
    const items = fromAnthropic(params);
    expect(items.map((i) => i.kind)).toEqual(['system', 'user', 'assistant', 'tool_result', 'assistant', 'user']);
    expect(items.map((i) => i.turn)).toEqual([0, 1, 1, 2, 2, 3]);
    const back = toAnthropic(items);
    expect(back.system).toBe('You are terse.');
    expect(back.messages).toHaveLength(5);
    expect(back.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'export const a = 1;' }] }]);
    expect(Array.isArray(back.messages[4]!.content) && back.messages[4]!.content.some((b) => b.type === 'image')).toBe(true);
  });

  it('renders stubs as tool_result blocks and leads user messages with them', () => {
    const many = {
      messages: [
        { role: 'user' as const, content: 'go' },
        ...Array.from({ length: 12 }, (_, i) => [
          { role: 'assistant' as const, content: [{ type: 'tool_use', id: `t${i}`, name: 'grep', input: { i } }] },
          { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x '.repeat(400) }] },
        ]).flat(),
        { role: 'assistant' as const, content: 'done' },
        { role: 'user' as const, content: 'now what' },
      ],
    };
    const items = fromAnthropic(many);
    const r = keep(items, { budget: { max: 2500, reserve: 200, target: 1500 }, toolResults: { evictAfterTurns: 1, keepLatestPerTool: 0 }, protect: { recentTurns: 1 } }, { strict: true });
    const out = toAnthropic(r.window);
    for (const m of out.messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      const firstNonResult = m.content.findIndex((b) => b.type !== 'tool_result');
      const lastResult = m.content.map((b) => b.type).lastIndexOf('tool_result');
      if (firstNonResult !== -1 && lastResult !== -1) expect(lastResult).toBeLessThan(firstNonResult);
    }
    const stubs = r.window.filter((i) => i.kind === 'stub');
    expect(stubs.length).toBeGreaterThan(0);
    // Every assistant tool_use is answered in the rendered messages.
    const uses = out.messages.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id) : []));
    const answered = out.messages.flatMap((m) => (m.role === 'user' && Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id) : []));
    for (const u of uses) expect(answered).toContain(u);
  });
});
