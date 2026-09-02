import { recalledId, stubId } from '../ids.js';
import { extractIdentifiers } from '../identifiers.js';
import { countItem, sliceByTokens } from '../tokenizer.js';
import { itemText, type Item, type RawItem, type RecalledItem } from '../types.js';
import type { ReducerContext } from './context.js';

const SPECIFIC_KINDS = new Set(['path', 'file', 'code', 'quote', 'errcode', 'ref', 'uuid']);
const MAX_IDENTIFIERS_SCANNED = 24;

/**
 * Deterministic proactive recall.
 *
 * Runs only when the last item is a fresh user message. Identifiers in that
 * message are matched against the archive. A match still in the window in full
 * is protected for this call so later reducers leave it alone. A match that is
 * currently a stub is rehydrated in place. A match not in the window at all is
 * appended after the user message as a recalled item, so the stable prefix is
 * untouched.
 */
export function resurface(items: Item[], ctx: ReducerContext): Item[] {
  const { policy, archive, ledger, tokenizer } = ctx;
  if (!policy.resurface.identifiers || policy.resurface.maxItems === 0) return items;
  const last = items[items.length - 1];
  if (!last || last.kind !== 'user') return items;

  const identifiers = extractIdentifiers(itemText(last)).filter(
    (id) => SPECIFIC_KINDS.has(id.kind) || id.value.length >= 8,
  );
  if (identifiers.length === 0) return items;

  const inWindow = new Set<string>();
  const stubIndexByRef = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    inWindow.add(item.id);
    if (item.kind === 'stub') for (const ref of item.refs) stubIndexByRef.set(ref, i);
    if (item.kind === 'recalled') inWindow.add(item.ref);
  }

  const out = [...items];
  const appended: RecalledItem[] = [];
  const used = new Set<string>();
  let count = 0;

  for (const ident of identifiers.slice(0, MAX_IDENTIFIERS_SCANNED)) {
    if (count >= policy.resurface.maxItems) break;
    for (const match of archive.findByIdentifier(ident.value)) {
      if (count >= policy.resurface.maxItems) break;
      if (used.has(match.id) || match.id === last.id || match.kind === 'system') continue;
      const stubIndex = stubIndexByRef.get(match.id);
      if (stubIndex !== undefined) {
        const restored = structuredClone(match) as RawItem;
        restored.meta.tokens = countItem(restored, tokenizer);
        out[stubIndex] = restored;
        used.add(match.id);
        count++;
        ledger.add({
          rule: 'resurface.identifiers',
          action: 'rehydrate',
          item: stubId(match.id),
          refs: [match.id],
          tokensBefore: items[stubIndex]!.meta.tokens,
          tokensAfter: restored.meta.tokens,
          detail: `"${ident.value}" in latest user message matched turn ${match.turn}`,
        });
        continue;
      }
      if (inWindow.has(match.id)) {
        if (ctx.protectedIds.has(match.id)) continue;
        ctx.protectedIds.add(match.id);
        used.add(match.id);
        count++;
        ledger.add({
          rule: 'resurface.identifiers',
          action: 'keep',
          item: match.id,
          refs: [match.id],
          detail: `"${ident.value}" in latest user message matched turn ${match.turn}; kept in full this call`,
        });
        continue;
      }
      const recalled = renderRecalled(match, ident.value, ctx);
      appended.push(recalled);
      used.add(match.id);
      count++;
      ledger.add({
        rule: 'resurface.identifiers',
        action: 'recall',
        item: recalled.id,
        refs: [match.id],
        tokensAfter: recalled.meta.tokens,
        detail: `"${ident.value}" in latest user message matched turn ${match.turn}`,
      });
    }
  }

  return appended.length ? [...out, ...appended] : out;
}

function renderRecalled(match: RawItem, identifier: string, ctx: ReducerContext): RecalledItem {
  const { policy, tokenizer, currentTurn } = ctx;
  const label =
    match.kind === 'tool_result'
      ? `${match.tool ?? 'tool'} result`
      : match.kind === 'assistant'
        ? 'assistant message'
        : 'user message';
  const full = itemText(match);
  const budget = policy.resurface.maxTokensEach;
  const body =
    tokenizer.count(full) > budget
      ? `${sliceByTokens(full, budget, 'head', tokenizer)}\n[windowkeeper] truncated; recall({ id: "${match.id}" }) for the full item`
      : full;
  const text = `[windowkeeper recalled ${label} from turn ${match.turn}, matched "${identifier}", archive id ${match.id}]\n${body}`;
  const item: RecalledItem = {
    kind: 'recalled',
    id: recalledId(match.id),
    ref: match.id,
    match: identifier,
    turn: currentTurn,
    text,
    meta: { tokens: 0, pinned: false, tags: [], source: 'resurface' },
  };
  item.meta.tokens = countItem(item, tokenizer);
  return item;
}
