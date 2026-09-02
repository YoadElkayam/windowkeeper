import { argsHash } from './ids.js';
import { extractIdentifiers, normalize } from './identifiers.js';
import { isRaw, itemText, safeJson, type Item, type RawItem } from './types.js';

/**
 * The archive is the truth. Every raw item that ever enters `keep()` is written
 * here before any reducer runs. Nothing is ever deleted.
 *
 * Synchronous by design so the core stays a pure function. A persistent backend
 * loads into memory on construction and persists writes on its own schedule.
 */
export interface Archive {
  put(item: RawItem): void;
  get(id: string): RawItem | undefined;
  has(id: string): boolean;
  /** Items whose text contains the identifier, newest first. */
  findByIdentifier(identifier: string): RawItem[];
  /** The most recent result of `tool` called with identical arguments. */
  findToolResult(tool: string, args: unknown): RawItem | undefined;
  readonly size: number;
}

export class MemoryArchive implements Archive {
  private readonly items = new Map<string, RawItem>();
  private readonly byIdentifier = new Map<string, Set<string>>();
  private readonly byToolCall = new Map<string, string>();

  put(item: RawItem): void {
    if (this.items.has(item.id)) return;
    // Store a frozen copy so later reducers cannot mutate the truth.
    const copy = structuredClone(item);
    Object.freeze(copy);
    this.items.set(item.id, copy);

    const text = indexableText(item);
    for (const ident of extractIdentifiers(text)) {
      const key = normalize(ident.value);
      let set = this.byIdentifier.get(key);
      if (!set) {
        set = new Set();
        this.byIdentifier.set(key, set);
      }
      set.add(item.id);
    }
    if (item.kind === 'tool_result' && item.tool && !item.isError) {
      this.byToolCall.set(argsHash(item.tool, item.args), item.id);
    }
  }

  get(id: string): RawItem | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  findByIdentifier(identifier: string): RawItem[] {
    const ids = this.byIdentifier.get(normalize(identifier));
    if (!ids) return [];
    const out: RawItem[] = [];
    for (const id of ids) {
      const item = this.items.get(id);
      if (item) out.push(item);
    }
    return out.sort((a, b) => b.turn - a.turn);
  }

  findToolResult(tool: string, args: unknown): RawItem | undefined {
    const id = this.byToolCall.get(argsHash(tool, args));
    return id ? this.items.get(id) : undefined;
  }

  get size(): number {
    return this.items.size;
  }

  /** All items, oldest first. Used by persistent backends and the CLI. */
  entries(): RawItem[] {
    return [...this.items.values()].sort((a, b) => a.turn - b.turn);
  }
}

/** Write every raw item in a transcript to the archive. Idempotent. */
export function archiveAll(items: Item[], archive: Archive): number {
  let written = 0;
  for (const item of items) {
    if (isRaw(item) && !archive.has(item.id)) {
      archive.put(item);
      written++;
    }
  }
  return written;
}

function indexableText(item: RawItem): string {
  const parts = [itemText(item)];
  if (item.kind === 'tool_result') {
    if (item.tool) parts.push(item.tool);
    if (item.args !== undefined) parts.push(safeJson(item.args));
  }
  return parts.join('\n');
}
