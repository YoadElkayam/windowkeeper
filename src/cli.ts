#!/usr/bin/env node
/**
 * windowkeeper explain <transcript.json> [-p policy.json] [--ledger out.jsonl] [--json]
 *
 * Transcript is Anthropic Messages shape: { "system"?: ..., "messages": [...] }.
 * Prints the window before and after, every ledger entry, and what is recoverable.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fromAnthropic } from './adapters/anthropic.js';
import { MemoryArchive } from './archive.js';
import { keep } from './keep.js';
import { toJsonl, type LedgerEntry } from './ledger.js';
import type { PolicyInput } from './policy.js';

const argv = process.argv.slice(2);
const command = argv[0];

if (command !== 'explain' || argv.length < 2) {
  usage();
  process.exit(command === '--help' || command === '-h' ? 0 : 1);
}

const transcriptPath = argv[1]!;
let policyPath: string | undefined;
let ledgerPath: string | undefined;
let json = false;
for (let i = 2; i < argv.length; i++) {
  const a = argv[i]!;
  if ((a === '-p' || a === '--policy') && argv[i + 1]) policyPath = argv[++i];
  else if (a === '--ledger' && argv[i + 1]) ledgerPath = argv[++i];
  else if (a === '--json') json = true;
  else {
    console.error(`unknown argument: ${a}`);
    usage();
    process.exit(1);
  }
}

const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Parameters<typeof fromAnthropic>[0];
const policy: PolicyInput = policyPath ? (JSON.parse(readFileSync(policyPath, 'utf8')) as PolicyInput) : {};
const archive = new MemoryArchive();
const items = fromAnthropic(transcript);
const result = keep(items, policy, { archive });

if (ledgerPath) writeFileSync(ledgerPath, toJsonl(result.ledger));

if (json) {
  console.log(JSON.stringify({ summary: result.summary, ledger: result.ledger, window: result.window }, null, 2));
  process.exit(0);
}

const s = result.summary;
console.log(`windowkeeper explain ${transcriptPath}`);
console.log(`policy      ${policyPath ?? '(defaults)'}`);
console.log(`tokenizer   ${s.tokenizer}${s.tokenizer === 'heuristic' ? ' (estimate, not billing)' : ''}`);
console.log(`items       ${items.length} in, ${result.window.length} out, ${archive.size} archived`);
console.log(`tokens      ${fmt(s.tokensBefore)} -> ${fmt(s.tokensAfter)}  limit ${fmt(result.policy.budget.max - result.policy.budget.reserve)}  target ${fmt(result.policy.budget.target)}`);
console.log(`trigger     ${s.budgetTripped ? 'budget tripped' : 'under budget, window untouched'}`);
console.log(`prefix      intact through turn ${s.prefixIntactToTurn}`);
console.log(`moved       ${s.moved} new, ${s.replayed} replayed from the standing plan   recalled ${s.recalled}`);
console.log('');

const rows = result.ledger.filter((e) => e.action !== 'summary');
if (rows.length === 0) {
  console.log('no decisions this call');
} else {
  console.log(pad('action', 10) + pad('rule', 30) + pad('item', 20) + pad('tokens', 16) + 'detail');
  for (const e of rows) console.log(row(e));
}

if (result.violations.length) {
  console.log('');
  console.log('INVARIANT VIOLATIONS (call degraded to no-op):');
  for (const v of result.violations) console.log(`  [${v.invariant}] ${v.name}: ${v.detail}`);
  process.exit(2);
}

function row(e: LedgerEntry): string {
  const tokens =
    e.tokensBefore !== undefined && e.tokensAfter !== undefined
      ? `${fmt(e.tokensBefore)} -> ${fmt(e.tokensAfter)}`
      : e.tokensBefore !== undefined
        ? `${fmt(e.tokensBefore)} ->`
        : e.tokensAfter !== undefined
          ? `+${fmt(e.tokensAfter)}`
          : '';
  return pad(e.action, 10) + pad(e.rule, 30) + pad(e.item ?? '', 20) + pad(tokens, 16) + (e.detail ?? '');
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function usage(): void {
  console.error('usage: windowkeeper explain <transcript.json> [-p policy.json] [--ledger out.jsonl] [--json]');
}
