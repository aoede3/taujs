# playground-solid

The Solid twin of `fixtures/playground-react` and `fixtures/playground-vue`. One bootable app
that exercises `@taujs/solid` end to end against the workspace package.

```
pnpm --filter playground-solid dev     # http://localhost:5373
pnpm --filter playground-solid build
pnpm --filter playground-solid start
```

Routes:

| Route         | Strategy    | Hydrate | What it demonstrates                                             |
| ------------- | ----------- | ------- | ---------------------------------------------------------------- |
| `/`           | `ssr`       | yes     | Snapshot route data read through `useSSRStore`, nonced bootstrap |
| `/streaming`  | `streaming` | yes     | Deferred patch machinery retained and nonced                     |
| `/no-hydrate` | `ssr`       | no      | Static markup: no host entry, and no `$R` / `_$HY` / `$df`       |

Load-bearing details, all ruled rather than incidental:

- `renderer: solidRenderer({ project: './tsconfig.solid.json' })` - the managed compiler supplies
  `vite-plugin-solid` internally with `ssr: true` FORCED. The app never lists the plugin itself;
  doing so would be a second, unmanaged compiler with the wrong transform mode.
- `tsconfig.solid.json` is DISJOINT: it claims `src/client/**/*.tsx` and nothing else, so the
  compiler never claims the server tree.
- `renderId` is ONE shared constant imported by both entries. A literal duplicated across
  entry-server and entry-client is a hydration bug waiting to happen.
- `hydrateApp` takes only `app` / `renderId` / `rootElementId` / `onHydrationError`. Solid's
  surface is deliberately leaner than React's, and a hydration failure reports and STOPS rather
  than silently remounting as CSR.
