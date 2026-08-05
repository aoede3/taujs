# Streaming transport renderer fixtures

**Hand-written source, not build output.** These directories imitate the SHAPE of a built τjs
application - `client/app/index.html`, a client manifest, `ssr/app/entry-server.js` - so the
streaming transport can be exercised against a real renderer through the real production path,
with no Vite build step in the test run.

`entry-server.js` is deliberately plain JavaScript: production loads the SSR entry directly, so a
fixture written in JS needs no transform. It wraps the real `@taujs/react` renderer and re-attaches
the same render-contract brand, which keeps it instrumentation rather than a second renderer
identity.

Regenerating them is manual and intentional. Nothing here is emitted by a build.
