#!/usr/bin/env node
/**
 * Replay a transcript through four strategies and report what each one sends,
 * caches, loses, and finds. Deterministic; no model involved.
 *
 *   node bench/replay.mjs transcript.json [--limit 40000] [--target 28000] [--cache-read 0.1] [--json]
 *
 * Strategies:
 *   full        send everything (what a harness does until it can't)
 *   sliding     drop the oldest units until under the limit; no archive
 *   clear-tools clear the oldest tool results to a placeholder (provider-side
 *               context editing, as Anthropic's clear_tool_uses does), then slide
 *   windowkeeper keep() with a persistent archive and the same limit
 *
 * Token counts use the heuristic tokenizer, so treat absolute numbers as
 * estimates; the comparison between strategies is what the benchmark is for.
 */
import { readFileSync } from 'node:fs';
import { fromAnthropic } from '../dist/adapters/anthropic.js';
import { MemoryArchive, extractIdentifiers, groupUnits, heuristicTokenizer, keep, prepare, totalTokens } from '../dist/index.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node bench/replay.mjs <transcript.json> [--limit N] [--target N] [--json]');
  process.exit(1);
}
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : Number(process.argv[i + 1]);
};
const LIMIT = arg('--limit', 40_000);
const TARGET = arg('--target', 28_000);
const JSON_OUT = process.argv.includes('--json');
// Price of a cache-read token relative to an uncached one. Anthropic and OpenAI both bill cache reads at 0.1x.
const CACHE_READ = arg('--cache-read', 0.1);

const transcript = fromAnthropic(JSON.parse(readFileSync(file, 'utf8')));
const all = prepare(transcript, heuristicTokenizer);
const callPoints = [];
for (let i = 0; i < all.length; i++) if (all[i].kind === 'assistant') callPoints.push(i);

// What a person referred back to: identifiers in fresh user messages that match earlier items.
const fullArchive = new MemoryArchive();
for (const it of all) if (it.kind !== 'stub' && it.kind !== 'view' && it.kind !== 'recalled') fullArchive.put(it);
// One entry per (call, identifier): the ids of earlier items that contain it. A hit is any one of them in full.
const mentions = [];
for (const at of callPoints) {
  const last = all[at - 1];
  if (!last || last.kind !== 'user') continue;
  const text = last.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const wanted = [];
  for (const ident of extractIdentifiers(text)) {
    const ids = fullArchive.findByIdentifier(ident.value).filter((m) => m.turn < last.turn && m.kind !== 'system').map((m) => m.id);
    if (ids.length) wanted.push(ids);
  }
  if (wanted.length) mentions.push({ at, wanted });
}

const policy = {
  budget: { max: LIMIT, reserve: 0, target: TARGET },
  protect: { recentTurns: 4 },
  toolResults: { maxTokensEach: 3000, headTokens: 1800, tailTokens: 600, evictAfterTurns: 6, keepLatestPerTool: 1 },
};

const strategies = {
  full: () => (req) => req,
  sliding: () => (req) => slide(req, LIMIT, TARGET),
  'clear-tools': () => (req) => slide(clearTools(req, LIMIT, TARGET), LIMIT, TARGET),
  windowkeeper: () => {
    const archive = new MemoryArchive();
    let call = 0;
    return (req) => keep(req, policy, { archive, call: ++call, strict: true }).window;
  },
};

function slide(req, limit, target) {
  if (totalTokens(req) <= limit) return req;
  const units = groupUnits(req);
  const drop = new Set();
  let total = totalTokens(req);
  const lastUserIndex = req.map((i) => i.kind).lastIndexOf('user');
  for (const u of units) {
    if (total <= target) break;
    const head = req[u.indices[0]];
    if (head.kind === 'system' || u.indices[0] >= lastUserIndex) continue;
    for (const i of u.indices) drop.add(i);
    total -= u.tokens;
  }
  return req.filter((_, i) => !drop.has(i));
}

function clearTools(req, limit, target) {
  if (totalTokens(req) <= limit) return req;
  let total = totalTokens(req);
  const out = [...req];
  const keepLast = 3;
  let seen = 0;
  const idxs = [];
  for (let i = out.length - 1; i >= 0; i--) if (out[i].kind === 'tool_result') { if (seen++ >= keepLast) idxs.unshift(i); }
  for (const i of idxs) {
    if (total <= target) break;
    const it = out[i];
    const cleared = { ...it, blocks: [{ type: 'text', text: '[tool result cleared]' }], meta: { ...it.meta, tokens: 8, truncated: true } };
    total -= it.meta.tokens - 8;
    out[i] = cleared;
  }
  return out;
}

