#!/usr/bin/env node
/**
 * Replay one of your own Claude Code sessions through the benchmark.
 *
 *   node bench/claude-session.mjs ~/.claude/projects/<project>/<session>.jsonl [--limit N] [--target N] [--json]
 *
 * Reads the session log, rebuilds the main-chain transcript in Anthropic
 * Messages shape, and hands it to bench/replay.mjs. Nothing is written to disk
 * and nothing leaves the machine; only the numbers are printed. Thinking blocks
 * are dropped, since they are not re-sent on later turns.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node bench/claude-session.mjs <session.jsonl> [--limit N] [--target N] [--json]');
  process.exit(1);
}

const messages = [];
let lastAssistantId = null;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || !o.message) continue;
  const m = o.message;
  if (m.role === 'assistant') {
    const blocks = (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }])
      .filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking')
      .map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : { type: 'text', text: `[${b.type}]` }));
    if (!blocks.length) continue;
    // Claude Code writes one line per content block with a shared message id; merge them.
    if (m.id && m.id === lastAssistantId && messages[messages.length - 1]?.role === 'assistant') {
      messages[messages.length - 1].content.push(...blocks);
    } else {
      messages.push({ role: 'assistant', content: blocks });
      lastAssistantId = m.id ?? null;
    }
    continue;
  }
  if (m.role === 'user') {
    lastAssistantId = null;
    if (typeof m.content === 'string') {
      if (m.content.startsWith('<local-command') || m.content.startsWith('<command-')) continue;
      messages.push({ role: 'user', content: m.content });
      continue;
    }
    const blocks = [];
    for (const b of m.content ?? []) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        blocks.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content, ...(b.is_error ? { is_error: true } : {}) });
      } else if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } });
    }
    if (blocks.length) messages.push({ role: 'user', content: blocks });
  }
}

// Drop tool results whose tool_use is not in the transcript (sidechain leftovers).
const known = new Set();
for (const m of messages) if (m.role === 'assistant') for (const b of m.content) if (b.type === 'tool_use') known.add(b.id);
for (const m of messages) if (m.role === 'user' && Array.isArray(m.content)) m.content = m.content.filter((b) => b.type !== 'tool_result' || known.has(b.tool_use_id));
const cleaned = messages.filter((m) => !(Array.isArray(m.content) && m.content.length === 0));

const dir = mkdtempSync(join(tmpdir(), 'windowkeeper-'));
const tmp = join(dir, 'session.json');
writeFileSync(tmp, JSON.stringify({ messages: cleaned }));
try {
  const r = spawnSync(process.execPath, [new URL('./replay.mjs', import.meta.url).pathname, tmp, ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
