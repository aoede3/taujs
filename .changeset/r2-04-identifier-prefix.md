---
'@taujs/react': patch
---

R2-04: plumb React's `identifierPrefix` through the renderer and hydrator so multi-root pages get
stable, collision-free `useId` values.

- `createRenderer({ identifierPrefix })` is passed to `renderToString` (SSR) and
  `renderToPipeableStream` (streaming).
- `hydrateApp({ identifierPrefix })` is passed to BOTH `hydrateRoot` and the CSR-fallback `createRoot`.

It must be identical on the server and client for a given root (React requires this, or `useId`
hydration mismatches). Set it when rendering more than one taujs root on a page (the app-per-boundary
/ micro-frontend model) so each root's ids are disjoint. Additive option, no behaviour change when
unset. Both surfaces are JSDoc'd; a server-derived default from `appId` is left as an R3-03 note.
