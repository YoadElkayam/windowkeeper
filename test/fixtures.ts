import fc from 'fast-check';
import { contentId } from '../src/ids.js';
import { assignTurns } from '../src/normalize.js';
import type { Block, Item, RawItem } from '../src/types.js';

/* ---------- hand-built transcripts ---------- */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<RawItem, 'id' | 'turn'> & { id?: string; turn?: number };

const meta = (over: Partial<RawItem['meta']> = {}) => ({ tokens: 0, pinned: false, tags: [] as string[], ...over });

export const sys = (text: string, over?: Partial<RawItem['meta']>): Draft => ({ kind: 'system', text, meta: meta(over) });
export const user = (text: string, over?: Partial<RawItem['meta']>): Draft => ({
  kind: 'user',
  blocks: [{ type: 'text', text }],
  meta: meta(over),
});
export const assistant = (text: string, calls: Array<{ id: string; name: string; input?: unknown }> = [], over?: Partial<RawItem['meta']>): Draft => ({
  kind: 'assistant',
  blocks: [
    ...(text ? [{ type: 'text', text } as Block] : []),
    ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} }) as Block),
  ],
  meta: meta(over),
});
export const result = (callId: string, text: string, opts: { isError?: boolean } & Partial<RawItem['meta']> = {}): Draft => {
  const { isError, ...over } = opts;
  return { kind: 'tool_result', callId, blocks: [{ type: 'text', text }], isError: isError === true, meta: meta(over) };
};

/** Assign turns and content ids to drafts. */
export function build(drafts: Draft[]): Item[] {
  const items = drafts.map((d) => ({ ...d, id: '', turn: 0 })) as RawItem[];
  assignTurns(items);
  for (const it of items) it.id = contentId(it);
  return items;
}

/** Roughly `n` tokens of filler under the heuristic tokenizer. */
export function filler(n: number, seed = 'lorem'): string {
  const words: string[] = [];
  let i = 0;
  while (words.length < n) words.push(`${seed}${(i++ % 97).toString(36)}`);
  return words.join(' ');
}

/**
 * A long agent session: one user ask, then `cycles` tool cycles of
 * read_file/grep/bash with results of `resultTokens` each, then a fresh user
 * message.
 */
export function session(cycles: number, resultTokens: number, lastUser = 'ok continue'): Item[] {
  const drafts: Draft[] = [sys('You are a coding agent.'), user('Fix the failing auth test in src/auth/session.ts')];
  const tools = ['read_file', 'grep', 'bash'];
  for (let i = 0; i < cycles; i++) {
    const tool = tools[i % tools.length]!;
    const id = `call_${i}`;
    drafts.push(assistant(`Step ${i}.`, [{ id, name: tool, input: { q: `query-${i}`, path: `src/mod${i}/file${i}.ts` } }]));
    drafts.push(result(id, `result of ${tool} for src/mod${i}/file${i}.ts\n${filler(resultTokens, `r${i}`)}`));
  }
  drafts.push(assistant('Done with the investigation.'));
  drafts.push(user(lastUser));
  return build(drafts);
}

/* ---------- generated transcripts ---------- */

const word = fc.stringMatching(/^[a-z]{2,8}$/);
const ident = fc.oneof(
  fc.constantFrom('src/auth/session.ts', 'lib/db/pool.go', 'ECONNRESET', 'validateToken', 'PROJ-142', 'config.yaml'),
  fc.stringMatching(/^[a-z]{3,6}\/[a-z]{3,6}\.(ts|py)$/),
);
const sentence = fc.array(fc.oneof({ weight: 8, arbitrary: word }, { weight: 1, arbitrary: ident }), { minLength: 1, maxLength: 40 }).map((w) => w.join(' '));
const bigText = fc.integer({ min: 0, max: 3000 }).map((n) => filler(n, 'x'));

