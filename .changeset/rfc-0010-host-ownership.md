---
'@taujs/server': minor
---

Respect a caller-supplied Fastify instance (RFC 0010)

τjs now derives one internal ownership fact from whether you passed `fastify` to `createServer`.

**Bring your own Fastify and τjs respects it.** When you supply an instance, τjs registers its
routes, CSP, trace, auth, static assets, introspection and error conversion into a single
encapsulated Fastify scope. It no longer replaces your error handler or not-found handler, applies
no CSP or trace to your routes, claims no root decorators, prints no banner or presentation output,
and adds no `onReady` hook. It still registers under its own name, so it appears in your plugin
tree. In development a single root `onRequest` hook delegates otherwise-unmatched requests to the
τjs-owned Vite server and returns control unchanged; production installs no root hook at all.

**Let τjs create Fastify and it provides the complete experience.** Omit `fastify` and behaviour is
unchanged: whole-server CSP and trace, the implicit application shell, the banner and configured
line.

No new ownership option or mode is introduced. Standalone applications are unaffected; embedded
applications should read the migration notes below, since some may need to declare a wildcard page
or establish host-wide CSP on their own instance.

### Behaviour changes for embedded hosts

These previously applied to your whole server and now apply only to τjs-owned responses:

- **The implicit application shell is gone.** Unmatched URLs fall to your own not-found policy. If
  you want τjs to render them, declare a terminal wildcard page route (`path: '/*'`), which is an
  ordinary τjs page and now also owns asset-like URLs it matches.
- **Configured τjs CSP no longer applies to your routes.** Host-wide policy belongs to Fastify;
  τjs CSP, nonces and route-level `merge`/`replace` continue to apply to τjs pages.
- **`x-trace-id` no longer appears on your routes**, and no τjs trace episode opens for them. τjs
  still adopts an inbound `x-trace-id` or your Fastify `req.id` for its own responses, so one
  correlation identity spans both.

Two boot failures are also fixed: supplying an instance that already owns a not-found handler, or
that has already registered `@fastify/static`, previously prevented τjs from booting.

The boot summary now states which ownership mode is in effect.
