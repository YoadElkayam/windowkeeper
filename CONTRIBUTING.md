# Contributing to windowkeeper

Thanks for helping make context management lossless and auditable.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node ≥ 20 and pnpm ≥ 9 required.

## The cheapest valuable contribution: a transcript that breaks an invariant

The ten invariants in [`docs/invariants.md`](docs/invariants.md) are the contract.
They are property-tested in [`test/invariants.property.test.ts`](test/invariants.property.test.ts)
over generated transcripts. If you have a real transcript shape that makes any
reducer produce an orphaned tool call, lose an item, or exceed budget:

1. Add it as a fixture under `test/fixtures/` (redact content, keep the structure)
2. Add a test that runs `keep()` over it with `strict: true`
3. Fix the reducer, or open the PR with the failing test and describe what you saw

## The second cheapest: identifier extraction

Re-surfacing matches identifiers in the new user message against the archive.
The patterns live in [`src/identifiers.ts`](src/identifiers.ts). If a path,
symbol, error code, or ticket format from your stack is missed or over-matched,
add a case to `test/identifiers.test.ts` and adjust the pattern. Prefer missing a
match over a false positive: a wrong re-surface costs tokens on every call.

## Design rules

- `windowkeeper` core stays zero-runtime-dependency and synchronous.
- Nothing is ever deleted. A reducer may only move an item out of the window,
  replace it in place with a stub that carries its archive id, or truncate it with
  a marker that carries its archive id.
- No LLM call on the hot path. Anything that needs a model runs between turns and
  only adds to the archive or prepares a view for the next call.
- Every decision writes a ledger entry with a rule id.

## Releasing (maintainers)

1. Bump `version` in `package.json` and add a CHANGELOG entry.
2. Commit, then tag: `git tag v0.x.y && git push --tags`.
3. The `Release` workflow builds, tests, and publishes to npm with provenance via
   npm Trusted Publishing (OIDC). No tokens involved.

## Conventions

- Commits: `type(scope): message`, e.g. `feat(reducers): evict keeps latest result per tool`
- Branches: `feat/`, `fix/`, `chore/`
- TypeScript strict throughout.
