import type { RecallRecord } from '../archive.js';
import { recalledId, stubId } from '../ids.js';
import { extractIdentifiers } from '../identifiers.js';
import { countItem, sliceByTokens } from '../tokenizer.js';
import { itemText, type Item, type RawItem, type RecalledItem, type UserItem } from '../types.js';
import type { ReducerContext } from './context.js';

const SPECIFIC_KINDS = new Set(['path', 'file', 'code', 'quote', 'errcode', 'ref', 'uuid']);
const MAX_IDENTIFIERS_SCANNED = 24;

/**
 * Deterministic proactive recall.
 *
 * When the last item is a fresh user message, identifiers in it are matched
 * against the archive and the matches are recorded against that message. On
 * this and every later call, the records for each user message still in the
 * window are applied:
 *
 * - a match present in full is protected while its message is recent
 * - a match that is a stub is rehydrated in place while its message is recent
 * - a match absent from the window is inserted right after its message as a
 *   recalled item, on every call, until trim removes it (which forgets it)
 *
 * Replaying the records is what keeps each window a pure extension of the
 * previous one, so the prompt cache holds across re-surfacing.
 */
export function resurface(items: Item[], ctx: ReducerContext): Item[] {
  const { policy, archive, ledger, tokenizer, currentTurn, protectedIds } = ctx;
  if (!policy.resurface.identifiers || policy.resurface.maxItems === 0) return items;

  const position = new Map<string, number>();
  const stubIndexByRef = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    position.set(item.id, i);
    if (item.kind === 'stub') for (const ref of item.refs) stubIndexByRef.set(ref, i);
  }

  const last = items[items.length - 1];
  const freshId = last && last.kind === 'user' && archive.recallsFor(last.id) === undefined ? last.id : undefined;
  if (freshId && last?.kind === 'user') archive.rememberRecalls(freshId, matchIdentifiers(last, ctx, position));
  let latestUserId: string | undefined;
  for (let i = items.length - 1; i >= 0 && !latestUserId; i--) if (items[i]!.kind === 'user') latestUserId = items[i]!.id;

  const out: Item[] = [...items];
  const insertAfter = new Map<number, RecalledItem[]>();
  const recentFrom = currentTurn - policy.protect.recentTurns + 1;

  for (let i = 0; i < items.length; i++) {
    const anchor = items[i]!;
    if (anchor.kind !== 'user') continue;
    const records = archive.recallsFor(anchor.id);
    if (!records || records.length === 0) continue;
    const fresh = anchor.id === freshId;
    // The latest user message always counts as recent here, whether or not its records already exist.
    const recent = anchor.id === latestUserId || anchor.turn >= recentFrom;

    for (const { ref, identifier } of records) {
      const pos = position.get(ref);
      if (pos !== undefined) {
        if (recent && !protectedIds.has(ref)) {
          protectedIds.add(ref);
          if (fresh) {
            ledger.add({
              rule: 'resurface.identifiers',
              action: 'keep',
              item: ref,
              refs: [ref],
              detail: `"${identifier}" in latest user message matched turn ${items[pos]!.turn}; kept in full this call`,
            });
          }
        }
        continue;
      }
      const stubPos = stubIndexByRef.get(ref);
      if (stubPos !== undefined) {
        if (!recent) continue;
        const match = archive.get(ref);
        if (!match) continue;
        const restored = structuredClone(match) as RawItem;
        restored.meta.tokens = countItem(restored, tokenizer);
        out[stubPos] = restored;
        protectedIds.add(ref);
        ledger.add({
          rule: 'resurface.identifiers',
          action: 'rehydrate',
          item: stubId(ref),
          refs: [ref],
          tokensBefore: items[stubPos]!.meta.tokens,
          tokensAfter: restored.meta.tokens,
          detail: `"${identifier}" in user message at turn ${anchor.turn} matched turn ${match.turn}`,
        });
        continue;
      }
      const match = archive.get(ref);
      if (!match) continue;
      const recalled = renderRecalled(match, anchor, identifier, ctx);
      const list = insertAfter.get(i) ?? [];
      list.push(recalled);
      insertAfter.set(i, list);
      if (fresh) {
        ledger.add({
          rule: 'resurface.identifiers',
          action: 'recall',
          item: recalled.id,
          refs: [ref],
          tokensAfter: recalled.meta.tokens,
          detail: `"${identifier}" in latest user message matched turn ${match.turn}`,
        });
      }
    }
  }

  if (insertAfter.size === 0) return out;
  const result: Item[] = [];
  for (let i = 0; i < out.length; i++) {
    result.push(out[i]!);
    const extra = insertAfter.get(i);
    if (extra) result.push(...extra);
  }
  return result;
}

/** Identifiers in a fresh user message, matched against the archive, capped by policy. */
function matchIdentifiers(last: UserItem, ctx: ReducerContext, position: Map<string, number>): RecallRecord[] {
  const { policy, archive } = ctx;
  const identifiers = extractIdentifiers(itemText(last)).filter((id) => SPECIFIC_KINDS.has(id.kind) || id.value.length >= 8);
  const records: RecallRecord[] = [];
  const used = new Set<string>();
  for (const ident of identifiers.slice(0, MAX_IDENTIFIERS_SCANNED)) {
    if (records.length >= policy.resurface.maxItems) break;
    for (const match of archive.findByIdentifier(ident.value)) {
      if (records.length >= policy.resurface.maxItems) break;
      if (used.has(match.id) || match.id === last.id || match.kind === 'system') continue;
      // Skip matches that only appear after the message (a later call re-sending the same message).
      const pos = position.get(match.id);
      if (pos !== undefined && pos > (position.get(last.id) ?? Infinity)) continue;
      used.add(match.id);
      records.push({ ref: match.id, identifier: ident.value });
    }
  }
  return records;
}

function renderRecalled(match: RawItem, anchor: UserItem, identifier: string, ctx: ReducerContext): RecalledItem {
  const { policy, tokenizer } = ctx;
  const label = match.kind === 'tool_result' ? `${match.tool ?? 'tool'} result` : match.kind === 'assistant' ? 'assistant message' : 'user message';
  const full = itemText(match);
  const budget = policy.resurface.maxTokensEach;
  const body =
    tokenizer.count(full) > budget
      ? `${sliceByTokens(full, budget, 'head', tokenizer)}\n[windowkeeper] truncated; recall({ id: "${match.id}" }) for the full item`
      : full;
  const text = `[windowkeeper recalled ${label} from turn ${match.turn}, matched "${identifier}", archive id ${match.id}]\n${body}`;
  const item: RecalledItem = {
    kind: 'recalled',
    id: recalledId(`${anchor.id}:${match.id}`),
    ref: match.id,
    anchor: anchor.id,
    match: identifier,
    turn: anchor.turn,
    text,
    meta: { tokens: 0, pinned: false, tags: [], source: 'resurface' },
  };
  item.meta.tokens = countItem(item, tokenizer);
  return item;
}
