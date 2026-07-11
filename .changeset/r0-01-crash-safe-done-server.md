---
'@taujs/server': minor
---

R0-01: export `RenderStreamHandle` (`{ abort(): void; done: Promise<void> }`) as the return
type of `RenderStream`, and observe `done` at the streaming render call site.

Both framework renderers already returned `{ abort, done }` at runtime, but the published
`RenderStream` type promised only `{ abort(): void }`, so the server could not capture `done`.
A fatal stream error rejects `done`; left unobserved, that surfaced as an `unhandledRejection`
— which Node's default mode turns into a process-terminating `uncaughtException`. The server
now captures and acknowledges `done` (fatal errors remain fully handled via the `onError`
callback; the acknowledgement is also defence in depth if a renderer omits its own handler).

Type-level breaking change for third-party `RenderStream` implementers: they must now return a
`done` promise. Both first-party renderers already conform. Bumped `minor` as an additive
contract type (precedent: V1-05), keeping `@taujs/server` below 1.0.0.
