import type { Archive } from './archive.js';
import { archiveRef } from './ids.js';
import type { LedgerEntry } from './ledger.js';
import type { Policy } from './policy.js';
import { totalTokens } from './tokenizer.js';
import { isRaw, safeJson, type Item } from './types.js';

/**
 * The ten invariants from docs/invariants.md, as checks. `keep()` runs them
 * after every call. In strict mode a violation throws; otherwise it is written
 * to the ledger and the call degrades to a no-op.
 *
 * Invariant 4 (no hindsight rewrite) concerns views and lands with them in v0.2.
 * Invariant 6 (determinism) is a property of the whole function and is tested
 * by running it twice; it cannot be checked from one output.
 */
export interface Violation {
  invariant: number;
  name: string;
  detail: string;
}

export interface InvariantInput {
  input: Item[];
  output: Item[];
  policy: Policy;
  archive: Archive;
  ledger: LedgerEntry[];
  budgetTripped: boolean;
  expiredAny: boolean;
}

export function checkInvariants(x: InvariantInput): Violation[] {
  const v: Violation[] = [];
  const { input, output, policy, archive } = x;

  // 1. Lossless: every raw input item and every reference in the output is in the archive.
  for (const item of input) {
    if (isRaw(item) && !archive.has(item.id)) v.push({ invariant: 1, name: 'lossless', detail: `input ${item.id} not in archive` });
  }
  for (const item of output) {
    const refs = item.kind === 'stub' ? item.refs : item.kind === 'recalled' ? [item.ref] : item.kind === 'view' ? item.covers : [];
    for (const ref of refs) if (!archive.has(ref)) v.push({ invariant: 1, name: 'lossless', detail: `${item.id} references ${ref} which is not in archive` });
    if (item.kind === 'tool_result' && item.meta.truncated && !archive.has(item.id))
      v.push({ invariant: 1, name: 'lossless', detail: `truncated ${item.id} not in archive` });
  }

  // 2. Latest user turn byte-identical.
  const inUser = lastOfKind(input, 'user');
  const outUser = lastOfKind(output, 'user');
  if (inUser) {
    if (!outUser || outUser.id !== inUser.id) v.push({ invariant: 2, name: 'latest-user', detail: 'latest user item missing or replaced' });
    else if (safeJson(strip(inUser)) !== safeJson(strip(outUser))) v.push({ invariant: 2, name: 'latest-user', detail: 'latest user item content changed' });
  }

  // 3. No orphan tool calls.
  const seenUses = new Map<string, number>();
  const answered = new Set<string>();
  let lastAssistantIndex = -1;
  for (let i = 0; i < output.length; i++) {
    const item = output[i]!;
    if (item.kind === 'assistant') {
      lastAssistantIndex = i;
      for (const b of item.blocks) if (b.type === 'tool_use') seenUses.set(b.id, i);
    }
    const callId = item.kind === 'tool_result' ? item.callId : item.kind === 'stub' ? item.callId : undefined;
    if (callId) {
      if (!seenUses.has(callId)) v.push({ invariant: 3, name: 'no-orphans', detail: `${item.kind} ${item.id} answers unknown call ${callId}` });
      answered.add(callId);
    }
  }
  for (const [callId, index] of seenUses) {
    if (!answered.has(callId)) {
      const trailing = index === lastAssistantIndex && !output.slice(index + 1).some((it) => it.kind === 'assistant' || it.kind === 'user');
      if (!trailing) v.push({ invariant: 3, name: 'no-orphans', detail: `tool_use ${callId} has no result` });
    }
  }

  // 5. Budget holds, or the ledger says why not.
  const limit = policy.budget.max - policy.budget.reserve;
  const outTokens = totalTokens(output);
  if (outTokens > limit && !x.ledger.some((e) => e.rule === 'budget.unshrinkable')) {
    v.push({ invariant: 5, name: 'budget', detail: `window is ${outTokens} tokens, limit ${limit}` });
  }

  // 7. Order and position preserved: refs present in input appear in input order.
  const inputIndex = new Map<string, number>();
  input.forEach((it, i) => inputIndex.set(it.id, i));
  let cursor = -1;
  for (const item of output) {
    if (item.kind === 'recalled') continue;
    const idx = inputIndex.get(archiveRef(item));
    if (idx === undefined) continue;
    if (idx < cursor) v.push({ invariant: 7, name: 'order', detail: `${item.id} out of order` });
    cursor = idx;
  }

  // 8. Pinned never removed or altered.
  const outById = new Map(output.map((it) => [it.id, it] as const));
  for (const item of input) {
    if (!policy.protect.pinned || !item.meta.pinned) continue;
    const o = outById.get(item.id);
    if (!o) v.push({ invariant: 8, name: 'pinned', detail: `pinned ${item.id} removed` });
    else if (safeJson(strip(item)) !== safeJson(strip(o))) v.push({ invariant: 8, name: 'pinned', detail: `pinned ${item.id} altered` });
  }

  // 9. Under budget means untouched, except re-surfacing and expiry.
  if (!x.budgetTripped && !x.expiredAny) {
    const core = output.filter((it) => it.kind !== 'recalled');
    const same =
      core.length === input.length &&
      core.every((it, i) => {
        const orig = input[i]!;
        return it.id === orig.id && safeJson(strip(it)) === safeJson(strip(orig));
      });
    if (!same) {
      // Rehydration replaces a stub that was already in the input; allow that.
      const onlyRehydrated =
        core.length === input.length &&
        core.every((it, i) => {
          const orig = input[i]!;
          return it.id === orig.id || (orig.kind === 'stub' && orig.refs[0] === it.id);
        });
      if (!onlyRehydrated) v.push({ invariant: 9, name: 'untouched-under-budget', detail: 'window changed without a trigger' });
    }
  }

  // 10. Every move is in the ledger.
  const outRefs = new Set<string>();
  for (const item of output) {
    outRefs.add(item.id);
    outRefs.add(archiveRef(item));
  }
  const ledgered = new Set(x.ledger.flatMap((e) => (e.item ? [e.item] : [])));
  for (const item of input) {
    if (!outRefs.has(item.id) && !ledgered.has(item.id)) v.push({ invariant: 10, name: 'ledgered', detail: `${item.id} left the window without a ledger entry` });
  }

  return v;
}

function lastOfKind(items: Item[], kind: Item['kind']): Item | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === kind) return items[i];
  return undefined;
}

/** Content comparison ignores token counts, which depend on the tokenizer. */
function strip(item: Item): unknown {
  const { meta, ...rest } = item;
  const { tokens: _tokens, ...metaRest } = meta;
  return { ...rest, meta: metaRest };
}
