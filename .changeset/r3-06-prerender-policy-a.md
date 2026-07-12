---
'@taujs/react': patch
---

R3-06 (Q3, Policy A): the `ssr` strategy now renders COMPLETE HTML via `prerenderToNodeStream`
instead of `renderToString`. Previously any `React.lazy`/`use()` subtree was SILENTLY replaced by
its Suspense fallback plus a client-render marker, with zero diagnostics - the page lost its SSR
content. Behaviour change to note: a route that was accidentally fast because it silently dropped
its lazy content now correctly waits for it, bounded by the new `ssrOptions.prerenderTimeoutMs`
(default 10s; `0` = wait forever). On deadline expiry a page whose shell completed is served with
its unfinished boundaries in the fallback state (the client completes them after hydration; an
advisory warning is logged) and a page whose shell never completed fails the request instead of
serving a blank page. Output for non-suspending trees is byte-identical to `renderToString`
(pinned by test), route data is unaffected (the server resolves it before rendering), and the
`RenderSSR` server contract is untouched. Requires no consumer migration.

Gate-review hardening: `ssrOptions.prerenderTimeoutMs` is validated at `createRenderer` (a
positive finite number, `0`, or `Infinity`; anything else throws a `TypeError` instead of
silently waiting forever), and the prerender API is imported from the CONDITIONAL
`react-dom/static` subpath so browser bundlers resolve a browser-safe build - the earlier
Node-only subpath produced browser-compatibility warnings (and could hard-fail stricter
bundlers) even though final bundle bytes were clean.
