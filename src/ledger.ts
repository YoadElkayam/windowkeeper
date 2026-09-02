/**
 * The ledger. One entry per decision, one summary per call.
 *
 * This is what a harness author greps when the agent "forgot" something, and
 * what the CLI renders. Entries are plain objects so any sink can serialize them.
 */

export type LedgerAction =
  | 'recall'
  | 'rehydrate'
  | 'truncate'
  | 'evict'
  | 'expire'
  | 'fold'
  | 'trim'
  | 'keep'
  | 'replay'
  | 'violation'
  | 'summary';

export interface LedgerEntry {
  call: number;
  rule: string;
  action: LedgerAction;
  /** Window id of the item acted on. */
  item?: string;
  /** Archive ids involved. */
  refs?: string[];
  tokensBefore?: number;
  tokensAfter?: number;
  detail?: string;
}

export interface LedgerSummary extends LedgerEntry {
  action: 'summary';
  tokensBefore: number;
  tokensAfter: number;
  budgetTripped: boolean;
  /** New moves decided this call. */
  moved: number;
  /** Moves replayed from the standing plan. */
  replayed: number;
  recalled: number;
  /** Deepest turn whose items are unchanged from the input, for cache reasoning. */
  prefixIntactToTurn: number;
  tokenizer: string;
}

export type LedgerSink = (entry: LedgerEntry) => void;

export class Ledger {
  readonly entries: LedgerEntry[] = [];
  constructor(
    readonly call: number,
    private readonly sink?: LedgerSink,
  ) {}

  add(entry: Omit<LedgerEntry, 'call'>): void {
    const full: LedgerEntry = { call: this.call, ...entry };
    this.entries.push(full);
    this.sink?.(full);
  }

  get moved(): number {
    return this.entries.filter((e) =>
      e.action === 'evict' || e.action === 'trim' || e.action === 'expire' || e.action === 'fold' || e.action === 'truncate',
    ).length;
  }

  get recalled(): number {
    return this.entries.filter((e) => e.action === 'recall' || e.action === 'rehydrate' || e.action === 'keep').length;
  }
}

/** Render entries as JSON Lines. */
export function toJsonl(entries: LedgerEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}
