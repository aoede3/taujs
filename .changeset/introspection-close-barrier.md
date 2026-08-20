---
'@taujs/server': patch
---

No introspection dev-file write can land after `close()` resolves

`listen()` resolves before the async `onListen` hook runner completes (Fastify sequences the hook promises, but the listen caller is not waiting on them), so a fast boot-then-close could reach close while the dev-file boot writes were still in flight - and before the poll timer existed, so the timer then started after close and kept writing into a directory the caller was removing (an intermittent `ENOTEMPTY` in CI teardowns). Close now awaits the tracked boot work, the timer never starts once close has run, and every flush - polled or final - joins one awaited chain. The boot graph emission, a second `onListen` writer, gets the same barrier: its write is tracked and awaited at close, and a boot that close has overtaken never starts it. Deterministic gate-held regression cells cover the boot write, a polled write, the graph write, and the composed production wiring.