const metaArb = fc.record({
  pinned: fc.integer({ min: 0, max: 9 }).map((n) => n < 2),
  tags: fc.constantFrom([], ['decision'], ['note']),
  ttl: fc.option(fc.constantFrom(1, 10_000_000_000_000), { nil: undefined }),
});

const cycle = fc
  .record({
    k: fc.integer({ min: 0, max: 3 }),
    text: sentence,
    results: fc.array(fc.record({ text: fc.oneof(sentence, bigText), isError: fc.boolean() }), { minLength: 3, maxLength: 3 }),
    metas: fc.array(metaArb, { minLength: 4, maxLength: 4 }),
  })
  .map(({ k, text, results, metas }, ) => ({ k, text, results, metas }));

export const transcriptArb: fc.Arbitrary<Item[]> = fc
  .record({
    withSystem: fc.boolean(),
    first: sentence,
    cycles: fc.array(cycle, { minLength: 0, maxLength: 25 }),
    trailing: fc.constantFrom<'user' | 'assistant-open' | 'result'>('user', 'assistant-open', 'result'),
    last: sentence,
  })
  .map(({ withSystem, first, cycles, trailing, last }) => {
    const drafts: Draft[] = [];
    if (withSystem) drafts.push(sys('system prompt'));
    drafts.push(user(first));
    let n = 0;
    cycles.forEach((c, ci) => {
      const calls = Array.from({ length: c.k }, (_, j) => ({ id: `c${ci}_${j}`, name: ['read_file', 'grep', 'bash'][j % 3]!, input: { i: n++ } }));
      drafts.push(assistant(c.text, calls, strip(c.metas[0]!)));
      calls.forEach((call, j) => drafts.push(result(call.id, c.results[j]!.text, { isError: c.results[j]!.isError, ...strip(c.metas[j + 1]!) })));
    });
    if (trailing === 'user') drafts.push(user(last));
    else if (trailing === 'assistant-open') drafts.push(assistant('working', [{ id: 'open_call', name: 'read_file', input: {} }]));
    else if (drafts[drafts.length - 1]?.kind !== 'tool_result') drafts.push(assistant(last));
    return build(drafts);
  });

function strip(m: { pinned: boolean; tags: string[]; ttl: number | undefined }): Partial<RawItem['meta']> {
  const out: Partial<RawItem['meta']> = { pinned: m.pinned, tags: m.tags };
  if (m.ttl !== undefined) out.ttl = m.ttl;
  return out;
}

export const policyArb = fc.record({
  budget: fc
    .record({ max: fc.integer({ min: 2_000, max: 60_000 }), reserveFrac: fc.double({ min: 0, max: 0.4 }), targetFrac: fc.double({ min: 0.3, max: 1 }) })
    .map(({ max, reserveFrac, targetFrac }) => {
      const reserve = Math.floor(max * reserveFrac);
      const limit = max - reserve;
      return { max, reserve, target: Math.max(1, Math.floor(limit * targetFrac)) };
    }),
  protect: fc.record({
    latestUserTurns: fc.integer({ min: 1, max: 2 }),
    recentTurns: fc.integer({ min: 0, max: 6 }),
    pinned: fc.boolean(),
    tags: fc.constantFrom([], ['decision']),
  }),
  toolResults: fc
    .record({
      maxTokensEach: fc.constantFrom(0, 300, 1000),
      evictAfterTurns: fc.integer({ min: 0, max: 8 }),
      keepErrors: fc.boolean(),
      keepLatestPerTool: fc.integer({ min: 0, max: 2 }),
    })
    .map((t) => ({ ...t, headTokens: Math.floor(t.maxTokensEach * 0.5), tailTokens: Math.floor(t.maxTokensEach * 0.2), volatile: ['bash'] })),
  resurface: fc.record({ identifiers: fc.boolean(), repeatToolCalls: fc.boolean(), maxItems: fc.integer({ min: 0, max: 4 }), maxTokensEach: fc.constant(500) }),
  cache: fc.constant({ batchEvictions: true }),
});
