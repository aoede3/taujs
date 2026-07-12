---
'@taujs/server': patch
'@taujs/react': patch
'@taujs/vue': patch
---

R0 gate recheck fix — a throwing host `onError` callback can no longer veto stream
cleanup/settlement:

- **Renderers** (`@taujs/react`, `@taujs/vue`): every fatal path now routes through a single
  helper that invokes the host `onError` under `try/catch` (the throw is logged and swallowed) and
  ALWAYS runs `controller.fatalAbort`. So a throwing callback — or one called from a shell timer or
  a writable EventEmitter listener — can neither skip cleanup / `done` settlement nor escape as an
  `uncaughtException`; the ORIGINAL render error stays the rejection reason. React additionally no
  longer double-fires `onError` for a fatal writable error.
- **Server** (`@taujs/server`): the streaming render `onError` callback is now non-throwing for an
  arbitrary/hostile `unknown`. Telemetry (message / kind / normalise / reason) is extracted through
  safe, never-throwing helpers and belted, so formatting a hostile error (a throwing `message`
  getter or `Symbol.toPrimitive`) can no longer prevent the deterministic response teardown
  (500 / socket destroy).
