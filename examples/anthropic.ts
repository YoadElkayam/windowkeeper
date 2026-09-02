/**
 * Anthropic Messages API + windowkeeper.
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/anthropic.ts
 *
 * A small agent loop with one tool. The archive lives for the session; every
 * request goes through keep(); the model gets `recall` alongside your tools.
 */
import Anthropic from '@anthropic-ai/sdk';
import { handleRecall, keep, MemoryArchive, recallToolAnthropic, toJsonl, type LedgerEntry } from 'windowkeeper';
import { fromAnthropic, toAnthropic, type AnthropicMessage } from 'windowkeeper/anthropic';

const client = new Anthropic();
const archive = new MemoryArchive();
const ledger: LedgerEntry[] = [];
const policy = { budget: { max: 20_000, target: 12_000, reserve: 4_000 }, toolResults: { evictAfterTurns: 3 } };

const tools: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the demo repository',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  recallToolAnthropic,
];

const files: Record<string, string> = {
  'src/auth/session.ts': 'export function refreshSession(id: string) { /* 400 lines */ }\n' + 'line\n'.repeat(400),
  'src/db/pool.ts': 'export const POOL_SIZE = 12;\n' + 'line\n'.repeat(300),
};

const system = 'You are a terse coding agent. Use tools when you need file contents.';
const messages: AnthropicMessage[] = [{ role: 'user', content: 'Read src/auth/session.ts and src/db/pool.ts, then tell me the pool size.' }];

for (let step = 0; step < 8; step++) {
  const { window, summary } = keep(fromAnthropic({ system, messages }), policy, { archive, call: step + 1, ledger: (e) => ledger.push(e) });
  console.log(`call ${step + 1}: ${summary.tokensBefore} -> ${summary.tokensAfter} tokens, moved ${summary.moved}, recalled ${summary.recalled}`);

  const params = toAnthropic(window);
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    tools,
    ...(params.system ? { system: params.system as string } : {}),
    messages: params.messages as Anthropic.MessageParam[],
  });
  messages.push({ role: 'assistant', content: response.content as AnthropicMessage['content'] });
  if (response.stop_reason !== 'tool_use') {
    console.log(response.content.find((b) => b.type === 'text')?.text);
    break;
  }
  const results: AnthropicMessage['content'] = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    const input = block.input as { path?: string; id?: string };
    const content = block.name === 'recall' ? handleRecall(archive, input) : (files[input.path ?? ''] ?? `no such file: ${input.path}`);
    results.push({ type: 'tool_result', tool_use_id: block.id, content });
  }
  messages.push({ role: 'user', content: results });
}

console.log('\nledger:\n' + toJsonl(ledger));
