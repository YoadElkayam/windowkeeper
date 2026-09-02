import type { Archive } from '../archive.js';
import type { Ledger } from '../ledger.js';
import type { Policy } from '../policy.js';
import type { Tokenizer } from '../tokenizer.js';

/** Everything a reducer needs. Reducers are pure over `items` and this context. */
export interface ReducerContext {
  policy: Policy;
  tokenizer: Tokenizer;
  archive: Archive;
  ledger: Ledger;
  currentTurn: number;
  now: number;
  protectedIds: Set<string>;
}