function sig(item) {
  return item.id + ':' + item.meta.tokens + ':' + (item.kind === 'tool_result' && item.meta.truncated ? 't' : '');
}

const results = {};
for (const [name, make] of Object.entries(strategies)) {
  const run = make();
  let sent = 0;
  let cached = 0;
  let max = 0;
  let prev = [];
  let mentionHits = 0;
  let mentionTotal = 0;
  let invalidations = 0;
  let finalWindow = [];
  let mi = 0;
  for (const at of callPoints) {
    const req = all.slice(0, at);
    const win = run(req);
    const tokens = totalTokens(win);
    sent += tokens;
    if (tokens > max) max = tokens;
    // Prefix cache: tokens shared with the previous request's window, in order.
    let shared = 0;
    for (let i = 0; i < Math.min(prev.length, win.length); i++) {
      if (sig(prev[i]) !== sig(win[i])) break;
      shared += win[i].meta.tokens;
    }
    cached += shared;
    // A call whose window is not a pure extension of the previous one re-bills the whole prefix.
    if (prev.length && shared < totalTokens(prev)) invalidations++;
    prev = win;
    finalWindow = win;
    if (mi < mentions.length && mentions[mi].at === at) {
      const present = new Set(win.filter((i) => i.kind !== 'stub' && !(i.kind === 'tool_result' && i.meta.truncated)).map((i) => i.id));
      const recalled = new Set(win.filter((i) => i.kind === 'recalled').map((i) => i.ref));
      for (const ids of mentions[mi].wanted) {
        mentionTotal++;
        if (ids.some((id) => present.has(id) || recalled.has(id))) mentionHits++;
      }
      mi++;
    }
  }
  const inFull = new Set(finalWindow.filter((i) => i.kind !== 'stub' && i.kind !== 'recalled' && !(i.kind === 'tool_result' && i.meta.truncated)).map((i) => i.id));
  const raw = all.slice(0, callPoints[callPoints.length - 1]).filter((i) => i.kind !== 'system');
  const notInFull = raw.filter((i) => !inFull.has(i.id)).length;
  const recoverable = name === 'windowkeeper' ? notInFull : 0;
  results[name] = {
    calls: callPoints.length,
    tokensSent: sent,
    meanPerCall: Math.round(sent / callPoints.length),
    maxPerCall: max,
    cacheReuse: sent ? cached / sent : 0,
    costWeightedTokens: Math.round(sent - cached + cached * CACHE_READ),
    cacheInvalidations: invalidations,
    itemsOutOfWindow: notInFull,
    itemsLost: notInFull - recoverable,
    mentionHitRate: mentionTotal ? mentionHits / mentionTotal : null,
    mentionTotal,
  };
}

if (JSON_OUT) {
  console.log(JSON.stringify({ file, limit: LIMIT, target: TARGET, items: all.length, calls: callPoints.length, results }, null, 2));
  process.exit(0);
}

const fmt = (n) => n.toLocaleString('en-US');
const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
console.log(`replay ${file}`);
console.log(`items ${all.length}, model calls ${callPoints.length}, limit ${fmt(LIMIT)} tokens, target ${fmt(TARGET)}, tokenizer heuristic\n`);
console.log('| strategy | tokens sent | cache reuse | cache invalidations | cost-weighted tokens | items out of window | items lost | mentions answerable |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const [name, r] of Object.entries(results)) {
  console.log(`| ${name} | ${fmt(r.tokensSent)} | ${pct(r.cacheReuse)} | ${fmt(r.cacheInvalidations)} | ${fmt(r.costWeightedTokens)} | ${fmt(r.itemsOutOfWindow)} | ${fmt(r.itemsLost)} | ${pct(r.mentionHitRate)} (${r.mentionTotal}) |`);
}
console.log(`\ncost-weighted tokens = uncached tokens + cached tokens x ${CACHE_READ} (the cache-read price at Anthropic and OpenAI). cache invalidations = calls whose request was not a pure extension of the previous one, so the prompt-cache prefix was re-billed. items lost = out of the final window with no way back. mentions answerable = when a user message named a file, symbol, or error from earlier, how often at least one item containing it was in the request in full.`);
