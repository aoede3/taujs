---
'@taujs/vue': patch
---

R3-01: peer contract corrections and a strengthened contract conformance test.

- **Peer contract corrected.** `vue` is now a REQUIRED peer alongside `@vue/server-renderer` (it was
  marked optional, yet the root entry imports it). Tooling peers (`vite`, `typescript`,
  `@vitejs/plugin-vue`) remain OPTIONAL, with ranges widened so they no longer reject working setups:
  `vite` `^7.0.0` (was `^7.1.9`), `typescript` `^5.5.0`, `@vitejs/plugin-vue` `^5.0.0 || ^6.0.0`. NB
  `peerDependenciesMeta.optional` permits a peer to be ABSENT; it does NOT relax its version range when
  the peer is present.
- **`@types/node` is now declared** as an optional peer - the published root `.d.ts` references
  `node:stream` (the `renderStream` sink), which was previously an undeclared type dependency.
- `"sideEffects": false`.
- **Contract test strengthened** (test-only): `contract.test-d.ts` now pins the `renderStream` RETURN
  shape against `RenderStreamHandle` in both directions, derived from the CONCRETE renderer output
  rather than the contract-typed alias (deriving it from the annotated module made the assertion a
  tautology). Catches a contract weakening the plain module assertion tolerates.

No runtime source change.
