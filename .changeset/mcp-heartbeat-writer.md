---
'@taujs/server': patch
---

The dev boot advances `dev.json`'s mtime on its existing poll tick, so a reader can tell a running boot from a crashed one

`dev.json` is removed only on graceful close, so after a crash it survives with a pid that may since have been recycled - and a reader had no way to tell that boot was over. The dev-files poller now touches `dev.json` on each tick, inside the same serialised write chain and close barrier as every other dev-file write, and it is non-fatal in the same way.

No new field and no negotiation: liveness is the mtime, which any reader can check with one stat. Development-only, as with the rest of the introspection substrate. `@taujs/mcp` uses it to stop reporting a dead boot as active.
