---
'@taujs/react': patch
---

R3-01: contract conformance test, and fix a peer contract that broke `npm install` for scaffolded apps.

- **Fixes a broken install.** The `@vitejs/plugin-react` peer was `^5.1.2` while `create-taujs`
  scaffolds `^4.6.0`, so a freshly generated React app hard-failed `npm install` with ERESOLVE. The
  range is now `^4.6.0 || ^5.0.0`. NB `peerDependenciesMeta.optional` permits a peer to be ABSENT; it
  does NOT relax its version range when the peer is present, so marking tooling optional did not fix
  this on its own.
- **Peer contract corrected.** Runtime peers `react` / `react-dom` are now REQUIRED (they were marked
  optional, yet the root entry imports them) with an honest `^19.0.0` floor - the previous `^19.2.3`
  was a devDependency mirror that needlessly blocked the whole React 19.0.x and 19.1.x lines. Tooling
  peers (`vite`, `typescript`, `@vitejs/plugin-react`) are now OPTIONAL, with `vite` lowered to `^7.0.0`
  (the old `^7.3.1` floor rejected vite 7.2.x even though the tooling is optional).
- **Types the published `.d.ts` needs are now declared** as optional peers: `@types/react`,
  `@types/react-dom` (the `react` package ships no types, and `dist/index.d.ts` imports from it) and
  `@types/node` (the root types reference `node:stream`). Previously undeclared, so a TypeScript
  consumer could silently degrade `React` to `any` under `skipLibCheck`.
- **Contract conformance test** (`src/test/contract.test-d.ts`, tsc-enforced via `typecheck`, outside
  the vitest glob): proves `createRenderer(...)` satisfies `@taujs/server`'s `RenderModule` with ZERO
  casts, and pins the `renderStream` RETURN shape against `RenderStreamHandle` in both directions -
  function assignability alone can hide a capability gap through width-subtyping. Verified to bite:
  narrowing a param, dropping `done` from the renderer's return, and weakening the contract itself
  (making `done` optional) each fail `typecheck`; the last is caught ONLY by the return-shape
  assertions, which the plain module assertion tolerates.
- `"sideEffects": false` and a real `description` (was a placeholder).

No runtime source change.
