---
'@taujs/server': patch
---

R0-04: eliminate the second process-crash class — a `JSON.stringify` failure thrown from the
streaming `finish` listener, which runs on a stream tick OUTSIDE the request `try/catch`, so an
uncaught throw becomes an `uncaughtException` → process exit.

A single server-owned `serializeInlineData` boundary now serializes the inline
`window.__INITIAL_DATA__` script for BOTH render modes. It escapes `<` (output is byte-identical
to the previous inline expression for every valid input, so cached pages are unaffected), treats
circular references, `BigInt`, a throwing `toJSON`, and `undefined` as deterministic failures, and
NEVER throws. The SSR path throws an `AppError.internal` into the existing 500 machinery on
failure; the streaming path logs, records (`recorder.failed`), and terminates the response
deterministically without a data script — with the entire listener wrapped in a `try/catch` belt.
The JSON data contract is unchanged (no new serializer dependency).
