# @taujs/html

## 0.1.0

### Minor Changes

- [#169](https://github.com/aoede3/taujs/pull/169) [`7910944`](https://github.com/aoede3/taujs/commit/791094419fb022483a46b488e70333382e3d14fb) Thanks [@aoede3](https://github.com/aoede3)! - First publication of `@taujs/html`, a framework-free HTML SSR and Streaming SSR renderer for the τjs ecosystem: no component tree, no compiler, no templating and no escaping helper - `render()` returns raw `{ headContent, appHtml }` strings, written to the response verbatim, so the application is responsible for escaping any value it interpolates. Deferred route data is delivered as data, never as server-rendered HTML: the client reads it through the single `onDataReady` export in `@taujs/html/client`, bounded by a mandatory finite `deferredTimeoutMs` (default 15 seconds) since service calls carry no automatic deadline of their own.
