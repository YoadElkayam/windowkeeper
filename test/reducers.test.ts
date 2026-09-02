import { describe, expect, it } from 'vitest';
import { MemoryArchive } from '../src/archive.js';
import { Ledger } from '../src/ledger.js';
import { currentTurnOf, prepare } from '../src/normalize.js';
import { resolvePolicy, type PolicyInput } from '../src/policy.js';
import { groupUnits, protectedIds } from '../src/protect.js';
import type { ReducerContext } from '../src/reducers/context.js';
import { evict } from '../src/reducers/evict.js';
import { expire } from '../src/reducers/expire.js';
import { trim } from '../src/reducers/trim.js';
import { truncate } from '../src/reducers/truncate.js';
import { heuristicTokenizer, totalTokens } from '../src/tokenizer.js';
import type { Item } from '../src/types.js';
import { assistant, build, filler, result, session, sys, user } from './fixtures.js';

function ctxFor(items: Item[], policyInput: PolicyInput = {}, now = 5_000): { items: Item[]; ctx: ReducerContext } {
  const policy = resolvePolicy(policyInput);
  const prepared = prepare(items, heuristicTokenizer);
  const currentTurn = currentTurnOf(prepared);
  const ctx: ReducerContext = {
    policy,
    tokenizer: heuristicTokenizer,
    archive: new MemoryArchive(),
    ledger: new Ledger(1),
    currentTurn,
    now,
    protectedIds: protectedIds(prepared, policy, currentTurn),
  };
  return { items: prepared, ctx };
}

describe('prepare', () => {
  it('links tool results to their tool_use and counts tokens', () => {
    const { items } = ctxFor(session(2, 50));
    const tr = items.find((i) => i.kind === 'tool_result');
    expect(tr?.kind === 'tool_result' && tr.tool).toBe('read_file');
    expect(tr?.meta.tokens).toBeGreaterThan(40);
  });

  it('de-duplicates by id, keeping the first', () => {
    const base = build([user('hello'), assistant('hi')]);
    const { items } = ctxFor([...base, ...base]);
    expect(items).toHaveLength(2);
  });

  it('assigns one turn per model call', () => {
    const items = build([sys('s'), user('a'), assistant('b', [{ id: 'c1', name: 'grep' }]), result('c1', 'r'), assistant('c'), user('d')]);
    expect(items.map((i) => i.turn)).toEqual([0, 1, 1, 2, 2, 3]);
  });
});

describe('protect', () => {
  it('protects system, pinned, tagged, recent, and the latest user turn', () => {
    const items = build([
      sys('s'),
      user('old', { pinned: true }),
      assistant('a1'),
      user('tagged', { tags: ['decision'] }),
      assistant('a2'),
      user('plain'),
      assistant('a3'),
      user('latest'),
    ]);
    const { ctx } = ctxFor(items, { protect: { recentTurns: 1 } });
    const p = ctx.protectedIds;
    expect(p.has(items[0]!.id)).toBe(true); // system
    expect(p.has(items[1]!.id)).toBe(true); // pinned
    expect(p.has(items[3]!.id)).toBe(true); // tagged
    expect(p.has(items[5]!.id)).toBe(false); // plain, old
    expect(p.has(items[7]!.id)).toBe(true); // latest user
  });

  it('groups an assistant with its tool results as one unit', () => {
    const items = build([user('u'), assistant('a', [{ id: 'c1', name: 'grep' }, { id: 'c2', name: 'grep' }]), result('c1', 'r1'), result('c2', 'r2'), assistant('done')]);
    const units = groupUnits(items);
    expect(units.map((u) => u.ids.length)).toEqual([1, 3, 1]);
  });
});

