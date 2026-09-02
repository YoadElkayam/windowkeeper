/**
 * Vercel AI SDK + windowkeeper, as middleware.
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/ai-sdk.ts
 *
 * Swap the provider for any AI SDK provider; the middleware is provider-neutral.
 */
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, jsonSchema, stepCountIs, tool, wrapLanguageModel } from 'ai';
import { MemoryArchive, toJsonl, type LedgerEntry } from 'windowkeeper';
import { recallInputSchema, recallToolAiSdk, windowkeeperMiddleware } from 'windowkeeper/ai-sdk';

const archive = new MemoryArchive();
const ledger: LedgerEntry[] = [];

const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-5'),
  middleware: windowkeeperMiddleware({
    archive,
    policy: { budget: { max: 20_000, target: 12_000, reserve: 4_000 }, toolResults: { evictAfterTurns: 3 } },
    ledger: (e) => ledger.push(e),
    onCall: ({ summary }) => console.log(`call ${summary.call}: ${summary.tokensBefore} -> ${summary.tokensAfter} tokens, moved ${summary.moved}, recalled ${summary.recalled}`),
  }),
});

const files: Record<string, string> = {
  'src/auth/session.ts': 'export function refreshSession(id: string) { /* 400 lines */ }\n' + 'line\n'.repeat(400),
  'src/db/pool.ts': 'export const POOL_SIZE = 12;\n' + 'line\n'.repeat(300),
};

const result = await generateText({
  model,
  system: 'You are a terse coding agent. Use tools when you need file contents.',
  prompt: 'Read src/auth/session.ts and src/db/pool.ts, then tell me the pool size.',
  tools: {
    read_file: tool({
      description: 'Read a file from the demo repository',
      inputSchema: jsonSchema<{ path: string }>({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }),
      execute: async ({ path }) => files[path] ?? `no such file: ${path}`,
    }),
    recall: tool({ ...recallToolAiSdk(archive), inputSchema: jsonSchema<{ id: string }>(recallInputSchema) }),
  },
  stopWhen: stepCountIs(8),
});

console.log(result.text);
console.log('\nledger:\n' + toJsonl(ledger));
