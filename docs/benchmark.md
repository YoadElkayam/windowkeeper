# Benchmark

Deterministic replay of a transcript through four strategies. No model is
involved; the question is what each strategy sends, what it re-bills, what it
loses, and whether it still has what the user just asked about.

```
pnpm bench                                     # synthetic 160-call coding session
node bench/replay.mjs transcript.json          # any Anthropic-shaped transcript
node bench/claude-session.mjs ~/.claude/projects/<project>/<session>.jsonl   # your own Claude Code session
```

The Claude Code replay reads the session log, rebuilds the main-chain
transcript, runs the benchmark, and prints numbers. Nothing is written to disk
and nothing leaves the machine.

## Strategies

| Strategy | What it does |
|---|---|
| full | sends everything; the no-limit baseline |
| sliding | drops the oldest units until under the limit; no archive |
| clear-tools | clears the oldest tool results to a placeholder, keeping the last three, then slides; this is what provider-side context editing does |
| windowkeeper | `keep()` with a persistent archive, replaying its plan between trips |

All four use the same limit and target. windowkeeper's policy for the runs
below: `recentTurns: 4`, `maxTokensEach: 3000`, `evictAfterTurns: 6`,
`keepLatestPerTool: 1`.

## Metrics

- **tokens sent**: sum over all model calls.
- **cache reuse**: share of sent tokens that were a prefix of the previous
  request, which is what prompt caching bills at the cache-read price.
- **cache invalidations**: calls whose request was not a pure extension of the
  previous one, so the whole prefix was re-billed.
- **cost-weighted tokens**: uncached tokens plus cached tokens at 0.1x, the
  cache-read price at both Anthropic and OpenAI. `--cache-read` changes the ratio.
- **items out of window**: items not in the final request in full.
- **items lost**: out of the window with no way back. windowkeeper's archive
  makes this zero by construction; the benchmark checks it.
- **mentions answerable**: when a user message named a file, symbol, or error
  from earlier, how often at least one item containing it was in the request in
  full.

Token counts use the heuristic tokenizer, so absolute numbers are estimates.
The comparison between strategies on the same input is what matters.

## Results

### Synthetic coding session, limit 40k, target 28k

161 model calls, 324 items. `node bench/synth.mjs` with the default seed.

| strategy | tokens sent | cache reuse | cache invalidations | cost-weighted tokens | items out of window | items lost | mentions answerable |
|---|---:|---:|---:|---:|---:|---:|---:|
| full | 11,287,521 | 99% | 0 | 1,258,923 | 0 | 0 | 100% (13) |
| sliding | 4,059,476 | 66% | 48 | 1,632,622 | 258 | 258 | 92% (13) |
| clear-tools | 4,027,848 | 67% | 51 | 1,609,907 | 131 | 131 | 100% (13) |
| windowkeeper | 4,150,443 | 94% | 8 | 641,244 | 258 | 0 | 100% (13) |

### A real Claude Code session, limit 100k, target 70k

385 model calls, 790 items, from one of the author's own sessions (an
afternoon building an MCP proxy). Content is not included; the numbers are
reproducible on any session with `bench/claude-session.mjs`.

| strategy | tokens sent | cache reuse | cache invalidations | cost-weighted tokens | items out of window | items lost | mentions answerable |
|---|---:|---:|---:|---:|---:|---:|---:|
| full | 27,844,033 | 99% | 0 | 2,932,868 | 0 | 0 | 100% (195) |
| sliding | 21,103,060 | 74% | 78 | 7,099,659 | 552 | 552 | 100% (195) |
| clear-tools | 21,724,539 | 83% | 93 | 5,551,667 | 568 | 568 | 100% (195) |
| windowkeeper | 22,634,301 | 98% | 4 | 2,616,956 | 556 | 0 | 99% (195) |

### The same session, limit 60k, target 40k

| strategy | tokens sent | cache reuse | cache invalidations | cost-weighted tokens | items out of window | items lost | mentions answerable |
|---|---:|---:|---:|---:|---:|---:|---:|
| full | 27,844,033 | 99% | 0 | 2,932,868 | 0 | 0 | 100% (195) |
| sliding | 14,013,295 | 67% | 115 | 5,574,641 | 659 | 659 | 100% (195) |
| clear-tools | 14,446,936 | 68% | 171 | 5,577,628 | 679 | 679 | 99% (195) |
| windowkeeper | 15,875,671 | 97% | 8 | 1,990,117 | 619 | 0 | 99% (195) |

## Reading the results

windowkeeper sends 7 to 13 percent more raw tokens than sliding, because it
does not shave the window on every call. It re-plans only when the replayed
window crosses the limit, and between re-plans each request is the previous one
plus what the harness appended. That is why its cache reuse sits at 94 to 98
percent against 66 to 83 percent for the others, and why its cost-weighted
tokens come out 2.5 to 2.8 times lower. Prompt caching turns "touch the
transcript as rarely as possible" into the dominant cost lever.

The `full` row is the no-limit baseline. It is cheap per token because it never
changes anything, and it is not an option: its requests reach 145k to 165k
tokens, past the limits these runs simulate.

`items lost` is the row the project exists for. Every other strategy discards
hundreds of items per session with no way back. windowkeeper moves the same
number out of the window and keeps all of them one `recall` call away.

## What the benchmark does not measure

Task success. Whether an agent completes its work better with windowkeeper than
with compaction needs a model in the loop and a task set; that is planned as a
separate, slower benchmark. What this one measures is deterministic and cheap
enough to run on every commit: the mechanical cost of each strategy and what it
throws away.
