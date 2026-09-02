# Lossless Context Policy: the invariants

These are the contract. Every adapter, the CLI, and the proxy must satisfy them.
They are property-tested over generated transcripts in
[`test/invariants.property.test.ts`](../test/invariants.property.test.ts) and
checked after every `keep()` call in [`src/invariants.ts`](../src/invariants.ts).

Terms: the **transcript** is what the harness holds. The **window** is what
`keep()` returns for this model call. The **archive** holds every raw item ever
seen. A **turn** is one model call.

1. **Lossless.** Every raw item that has ever been in the transcript is
   recoverable from the archive by id, byte-identical. Every stub, truncation
   marker, view, and recalled item in the window carries the ids that recover it.
2. **Latest user turn is byte-identical.** The most recent user item appears in
   the window unchanged.
3. **No orphan tool calls.** Every tool result or stub in the window answers a
   tool_use that precedes it, and every tool_use is answered unless it is the
   trailing assistant item awaiting execution.
4. **No hindsight rewrite.** A view covering a span is a function of that span
   and earlier views only. Later turns cannot change it. *(Lands with views in v0.2.)*
5. **Budget holds.** Window tokens are at or below `budget.max - budget.reserve`,
   or the ledger carries a `budget.unshrinkable` entry naming why.
6. **Deterministic.** Same input, policy, and archive produce the same window and
   the same ledger.
7. **Order and position preserved.** The window is a subsequence of the input,
   with stubs and views in the positions of what they replace. Recalled items
   sit right after the user message that mentioned them.
8. **Pinned items are never removed or altered.**
9. **Under budget means no new decisions.** If the budget did not trip and
   nothing expired, every item is in the window in full unless its move is a
   replay of the standing plan or a re-surfacing decision. Between re-plans each
   window is the previous window plus what the harness appended, so the prompt
   cache prefix survives.
10. **Every move is in the ledger** with a rule id, the ids involved, and the
    tokens it changed.

## Why these ten

Invariants 1 and 4 are the difference between this and compaction. Invariant 3
is the most common bug in hand-rolled context trimming; providers reject the
request. Invariant 9 is the cost argument: a policy that edits the middle of the
transcript on every turn pays full price for the whole prefix every time.
