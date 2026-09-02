import { describe, expect, it } from 'vitest';
import { MemoryArchive } from '../src/archive.js';
import { InvariantError, keep } from '../src/keep.js';
import { handleRecall } from '../src/recall.js';
import { totalTokens } from '../src/tokenizer.js';
import { assistant, build, filler, result, session, sys, user } from './fixtures.js';

describe('keep', () => {
  it('leaves the window untouched under budget', () => {
    const items = session(3, 100);
    const r = keep(items, { budget: { max: 100_000, reserve: 1000, target: 50_000 } }, { strict: true });
    expect(r.summary.budgetTripped).toBe(false);
    expect(r.window.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(r.summary.prefixIntactToTurn).toBe(items[items.length - 1]!.turn);
    expect(r.moved).toHaveLength(0);
  });

  it('brings a long session under target when the budget trips', () => {
    const items = session(30, 800);
    const before = totalTokens(keep(items, { budget: { max: 1_000_000, reserve: 0, target: 1 } }).window);
    const r = keep(items, { budget: { max: 8000, reserve: 1000, target: 5000 }, protect: { recentTurns: 2 }, toolResults: { maxTokensEach: 500, headTokens: 300, tailTokens: 100 } }, { strict: true });
    expect(r.summary.budgetTripped).toBe(true);
    expect(r.summary.tokensAfter).toBeLessThanOrEqual(5000);
    expect(r.summary.tokensBefore).toBe(before);
    expect(r.ledger.some((e) => e.action === 'truncate')).toBe(true);
    expect(r.ledger.some((e) => e.action === 'evict')).toBe(true);
    expect(r.window[r.window.length - 1]!.kind).toBe('user');
    expect(r.moved.length).toBeGreaterThan(0);
  });

  it('archives every raw item and every stub points at a recoverable item', () => {
    const archive = new MemoryArchive();
    const items = session(20, 500);
    const r = keep(items, { budget: { max: 6000, reserve: 500, target: 4000 } }, { archive, strict: true });
    for (const it of items) expect(archive.has(it.id)).toBe(true);
    for (const it of r.window) {
      if (it.kind === 'stub') {
        const text = handleRecall(archive, { id: it.refs[0] });
        expect(text).toContain('result of');
        expect(text).not.toContain('no archived item');
      }
    }
  });

  it('is deterministic', () => {
    const items = session(25, 600);
    const opts = { now: 1 };
    const a = keep(items, { budget: { max: 9000, reserve: 1000, target: 6000 } }, opts);
    const b = keep(items, { budget: { max: 9000, reserve: 1000, target: 6000 } }, opts);
    expect(JSON.stringify(a.window)).toBe(JSON.stringify(b.window));
    expect(JSON.stringify(a.ledger)).toBe(JSON.stringify(b.ledger));
  });

  it('records budget.unshrinkable instead of breaking protection', () => {
    const items = build([sys(filler(3000)), user(filler(3000))]);
    const r = keep(items, { budget: { max: 2000, reserve: 100, target: 1000 } }, { strict: true });
    expect(r.ledger.some((e) => e.rule === 'budget.unshrinkable')).toBe(true);
    expect(r.window).toHaveLength(2);
  });

  it('degrades to a no-op on an invariant violation unless strict', () => {
    // An orphaned tool_result in the input cannot be repaired; the check flags it.
    const items = build([user('u'), result('ghost', 'orphan'), user('again')]);
    const r = keep(items, {}, {});
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.window.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(() => keep(items, {}, { strict: true })).toThrow(InvariantError);
  });
});

describe('resurface', () => {
  it('keeps a matched item in full when the user names its file, even though it would otherwise be evicted', () => {
    const archive = new MemoryArchive();
    const policy = { budget: { max: 7000, reserve: 500, target: 4000 }, protect: { recentTurns: 1 }, toolResults: { evictAfterTurns: 2, keepLatestPerTool: 0 } };
    // First call: many results get evicted.
    const first = keep(session(20, 400, 'keep going'), policy, { archive, strict: true, call: 1 });
    const stub = first.window.find((i) => i.kind === 'stub');
    expect(stub).toBeTruthy();
    const original = archive.get(stub!.kind === 'stub' ? stub!.refs[0]! : '')!;
    const path = /src\/mod\d+\/file\d+\.ts/.exec(original.kind === 'tool_result' ? original.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('') : '')![0];

    // Second call: harness sends the raw transcript again plus a new user message naming that file.
    const second = keep(session(20, 400, `what did ${path} contain?`), policy, { archive, strict: true, call: 2 });
    const entry = second.ledger.find((e) => e.rule === 'resurface.identifiers' && e.refs?.[0] === original.id);
    expect(entry).toBeTruthy();
    expect(entry!.detail).toContain(path);
    // The harness sent the raw transcript, so the match was still in the window: it is kept in full, not evicted.
    expect(entry!.action).toBe('keep');
    expect(second.window.find((i) => i.id === original.id)?.kind).toBe('tool_result');
    expect(second.ledger.some((e) => e.action === 'evict')).toBe(true);
  });

  it('appends a recalled item for an archived item that is not in the window at all', () => {
    const archive = new MemoryArchive();
    const older = build([user('earlier session about lib/db/pool.go'), assistant('noted: lib/db/pool.go leaks connections')]);
    keep(older, {}, { archive, strict: true, call: 1 });
    const now = build([user('fresh start'), assistant('hello'), user('remind me about lib/db/pool.go')]);
    const r = keep(now, {}, { archive, strict: true, call: 2 });
    const recalled = r.window.filter((i) => i.kind === 'recalled');
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled.some((i) => i.kind === 'recalled' && i.text.includes('leaks connections'))).toBe(true);
    expect(r.summary.recalled).toBe(recalled.length);
    // The stable prefix is untouched: everything before the appended items equals the input.
    expect(r.window.slice(0, now.length).map((i) => i.id)).toEqual(now.map((i) => i.id));
  });

  it('does nothing when the last item is not a fresh user message', () => {
    const archive = new MemoryArchive();
    keep(build([user('about src/auth/session.ts'), assistant('ok')]), {}, { archive });
    const items = build([user('x'), assistant('a', [{ id: 'c1', name: 'grep' }]), result('c1', 'src/auth/session.ts matched')]);
    const r = keep(items, {}, { archive, strict: true });
    expect(r.window.some((i) => i.kind === 'recalled')).toBe(false);
  });
});

describe('recall tool', () => {
  it('returns verbatim content by id and a clear message for unknown ids', () => {
    const archive = new MemoryArchive();
    const items = session(2, 50);
    keep(items, {}, { archive });
    const tr = items.find((i) => i.kind === 'tool_result')!;
    expect(handleRecall(archive, { id: tr.id })).toContain('read_file result from turn');
    expect(handleRecall(archive, { id: 'nope' })).toContain('no archived item');
    expect(handleRecall(archive, {})).toContain('needs an archive id');
  });

  it('finds a repeated tool call by identical arguments in any key order', () => {
    const archive = new MemoryArchive();
    const items = build([user('u'), assistant('a', [{ id: 'c1', name: 'read_file', input: { path: 'a.ts', lines: 10 } }]), result('c1', 'contents of a.ts'), assistant('done')]);
    keep(items, {}, { archive });
    expect(archive.findToolResult('read_file', { lines: 10, path: 'a.ts' })?.id).toBe(items[2]!.id);
    expect(archive.findToolResult('read_file', { path: 'b.ts' })).toBeUndefined();
  });
});
