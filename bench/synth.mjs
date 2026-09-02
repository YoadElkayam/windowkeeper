#!/usr/bin/env node
/**
 * Generate a deterministic, realistic long coding-agent session in Anthropic
 * Messages shape. No model involved; the point is a reproducible input for
 * `bench/replay.mjs`.
 *
 *   node bench/synth.mjs out.json [--calls 160] [--seed 7]
 */
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node bench/synth.mjs <out.json> [--calls N] [--seed S]');
  process.exit(1);
}
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : Number(process.argv[i + 1]);
};
const CALLS = arg('--calls', 160);
let seed = arg('--seed', 7);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));

const dirs = ['src/auth', 'src/api', 'src/db', 'src/lib', 'src/ui', 'test/auth', 'test/api', 'scripts'];
const names = ['session', 'token', 'pool', 'retry', 'router', 'cache', 'logger', 'config', 'user', 'billing', 'queue', 'metrics'];
const files = [];
for (const d of dirs) for (let i = 0; i < 4; i++) files.push(`${d}/${pick(names)}${i ? i : ''}.ts`);
const symbols = ['validateToken', 'refreshSession', 'PoolExhausted', 'withRetry', 'ECONNRESET', 'ETIMEDOUT', 'parseUserId', 'BillingCycle', 'enqueueJob', 'flushMetrics'];

function codeLines(file, n) {
  const lines = [`// ${file}`];
  for (let i = 0; i < n; i++) {
    const s = pick(symbols);
    lines.push(
      pick([
        `export function ${s}${i}(input: string): string { return input.trim(); }`,
        `const ${s.toLowerCase()}_${i} = await ${s}(ctx, { retries: ${int(1, 5)}, timeoutMs: ${int(100, 5000)} });`,
        `if (err.code === '${pick(['ECONNRESET', 'ETIMEDOUT', 'ENOENT'])}') throw new ${s}Error(err.message);`,
        `// TODO(${pick(['auth', 'db', 'api'])}): ${s} still leaks on ${pick(files)} line ${int(10, 400)}`,
        `logger.info('${s}', { file: '${pick(files)}', took: ${int(1, 900)} });`,
      ]),
    );
  }
  return lines.join('\n');
}

const messages = [];
const system = 'You are a careful coding agent working in a TypeScript monorepo. Prefer minimal diffs. Run tests after every change.';
const asks = [
  `The auth flow breaks after a redis restart: ${pick(files)} throws ${pick(symbols)}. Find the cause and fix it.`,
  `Now make sure ${pick(files)} handles ${pick(symbols)} the same way. Keep the diff small.`,
  `Something in ${pick(files)} regressed. Earlier you looked at ${pick(files)}; what did it export?`,
  `Add a test for ${pick(symbols)} in ${pick(files)} and run the suite.`,
  `Summarize what changed and open a PR. Mention ${pick(symbols)} and ${pick(files)}.`,
];
messages.push({ role: 'user', content: asks[0] });

let callIndex = 0;
let askIndex = 1;
const askEvery = Math.floor(CALLS / asks.length);
while (callIndex < CALLS) {
  const tool = pick(['read_file', 'read_file', 'grep', 'bash', 'edit_file']);
  const file = pick(files);
  const id = `toolu_${String(callIndex).padStart(4, '0')}`;
  let input;
  let body;
  let isError = false;
  switch (tool) {
    case 'read_file':
      input = { path: file };
      body = codeLines(file, int(40, 220));
      break;
    case 'grep':
      input = { pattern: pick(symbols), path: pick(dirs) };
      body = Array.from({ length: int(3, 30) }, () => `${pick(files)}:${int(1, 400)}: ${codeLines(file, 1).split('\n')[1]}`).join('\n');
      break;
    case 'bash':
      input = { cmd: pick([`pnpm vitest run ${file}`, 'pnpm tsc --noEmit', `git diff --stat`, `pnpm lint`]) };
      isError = rand() < 0.2;
      body = isError
        ? `FAIL ${file}\n  ${pick(symbols)} > returns session\n  AssertionError: expected ${int(1, 9)} to be ${int(1, 9)}\n` + codeLines(file, int(10, 60))
        : `✓ ${file} (${int(3, 40)} tests) ${int(5, 900)}ms\n` + codeLines(file, int(5, 120));
      break;
    default:
      input = { path: file, old: `return input;`, new: `return input.trim();` };
      body = `edited ${file}: 1 replacement`;
  }
  messages.push({
    role: 'assistant',
    content: [{ type: 'text', text: pick([`Checking ${file}.`, `Looking for ${pick(symbols)}.`, `Running the tests.`, `Applying the fix.`]) }, { type: 'tool_use', id, name: tool, input }],
  });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body, ...(isError ? { is_error: true } : {}) }] });
  callIndex++;
  if (callIndex % askEvery === 0 && askIndex < asks.length) {
    messages.push({ role: 'assistant', content: `Done with that step. ${pick(symbols)} in ${file} was the cause.` });
    messages.push({ role: 'user', content: asks[askIndex++] });
    callIndex++;
  }
}
messages.push({ role: 'assistant', content: 'All steps complete.' });
messages.push({ role: 'user', content: `Before we finish: what did ${files[3]} look like when you first read it, and did ${symbols[0]} ever throw?` });

writeFileSync(out, JSON.stringify({ system, messages }));
console.error(`wrote ${out}: ${messages.length} messages, ${CALLS} tool calls`);
