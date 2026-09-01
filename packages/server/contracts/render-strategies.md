# Render strategies and the default

Contract id: `server:render-strategies`. Owner: `@taujs/server` (this document's version is the
installed package's version).

## The declared strategies

A declared route's `attr.render` accepts exactly two values:

- `'ssr'` - buffered server-side rendering. The response is sent as a single document after
  data resolution and rendering complete.
- `'streaming'` - progressive server-side rendering. The shell is flushed early and content
  streams as it becomes ready. A streaming route's `attr.meta` is required by the declared
  type, and a streaming route without meta raises the `streaming.missing_meta` graph warning.

There is no `'csr'` value. Client-only navigation exists by omission of a route declaration,
not through a render strategy.

## The default

The typed configuration surface requires `render` on every declared route. At runtime, a route
whose configuration reaches the server without a render value falls back to `'ssr'`. That
fallback is visible, not silent:

- the request graph records the route with `render: { strategy: 'ssr', defaulted: true }`;
- a `render.defaulted` graph warning names the route;
- `taujs_explain_route` and `taujs_doctor` report the defaulted state.

A route showing `defaulted: false` declared its strategy explicitly.

## Reading behaviour against declaration

The graph states declared configuration. A route observed streaming in development traffic
(`mode: 'streaming'` on its episodes) while intended to buffer is a declaration question first:
check `attr.render` on that route before suspecting the runtime.
