---
'@taujs/vue': patch
---

R3-07 (S1): harden the public `ready` promise against unhandled rejections. A user-constructed
store (`createSSRStore` is public API) whose loader rejects and whose `ready` is never observed
previously produced an `unhandledRejection` - a process-terminating crash under Node's default
mode. A no-op rejection handler is now pre-attached at creation; `await store.ready` still
rejects with the loader error for consumers who observe it, and a recovering `setData` leaves
`ready` rejected (promises settle once - now pinned by tests). Regression proven in a child
process under default rejection flags (the R0-01 methodology).
