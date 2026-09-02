# windowkeeper

**Lossless context management for AI agent harnesses.**
The archive is the truth, the window is a view, and the ledger says what moved where.

> Compaction loses context. windowkeeper doesn't.

Every harness that compacts loses context: it summarizes from the point of view
of the last few turns and throws the older thread away. windowkeeper never
summarizes over the original and never deletes. Every message and tool result
is kept verbatim in an archive. The window the model sees holds recent turns in
full, older tool results as addressable stubs, and anything the user just
referred to. Anything can come back, by id or by being mentioned.

Deterministic. Synchronous. Zero runtime dependencies. No model call on the hot
path. Works with any provider, any harness, and local models.

## Status

Pre-release scaffold. The core, the Anthropic adapter, the `recall` tool, the
CLI, and the ten-invariant conformance battery are in place. Not yet on npm.
See [Roadmap](#roadmap).

## How it works

```
transcript (what the harness holds)
   │
   ▼
 keep(transcript, policy)                  synchronous, deterministic
   ├─ archive every raw item               nothing is ever deleted
   ├─ resurface                            the user named a file? it stays, or comes back
   ├─ expire                               TTLs
   ├─ if over budget:                      one batch, cache-friendly
   │    truncate  big tool results keep head + tail, marker carries the archive id
   │    evict     old tool results become stubs in place, tool call stays paired
   │    trim      oldest units leave, down to target
   ├─ check the ten invariants
   └─ write the ledger
   │
   ▼
 window (what the model sees)  +  ledger  +  archive
```

The model gets one tool, `recall({ id })`, and every stub and marker names the
id to pass to it.

## Quick start

```ts
import { keep, MemoryArchive, recallToolAnthropic, handleRecall } from 'windowkeeper';
import { fromAnthropic, toAnthropic } from 'windowkeeper/anthropic';

const archive = new MemoryArchive(); // keep one per session

// before every model call
const items = fromAnthropic({ system, messages });
const { window, ledger, summary } = keep(items, policy, { archive });
const response = await client.messages.create({
  model,
  max_tokens,
  ...toAnthropic(window),
  tools: [...tools, recallToolAnthropic],
});

// when the model calls recall
if (toolUse.name === 'recall') {
  const text = handleRecall(archive, toolUse.input);
}
```

`keep()` is pure over its inputs. The harness keeps owning the transcript; the
archive is the only thing windowkeeper keeps between calls.

## Policy

Policy is data. Every key is optional. Defaults suit a coding agent on a 200k
model; see [docs/policy.md](docs/policy.md) for every key.

```json
{
  "budget": { "max": 160000, "target": 110000, "reserve": 16000 },
  "protect": { "latestUserTurns": 1, "recentTurns": 6, "pinned": true, "tags": ["decision"] },
  "toolResults": { "maxTokensEach": 4000, "evictAfterTurns": 8, "keepErrors": true, "keepLatestPerTool": 1 },
  "resurface": { "identifiers": true, "maxItems": 4 }
}
```

Nothing runs while under budget except re-surfacing and expiry, so the prompt
cache prefix survives between triggers. When the budget trips, everything
eligible moves in one batch.

## The ledger

One JSON line per decision, one summary per call. This is what you grep when
the agent "forgot" something.

```
keep      resurface.identifiers   a1f3…   "src/auth/redis.ts" in latest user message matched turn 4; kept in full this call
truncate  toolResults.maxTokensEach 7c1…  1,412 -> 498   bash at turn 9; kept head 350 + tail 120
evict     toolResults.evictAfterTurns 8f2… 934 -> 41     read_file at turn 2, age 11
summary   call                              12,904 -> 3,377  prefix intact through turn 1
```

Run it on the example:

```
npx windowkeeper explain docs/examples/transcript.json -p docs/examples/policy.json
```

## The invariants

Ten rules, property-tested over generated transcripts, checked after every call.
The full list is in [docs/invariants.md](docs/invariants.md). The ones that matter most:

1. **Lossless.** Everything is recoverable from the archive by id, byte-identical.
2. **Latest user turn is byte-identical.**
3. **No orphan tool calls.** Providers reject transcripts that break this.
5. **Budget holds**, or the ledger names the protected set that made it impossible.
9. **Under budget means untouched.** The cache prefix survives.

## Why not just compact

| | Compaction | windowkeeper |
|---|---|---|
| Original content | discarded | archived verbatim |
| Written from | hindsight, when nearly full | never rewritten |
| Recovery | none | by id, or by mention |
| Auditable | no | ledger per decision |
| Model in the loop | yes, on the critical path | no |
| Provider | usually one | any, including local |

Related work that arrived at the same conclusion: ARC (addressable recall,
arXiv 2607.25066), Volt's lossless context management, remnic's LCM, and the
Governance Decay paper on what compaction silently removes. windowkeeper is the
pattern as a drop-in for any harness.

## Roadmap

- **v0.1** core, Anthropic adapter, `recall` tool, CLI, conformance battery, OpenAI adapter, Vercel AI SDK middleware
- **v0.2** views (fresh per-span summaries over the archive, never from hindsight), cache metrics, replay corpus with published numbers, proxy mode
- **v0.3** semantic re-surfacing backend, Claude Agent SDK hook, LangGraph and Mastra adapters, OpenTelemetry, SQLite archive

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The cheapest valuable contribution is a
transcript shape that breaks an invariant.

## License

[MIT](LICENSE)
