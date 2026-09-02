# Policy reference

Policy is a plain object. Every key is optional; missing keys take the defaults
in [`src/policy.ts`](../src/policy.ts). The same object drives `keep()`, the
middleware, the CLI, and the proxy. `resolvePolicy()` validates it and throws a
`PolicyError` with a specific message on a bad value.

```jsonc
{
  "budget": {
    "max": 160000,      // hard ceiling on window tokens, including reserve
    "target": 110000,   // where to land when the trigger fires
    "reserve": 16000    // headroom for the reply; trigger fires at max - reserve
  },
  "protect": {
    "latestUserTurns": 1,           // last N user items and everything after them
    "recentTurns": 6,               // items from the last N model calls
    "pinned": true,                 // honor meta.pinned
    "tags": ["decision", "requirement"]
  },
  "toolResults": {
    "maxTokensEach": 4000,          // truncate above this; 0 disables
    "headTokens": 2400,
    "tailTokens": 800,
    "evictAfterTurns": 8,           // stub results older than this; 0 disables
    "keepErrors": true,             // never evict error results
    "keepLatestPerTool": 1,         // keep the N newest results of each tool in full
    "volatile": ["bash", "fetch"]   // never serve a repeat of these from the archive
  },
  "resurface": {
    "identifiers": true,            // match identifiers in the new user message
    "repeatToolCalls": false,       // serve identical repeat calls from archive; opt-in
    "maxItems": 4,
    "maxTokensEach": 2000
  },
  "cache": {
    "batchEvictions": true
  }
}
```

## What runs when

| Stage | Runs | Changes the window? |
|---|---|---|
| resurface | every call; decisions are recorded per user message the first time it is seen and replayed after | inserts recalled items after the message that mentioned them; protects or rehydrates matches while that message is recent |
| expire | every call | items past `meta.ttl` |
| replay | every call, once a plan exists | the same drops, stubs, and truncations as the last re-plan; no new decisions |
| truncate, evict, trim | only when the replayed window exceeds `max - reserve` | in one batch, down to `target`; the result becomes the new plan |

Between re-plans every window is the previous window plus whatever the harness
appended, so the prompt-cache prefix survives. The plan and the re-surfacing
records live in the archive; pass the same archive on every call.

## Protection

An item is protected when any of these hold: it is a system item; it is pinned
and `protect.pinned` is true; it carries a tag in `protect.tags`; it is from the
last `protect.recentTurns` model calls; it is one of the last
`protect.latestUserTurns` user items or comes after one.

Protected items are never evicted, folded, or trimmed. Truncation is separate:
it applies to any tool result that is not pinned and not from the current turn,
because a huge result from three turns ago is exactly the thing to shorten.

If protected items alone exceed the limit, `keep()` writes a
`budget.unshrinkable` ledger entry and returns the best window it can. It never
breaks protection to hit the number.

## Item metadata

Adapters produce items with empty metadata. Set these before calling `keep()`
to steer the policy per item:

```ts
item.meta.pinned = true;            // never moved, truncated, or altered
item.meta.tags = ['decision'];      // protected by protect.tags
item.meta.ttl = Date.now() + 60_000; // leaves the window after this time
```
