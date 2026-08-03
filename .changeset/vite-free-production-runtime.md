---
'@taujs/server': minor
'@taujs/create-taujs': minor
---

BREAKING: `taujsBuild` is no longer exported from the `@taujs/server` root. Its only public
home is the dedicated build entry, `@taujs/server/build`.

Migration is a one-line import-path change with no behavioural change:

```diff
- import { taujsBuild } from '@taujs/server';
+ import { taujsBuild } from '@taujs/server/build';
```

The removal separates the production runtime from the build toolchain. Importing
`@taujs/server` for `createServer` previously executed the build module's static
`import { build } from 'vite'` through a shared chunk, loading the whole Vite build toolchain
(Vite, Rollup, esbuild) into every production process. Three changes close that seam:

- the root entry no longer exports `taujsBuild`, so the runtime chunk no longer contains the
  build module
- the render path imports `resolveEntryFile` from its runtime home instead of reaching it
  through the build module
- the development-only Vite helpers (dev-server setup, dev Vite config resolution, plugin
  ownership preparation) are loaded dynamically inside the development branch, never at module
  scope

Importing the `@taujs/server` runtime no longer resolves Vite, and no production
Vite-toolchain resolution is attributable to `@taujs/server`. Application production boots
may still load renderer compiler tooling until the coordinated renderer contribution change.
Development and build behaviour are unchanged; `@taujs/server/build` keeps the entire build
surface as it was.

`create-taujs` scaffolds generate `build.ts` with the subpath import.
