/**
 * OpenAI Chat Completions + windowkeeper.
 *
 *   OPENAI_API_KEY=... npx tsx examples/openai.ts
 */
import OpenAI from 'openai';
import { handleRecall, keep, MemoryArchive, recallToolOpenAI } from 'windowkeeper';
import { fromOpenAI, toOpenAI, type OpenAIMessage } from 'windowkeeper/openai';

const client = new OpenAI();
const archive = new MemoryArchive();
const policy = { budget: { max: 20_000, target: 12_000, reserve: 4_000 }, toolResults: { evictAfterTurns: 3 } };

const tools = [
  { type: 'function' as const, function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  recallToolOpenAI,
];

const files: Record<string, string> = {
  'src/auth/session.ts': 'export function refreshSession(id: string) { /* 400 lines */ }\n' + 'line\n'.repeat(400),
  'src/db/pool.ts': 'export const POOL_SIZE = 12;\n' + 'line\n'.repeat(300),
};

const messages: OpenAIMessage[] = [
  { role: 'system', content: 'You are a terse coding agent. Use tools when you need file contents.' },
  { role: 'user', content: 'Read src/auth/session.ts and src/db/pool.ts, then tell me the pool size.' },
];

for (let step = 0; step < 8; step++) {
  const { window, summary } = keep(fromOpenAI(messages), policy, { archive, call: step + 1 });
  console.log(`call ${step + 1}: ${summary.tokensBefore} -> ${summary.tokensAfter} tokens, moved ${summary.moved}, recalled ${summary.recalled}`);

  const completion = await client.chat.completions.create({ model: 'gpt-4.1-mini', messages: toOpenAI(window) as OpenAI.ChatCompletionMessageParam[], tools });
  const choice = completion.choices[0]!.message;
  messages.push({ role: 'assistant', content: choice.content, tool_calls: choice.tool_calls as OpenAIMessage extends { tool_calls?: infer T } ? T : never });
  if (!choice.tool_calls?.length) {
    console.log(choice.content);
    break;
  }
  for (const call of choice.tool_calls) {
    if (call.type !== 'function') continue;
    const input = JSON.parse(call.function.arguments) as { path?: string; id?: string };
    const content = call.function.name === 'recall' ? handleRecall(archive, input) : (files[input.path ?? ''] ?? `no such file: ${input.path}`);
    messages.push({ role: 'tool', tool_call_id: call.id, content });
  }
}