describe('truncate', () => {
  it('keeps head and tail, marks the item, and names the archive id', () => {
    const { items, ctx } = ctxFor(session(3, 3000), { toolResults: { maxTokensEach: 500, headTokens: 300, tailTokens: 100 } });
    const out = truncate(items, ctx);
    const big = out.filter((i) => i.kind === 'tool_result' && i.meta.truncated);
    expect(big.length).toBeGreaterThan(0);
    for (const t of big) {
      expect(t.meta.tokens).toBeLessThan(600);
      const text = t.kind === 'tool_result' && t.blocks[0]?.type === 'text' ? t.blocks[0].text : '';
      expect(text).toContain(`archived as ${t.id}`);
      expect(text.startsWith('result of')).toBe(true);
    }
  });

  it('never truncates the current turn or pinned results', () => {
    const items = build([user('u'), assistant('a', [{ id: 'c1', name: 'grep' }]), result('c1', filler(2000), { pinned: true }), assistant('b', [{ id: 'c2', name: 'grep' }]), result('c2', filler(2000))]);
    const { items: prepared, ctx } = ctxFor(items, { toolResults: { maxTokensEach: 500, headTokens: 300, tailTokens: 100 } });
    const out = truncate(prepared, ctx);
    expect(out.every((i) => !i.meta.truncated)).toBe(true);
  });
});

describe('evict', () => {
  it('stubs old tool results in place, keeping callId and the archive id', () => {
    const { items, ctx } = ctxFor(session(12, 100), { toolResults: { evictAfterTurns: 3, keepLatestPerTool: 0 }, protect: { recentTurns: 0 } });
    const out = evict(items, ctx);
    const stubs = out.filter((i) => i.kind === 'stub');
    expect(stubs.length).toBeGreaterThan(0);
    for (const s of stubs) {
      expect(s.kind === 'stub' && s.callId).toBeTruthy();
      expect(s.kind === 'stub' && s.text).toContain(`archived as ${s.kind === 'stub' ? s.refs[0] : ''}`);
    }
    expect(out).toHaveLength(items.length);
    expect(out.map((i) => i.turn)).toEqual(items.map((i) => i.turn));
  });

  it('keeps errors when keepErrors and the latest result per tool', () => {
    const items = build([
      user('u'),
      assistant('a', [{ id: 'c1', name: 'grep' }]),
      result('c1', 'boom', { isError: true }),
      assistant('b', [{ id: 'c2', name: 'grep' }]),
      result('c2', 'fine'),
      assistant('c', [{ id: 'c3', name: 'grep' }]),
      result('c3', 'latest'),
      ...Array.from({ length: 6 }, (_, i) => assistant(`filler ${i}`)),
      user('now'),
    ]);
    const { items: prepared, ctx } = ctxFor(items, { toolResults: { evictAfterTurns: 1, keepErrors: true, keepLatestPerTool: 1 }, protect: { recentTurns: 0 } });
    const out = evict(prepared, ctx);
    const byCall = (id: string) => out.find((i) => (i.kind === 'tool_result' || i.kind === 'stub') && i.callId === id)!;
    expect(byCall('c1').kind).toBe('tool_result');
    expect(byCall('c2').kind).toBe('stub');
    expect(byCall('c3').kind).toBe('tool_result');
  });
});

describe('trim', () => {
  it('drops oldest unprotected units until at or below target, never orphaning', () => {
    const { items, ctx } = ctxFor(session(10, 200), { budget: { max: 2000, reserve: 200, target: 1200 }, protect: { recentTurns: 1 } });
    const out = trim(items, ctx);
    expect(totalTokens(out)).toBeLessThanOrEqual(1200);
    const uses = new Set(out.flatMap((i) => (i.kind === 'assistant' ? i.blocks.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.id : '')) : [])));
    const answered = new Set(out.flatMap((i) => (i.kind === 'tool_result' ? [i.callId] : [])));
    for (const u of uses) expect(answered.has(u)).toBe(true);
    for (const a of answered) expect(uses.has(a)).toBe(true);
    expect(out[out.length - 1]!.kind).toBe('user');
    expect(out[0]!.kind).toBe('system');
  });
});

describe('expire', () => {
  it('stubs expired tool results and removes expired units, never the latest user', () => {
    const items = build([user('u1', { ttl: 1 }), assistant('a', [{ id: 'c1', name: 'grep' }]), result('c1', 'r', { ttl: 1 }), assistant('b', [], { ttl: 1 }), user('latest', { ttl: 1 })]);
    const { items: prepared, ctx } = ctxFor(items, { protect: { recentTurns: 0 } }, 2);
    const out = expire(prepared, ctx);
    expect(out.find((i) => i.kind === 'stub')).toBeTruthy();
    expect(out[out.length - 1]!.kind).toBe('user');
    expect(out.some((i) => i.kind === 'user' && i.id === prepared[0]!.id)).toBe(false);
  });
});
