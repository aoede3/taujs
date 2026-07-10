---
'@taujs/mcp': minor
---

P1-01: new package — the τjs MCP adapter's substrate reader core. A thin file reader over `node_modules/.taujs/` (never a network client): freshness discovery (`active` via live-pid dev.json, `stale` with boot-or-build graph fallback, `none` with the first-run message), bootId-filtered trace reads, per-trace `warn+`-default log reads, observations, explicit `schemaVersion` skew degradation ("upgrade @taujs/mcp", never a misread), staleness citation lines for every cold answer, and 500-char caps on every string read from disk (untrusted application data). Exposes the verbatim runtime-tool refusal contract.
