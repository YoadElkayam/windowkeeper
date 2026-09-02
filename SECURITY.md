# Security Policy

## Supported versions

Only the latest published version of `windowkeeper` receives security fixes.

## Reporting a vulnerability

Please do NOT open a public issue for security problems. Instead use
[GitHub private vulnerability reporting](https://github.com/YoadElkayam/windowkeeper/security/advisories/new)
or email yoad.elkayam@gmail.com.

You can expect an acknowledgment within a few days. Please include a reproduction
if you can.

## Scope notes for this project

windowkeeper sits between an agent harness and the model API, so the interesting
surface is:

- The archive stores every message and tool result verbatim, by design. Treat any
  persistent archive (file, SQLite) as sensitive: it contains everything the model
  ever saw, including data later evicted from the window.
- The ledger records identifiers extracted from user messages (file paths, symbol
  names, error strings) to explain re-surfacing decisions. Treat ledger files as
  sensitive.
- Re-surfacing by identifier match reads from the archive only. It never executes
  tools. Serving a repeated tool call from the archive is opt-in per tool and never
  applies to tools listed as volatile.
