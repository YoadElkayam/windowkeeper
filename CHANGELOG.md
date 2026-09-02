# Changelog

## 0.1.0

First release.

- `keep()`: pure, synchronous, zero-dependency core with an append-only archive
  and deterministic reducers: resurface, expire, replay, truncate, evict, trim.
- Plan replay: the decisions of the last re-plan are stored in the archive and
  replayed on every call; `keep()` re-plans only when the replayed window
  crosses the limit. On a real 385-call session this took prompt-cache
  invalidations from 168 to 8.
- Re-surfacing records are stored per user message and replayed, so recalled
  items stay in place across calls.
- Ten-invariant conformance battery, property-tested over generated transcripts
  and checked after every call.
- Ledger: one JSON line per decision, one summary per call.
- Adapters: Anthropic Messages, OpenAI Chat Completions, Vercel AI SDK (as
  `wrapLanguageModel` middleware).
- `recall` tool definitions for all three, plus `serveFromArchive()` for
  opt-in repeat-call answering.
- CLI: `windowkeeper explain`.
- Benchmark: `bench/replay.mjs` compares full, sliding, clear-tools, and
  windowkeeper on any transcript; `bench/claude-session.mjs` replays a Claude
  Code session log locally.

Originally prototyped in March 2026 as `@echostash/subconscious`; rebuilt from
scratch around a lossless archive.
