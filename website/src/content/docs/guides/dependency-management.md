---
title: Dependency Management
description: How dependencies and shared code are resolved across τjs applications
---

τjs gives each configured application its own Vite build. Dependency installation still belongs to
your package manager, and module resolution still follows normal Vite and Node rules.

The practical model is:

- the package manager decides where packages are installed and how workspaces are linked
- each application's imports determine its Vite module graph
- the application's `renderer` supplies its managed framework compiler
- `apps[].plugins`, `config.vite` and `taujsBuild({ vite })` add supported Vite customisation
- τjs does not create shared runtime dependencies between application bundles

## Repository layouts

A single root package is sufficient:

```text
project/
├── package.json
├── src/
│   ├── client/
│   │   ├── customer/
│   │   └── admin/
│   └── shared/
└── taujs.config.ts
```

A workspace is also valid when applications or shared packages need their own publication or
version boundary:

```text
project/
├── package.json
├── pnpm-workspace.yaml
├── apps/
│   ├── customer/
│   └── admin/
└── packages/
    ├── contracts/
    └── design-system/
```

τjs does not require one `package.json` per application, dependency hoisting, or one physical
`node_modules` directory. npm, pnpm and Yarn can each choose a different installation layout while
Vite resolves the declared imports.

Declare dependencies in the package that owns the importing source. In a simple repository that may
be the root package. In a workspace it is normally the application or shared package itself.

## Per-application module graphs

Suppose two applications import different libraries:

```ts
// src/client/customer/queries.ts
import { useQuery } from "@tanstack/react-query";

// src/client/admin/store.ts
import { createStore } from "solid-js/store";
```

The customer build sees React Query because the customer graph imports it. The admin build sees the
Solid store because the admin graph imports it. A package being installed does not by itself put the
package into a browser bundle.

That is not a promise that every imported byte survives or disappears. Vite and Rollup also consider
module side effects, dynamic imports, package metadata and build configuration when they tree-shake
and split chunks. Inspect production output when bundle size matters.

## Framework dependencies and renderers

Each application declares one renderer:

```ts
import { reactRenderer } from "@taujs/react/renderer";
import { solidRenderer } from "@taujs/solid/renderer";

export default defineConfig({
  apps: [
    {
      appId: "customer",
      entryPoint: "customer",
      renderer: reactRenderer({ project: "./tsconfig.json" }),
      routes: [/* ... */],
    },
    {
      appId: "admin",
      entryPoint: "admin",
      renderer: solidRenderer({ project: "./tsconfig.solid.json" }),
      routes: [/* ... */],
    },
  ],
});
```

The renderer owns the framework-specific compiler integration. Do not add a second React, Vue or
Solid compiler plugin merely because the framework is installed. Use `apps[].plugins` for additional
Vite plugins needed by that application.

In development τjs uses one shared Vite server, so application plugin lists are composed and duplicate
plugin names are resolved by first occurrence. Production builds remain per application. Keep options
for a shared plugin consistent across the applications that use it. See
[Build & Deployment](/guides/build-deployment/#vite-plugins-per-app).

## Shared source code

The default aliases include:

- `@client` for the current application's client root
- `@server` for the project server root
- `@shared` for the project shared root

A framework-neutral helper can be imported by several applications:

```ts
// src/shared/currency.ts
export function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(value);
}
```

```ts
import { formatCurrency } from "@shared/currency";
```

The source is maintained once, but each consuming application processes it as part of its own build.
It may therefore appear in more than one output. There is no cross-application shared chunk and no
runtime singleton created by using the same import path.

Framework-specific components and hooks can be shared only by applications using the compatible
framework and versions. Contracts, schemas, design tokens and plain TypeScript utilities are the
most portable shared layer.

## Custom aliases

Declare application-facing aliases in `taujs.config.ts`:

```ts
export default defineConfig({
  alias: {
    "@contracts": "./src/shared/contracts",
    "@design": "./src/shared/design-system",
  },
  apps: [/* ... */],
});
```

Relative targets resolve from the project root. The aliases are applied to development and builds.
A `tsconfig.json` path mapping alone does not automatically become a Vite alias, so keep TypeScript
and τjs alias declarations aligned when both tools need the name.

Programmatic aliases supplied to `createServer()` or `taujsBuild()` take precedence over declarative
aliases. Use that seam for a host or build wrapper, not for ordinary application imports.

## Version coordination

Separate builds do not remove the need to coordinate versions:

- keep each renderer compatible with its framework peer dependencies
- use one lockfile or an explicit release policy when several workspaces ship together
- avoid passing framework objects across application boundaries
- treat shared package upgrades like normal source changes in every consuming application

Two applications may intentionally use different renderers or framework versions because their
bundles do not share a runtime. Test document navigation between them and keep shared browser
contracts framework-neutral.

## Selective builds

`taujsBuild()` accepts application filters through `--app`, `--apps`, `-a`, `TAUJS_APP` and
`TAUJS_APPS`. Filters match either `appId` or `entryPoint`.

Selective builds reduce work in per-application CI jobs, but they do not by themselves create a
complete deployable directory. Client builds clean `dist/`, and a server serving several configured
applications needs all required client and SSR artefacts. Assemble independently produced artefacts
before publishing them together.

See [Micro-Frontends](/guides/micro-frontend/#selective-builds-and-deployment-schedules) for the
application boundary and [Build & Deployment](/guides/build-deployment/#build-a-single-app-cli) for
commands.

## Practical checks

- Declare a dependency where its importing source is owned.
- Keep shared modules free of application-global side effects.
- Do not assume a shared import creates shared browser state.
- Inspect each production application bundle separately.
- Keep development plugin options compatible across applications.
- Use explicit aliases rather than relying on undocumented resolver behaviour.
- Assemble the full artefact set before deploying a multi-application server.
