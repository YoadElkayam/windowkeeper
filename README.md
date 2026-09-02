# windowkeeper

[![CI](https://github.com/YoadElkayam/windowkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/YoadElkayam/windowkeeper/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/windowkeeper)](https://www.npmjs.com/package/windowkeeper)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Lossless context management for AI agent harnesses.**
The archive is the truth, the window is a view, and the ledger says what moved where.

> Compaction loses context. windowkeeper doesn't.

Every harness that compacts loses context: it summarizes from the point of view
of the last few turns and throws the older thread away. windowkeeper never
summarizes over the original and never deletes. Every message and tool result
is kept verbatim in an archive. The window the model sees holds recent turns in
full, older tool results as addressable stubs, and whatever the user just
referred to. Anything can come back, by id or by being mentioned.

Deterministic. Synchronous. Zero runtime dependencies. No model call on the hot
path. Works with the Anthropic SDK, the OpenAI SDK, the Vercel AI SDK, and
anything that can hand over a transcript.

## Numbers

Replaying a real 385-call Claude Code session under a 60k-token limit
([method and full tables](docs/benchmark.md)):

| strategy | cache reuse | cache invalidations | cost-weighted tokens | items lost |
|---|---:|---:|---:|---:|
| sliding window | 67% | 115 | 5,574,641 | 659 |
| clear old tool results (provider-style) | 68% | 171 | 5,577,628 | 679 |
| **windowkeeper** | **97%** | **8** | **1,990,117** | **0** |

Cost-weighted counts cached tokens at the cache-read price. windowkeeper
re-plans only when its replayed window crosses the limit, so almost every
request is the previous one plus what the harness appended, and the prompt
cache holds. Everything it moves out of the window stays one `recall` call
away. Run it on your own session:

```
node bench/claude-session.mjs ~/.claude/projects/<project>/<session>.jsonl
```

## Install

```
npm install windowkeeper
```

Not yet published; clone and `pnpm build` until 0.1.0 lands on npm.

## Use it

### Vercel AI SDK

```ts
import { generateText, jsonSchema, tool, wrapLanguageModel } from 'ai';
import { MemoryArchive } from 'windowkeeper';
import { recallInputSchema, recallToolAiSdk, windowkeeperMiddleware } from 'windowkeeper/ai-sdk';

const archive = new MemoryArchive(); // one per session

const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-5'),
  middleware: windowkeeperMiddleware({ archive, policy: { budget: { max: 120_000, target: 80_000, reserve: 16_000 } } }),
});

await generateText({
  model,
  messages,
  tools: { ...yourTools, recall: tool({ ...recallToolAiSdk(archive), inputSchema: jsonSchema<{ id: string }>(recallInputSchema) }) },
});
```

### Anthropic SDK

```ts
import { handleRecall, keep, MemoryArchive, recallToolAnthropic } from 'windowkeeper';
import { fromAnthropic, toAnthropic } from 'windowkeeper/anthropic';

const archive = new MemoryArchive();

// before every call
const { window, ledger } = keep(fromAnthropic({ system, messages }), policy, { archive });
const response = await client.messages.create({ model, max_tokens, tools: [...tools, recallToolAnthropic], ...toAnthropic(window) });

// when the model calls recall
if (toolUse.name === 'recall') result = handleRecall(archive, toolUse.input);
```

### OpenAI SDK

```ts
import { handleRecall, keep, MemoryArchive, recallToolOpenAI } from 'windowkeeper';
import { fromOpenAI, toOpenAI } from 'windowkeeper/openai';

const { window } = keep(fromOpenAI(messages), policy, { archive });
await client.chat.completions.create({ model, messages: toOpenAI(window), tools: [...tools, recallToolOpenAI] });
```

Runnable versions of all three are in [`examples/`](examples/). `keep()` is
pure over its inputs; the harness keeps owning the transcript, and the archive
is the only thing windowkeeper keeps between calls.

## How it works

```
transcript (what the harness holds)
   │
   ▼
 keep(transcript, policy, { archive })       synchronous, deterministic
   ├─ archive every raw item                 nothing is ever deleted
   ├─ resurface   the user named a file? it stays in full, or comes back
   ├─ expire      TTLs
   ├─ replay      the standing plan: same stubs, same truncations, same drops
   ├─ only if the replayed window is over the limit, re-plan in one batch:
   │    truncate  big tool results keep head + tail, marker carries the archive id
   │    evict     old tool results become stubs in place, tool call stays paired
   │    trim      oldest units leave, down to target
   ├─ check the ten invariants
   └─ write the ledger
   │
   ▼
 window (what the model sees)  +  ledger  +  archive
```

The model gets one tool, `recall({ id })`. Every stub, truncation marker, and
recalled item names the id to pass to it.

## Policy

Policy is data. Every key is optional; defaults suit a coding agent on a 200k
model. The full reference is [docs/policy.md](docs/policy.md).

```json
{
  "budget": { "max": 160000, "target": 110000, "reserve": 16000 },
  "protect": { "latestUserTurns": 1, "recentTurns": 6, "pinned": true, "tags": ["decision"] },
  "toolResults": { "maxTokensEach": 4000, "evictAfterTurns": 8, "keepErrors": true, "keepLatestPerTool": 1 },
  "resurface": { "identifiers": true, "maxItems": 4 }
}
```

## The ledger

One JSON line per decision, one summary per call. This is what you grep when
the agent "forgot" something.

```
$ npx windowkeeper explain docs/examples/transcript.json -p docs/examples/policy.json

tokens      13,736 -> 2,507  limit 5,500  target 3,500
trigger     budget tripped
moved       16 new, 0 replayed from the standing plan   recalled 2

action    rule                          item          tokens          detail
keep      resurface.identifiers         cc53b06fac2f                  "src/auth/redis.ts" in latest user message matched turn 3; kept in full this call
truncate  toolResults.maxTokensEach     72dd8f4db78d  1,147 -> 504    read_file at turn 2; kept head 350 + tail 120
evict     toolResults.evictAfterTurns   76e09c97975b  504 -> 45       bash at turn 4, age 10
```

## The invariants

Ten rules, property-tested over generated transcripts and checked after every
call. The full list is in [docs/invariants.md](docs/invariants.md).

1. **Lossless.** Everything is recoverable from the archive by id, byte-identical.
2. **Latest user turn is byte-identical.**
3. **No orphan tool calls.** Providers reject transcripts that break this.
5. **Budget holds**, or the ledger names the protected set that made it impossible.
9. **Under budget means no new decisions.** The cache prefix survives.

The battery caught three real bugs in the reducers before the first commit.
Open an issue with any transcript shape that breaks one; that is the most
valuable contribution this project can get.

## Why not just compact

| | Compaction | windowkeeper |
|---|---|---|
| Original content | discarded | archived verbatim |
| Written from | hindsight, when nearly full | never rewritten |
| Recovery | none | by id, or by mention |
| Prompt cache | re-billed on every edit | held between re-plans |
| Auditable | no | ledger per decision |
| Model in the loop | yes, on the critical path | no |
| Provider | usually one | any, including local |

Related work that arrived at the same conclusion this year: ARC (addressable
recall compaction, arXiv 2607.25066), Volt's lossless context management,
remnic's LCM, and the Governance Decay paper on what compaction silently
removes. windowkeeper is the pattern as a drop-in for any harness, with a
conformance battery and a ledger.

## Roadmap

- **0.1** core, Anthropic and OpenAI adapters, AI SDK middleware, `recall`, CLI, conformance battery, benchmark
- **0.2** views: fresh per-span summaries over the archive that never replace it; proxy mode (`ANTHROPIC_BASE_URL`); file and SQLite archives
- **0.3** semantic re-surfacing backend, Claude Agent SDK hook, LangGraph and Mastra adapters, OpenTelemetry

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The core stays zero-dependency and
synchronous; every reducer decision writes a ledger entry; nothing is ever
deleted.

## License

[MIT](LICENSE)
