---
title: τjs Configuration
description: Complete reference for configuring τjs applications
---

Complete reference for configuring τjs applications.

τjs uses a declarative configuration file (`taujs.config.ts`) where you define:

- Server settings (host, port, HMR)
- Applications and their entry points
- Routes with rendering strategies
- Security policies (CSP, authentication)
- Data loading patterns

All configuration is validated at startup with helpful error messages.

## Basic Configuration

```typescript
// taujs.config.ts
import { defineConfig } from "@taujs/server/config";

export default defineConfig({
  server: {
    host: "localhost",
    port: 5173,
    hmrPort: 5174,
  },
  apps: [
    {
      appId: "web",
      entryPoint: "",
      routes: [
        {
          path: "/",
          attr: {
            render: "ssr",
            data: async () => ({ message: "Hello World" }),
          },
        },
      ],
    },
  ],
});
```

## Type Definitions

```typescript
type TaujsConfig = {
  server?: ServerConfig;
  security?: SecurityConfig;
  introspection?: IntrospectionConfig; // Development only
  apps: AppConfig[];
  alias?: Record<string, string>;
  vite?: TaujsViteOverride;
};

type ServerConfig = {
  host?: string; // Default: 'localhost'
  port?: number; // Default: 5173
  hmrPort?: number; // Default: 5174
  mountPrefix?: string; // Default: '' (root)
  publicBasePath?: string; // Default: mountPrefix
  hmrTransport?: 'fixed-port' | 'attached' | 'mediated'; // Default: 'fixed-port'
};

// Development only - the surface is structurally absent from a production build,
// so there is no `enabled` flag to turn it off.
type IntrospectionConfig = {
  allowNonLoopback?: boolean; // Relaxes ONLY the remote-address check
  allowedHosts?: string[]; // Extends ONLY the Host admission; exact DNS hostnames
  redaction?: {
    denyKeys?: string[]; // Extends the default denylist
    replaceDefaultDenyKeys?: boolean;
  };
};

type AppConfig = {
  appId: string;
  entryPoint: string;
  plugins?: PluginOption[];
  routes?: readonly { path: string; attr?: { render: "ssr" | "streaming"; /* ...see Route Attributes below */ } }[];
};
```

The `vite` and `alias` fields are the declared Vite customisation surface - see
[Vite Configuration](#vite-configuration) below for their types and merge behaviour.

## Server Configuration

Control where and how τjs runs.

```typescript
export default defineConfig({
  server: {
    host: "localhost",
    port: 5173,
    hmrPort: 5174,
  },
});
```

### Configuration Precedence

Values are resolved in this order (highest precedence first):

1. **CLI flags**: `--host`, `--port`, `--hmr-port`

```bash
   npm run dev -- --host 0.0.0.0 --port 3000
```

2. **Environment variables**:

   - `HOST` or `FASTIFY_ADDRESS`
   - `PORT` or `FASTIFY_PORT`
   - `HMR_PORT`

3. **`createServer({ port })`**: the programmatic option overrides `config.server.port`, and `0` requests an ephemeral port.

4. **Config object**: `server.*` properties

5. **Defaults**: `{ host: 'localhost', port: 5173, hmrPort: 5174 }`

### Host Values

```typescript
server: {
  host: "localhost"; // Loopback only (not accessible from network)
  host: "0.0.0.0"; // All interfaces (accessible from network)
}
```

**CLI shorthand:**

```bash
npm run dev -- --host    # Automatically becomes 0.0.0.0
```

### Non-root mounting: `mountPrefix` and `publicBasePath`

Two installation-level coordinates make a τjs installation deployable under a non-root
prefix. They describe external addressing, not project layout:

- **`mountPrefix`** - where Fastify RECEIVES the installation. One scope prefix under which
  every declared route (all apps), τjs static assets and the development introspection
  surface register. Default `''` (root).
- **`publicBasePath`** - what τjs EMITS in front of every URL it generates: asset, preload
  and CSS links, the bootstrap module URL and the development beacon. It also derives each
  app's Vite `base`. Defaults to `mountPrefix`.

The two differ exactly when a reverse proxy STRIPS the public prefix before forwarding:

```typescript
// Root (default) - no configuration needed; existing deployments are unchanged.
server: {}

// Prefix-preserving proxy: /app/x arrives as /app/x.
server: { mountPrefix: "/app" }

// Stripping proxy: browsers use /app/x, the proxy forwards /x.
server: { mountPrefix: "", publicBasePath: "/app" }
```

**Validation.** A coordinate is either `''` or `/segment(/segment)*` - leading `/`, no
trailing `/`, segments of URI-unreserved characters only (`[A-Za-z0-9._~-]`). Anything else
is rejected at startup with a message naming the rule; values are never silently
normalised. Declaring `publicBasePath: ""` alongside a non-empty `mountPrefix` (emit
root-absolute while mounted) is rejected as unsupported.

**Separation from `entryPoint`.** `entryPoint` keeps its layout meaning: `''` remains the
canonical single-application root layout, and a named entry point remains a subordinate
application directory. The deployment coordinates compose AROUND it - `publicBasePath:
"/app"` with `entryPoint: "admin"` emits `/app/admin/assets/...`. Never substitute
`entryPoint: "app"` for `publicBasePath: "/app"`; deployment does not change layout.

**Routing boundary.** `/app` and `/app/` both reach the mounted root route. Deeper
trailing-slash matching remains the Fastify owner's policy - a caller-owned host keeps its
own `ignoreTrailingSlash` choice, and the τjs-created default stays strict. On a
τjs-created host the SPA fallback is confined to the mounted subtree; outside it the
server answers an ordinary 404. Application routers and hard-coded links need their own
base configuration, because τjs does not rewrite them.

**What τjs does not do.** Application-authored links (`href` values in your components) are
never rewritten - τjs prefixes only the URLs it generates itself. Proxy rewrite
configuration stays proxy-owned; τjs reads no forwarding headers
(`X-Forwarded-Prefix` included).

**Development.** The shared dev Vite `base` follows `publicBasePath`, so dev module URLs
and the HMR socket pathname compose with the prefix, and dev delegation is confined to the
mounted subtree. Two adjacent concerns have their own declared surfaces: `server.hmrTransport`
carries the HMR socket where a second port cannot be reached, and `introspection.allowedHosts`
admits a proxy's hostname for the `/__taujs/*` introspection endpoints.

### `server.hmrTransport`

How the development HMR WebSocket is carried. Development only - it has no effect on a build.

| Value | Behaviour |
| --- | --- |
| `'fixed-port'` (default) | HMR listens on its own dedicated port (`hmrPort`, default 5174). |
| `'attached'` | HMR rides the application's own HTTP server, so it flows wherever that channel flows. |
| `'mediated'` | Your own listener offers τjs first refusal on each upgrade, so HMR rides whatever channel that listener is on. |

The default is unchanged behaviour. Choose `'attached'` when a second fixed port cannot be
reached - a supervisor that virtualises worker binds, a firewall, or a proxy that forwards only
one channel. The served client then derives its socket from the origin that served it, rather
than from a hard-coded port.

```ts
export default defineConfig({
  server: {
    hmrTransport: 'attached',
  },
});
```

Two rules to know:

- **It is never inferred.** τjs does not detect its host or read the environment to decide;
  an attached transport is requested explicitly.
- **It requires a τjs-created host.** If you pass your own Fastify instance to `createServer`,
  `'attached'` is rejected at configuration time rather than τjs attaching to, or reordering
  listeners on, a server it does not own. `hmrPort`, `HMR_PORT` and `--hmr-port` stay accepted
  so an existing configuration can switch transport without being rewritten, but they do not
  affect the attached channel.

#### Running an attached channel behind a proxy

τjs adds no proxy machinery; carrying the channel through one - a real TCP path, prefix
preservation and restart-watcher scope - is host configuration, held in one place at
[Running τjs Under a Supervisor or Behind a Gateway](/guides/supervisors-and-gateways/).

> **Requires a trusted development network.** Proxies commonly drop `Origin` and rewrite
> `Host`, and Vite's WebSocket admission depends on those headers - its host and token checks
> do not survive that rewriting. The protections that apply to a direct connection do not
> project through such a proxy. Use this on development networks you trust.

#### Mediated: caller-offered upgrades

`'mediated'` is for a Fastify instance you supply to `createServer` (mode B). Rather than τjs
attaching to a host it does not own, your own `upgrade` listener offers τjs first refusal on
each upgrade through a returned capability, `dev.hmr.tryHandleUpgrade`. The whole developer
experience is this:

```ts
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const tau = await createServer({ fastify: app, config }); // config.server.hmrTransport = 'mediated'

const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
  if (tau.dev.hmr.tryHandleUpgrade(req, socket, head)) return;
  socket.destroy(); // the application decides what happens to upgrades that are not τjs's
};
app.server.on('upgrade', onUpgrade);
app.addHook('onClose', async () => { app.server.off('upgrade', onUpgrade); });
```

One explicit transport choice, one typed capability, one caller-owned listener, one matching
removal. `tryHandleUpgrade` returns `true` when the socket is τjs's HMR channel - handed to
Vite, do nothing more with it - and `false` when it is not, so your fallback branch stays
authoritative. It never throws.

**Ownership is the opposite of `'attached'`.**

| `hmrTransport` | Requires | Rejected on |
| --- | --- | --- |
| `'attached'` | a τjs-created host | a host you supplied |
| `'mediated'` | a host you supplied | a τjs-created host - it needs no mediation, use `'attached'` |

Both rejections happen at configuration time, before Vite installs anything or τjs touches your
root. An unknown value is rejected in every mode. Like the other transports, `'mediated'` is
accepted and **inert in production** - `dev.hmr` is always present so a shared configuration
file boots cleanly there, and `tryHandleUpgrade` simply returns `false`.

**If nothing ever offers τjs an upgrade**, the page still serves and HMR silently does nothing -
indistinguishable from a real failure unless τjs says so. The boot log names the transport and
the obligation, and if the served client has loaded but no upgrade has reached τjs within a few
seconds, a one-shot development warning names the exact fix:

```
hmr: mediated transport selected but no HMR upgrade has reached τjs - offer upgrades to
dev.hmr.tryHandleUpgrade from the server's 'upgrade' listener
```

It fires once, only in development, and is cancelled by a successful claim - an unrelated
upgrade passing through does not silence it.

**The WebSocket path itself must be prefix-preserved, exactly as for `'attached'`** - see
[Running τjs Under a Supervisor or Behind a Gateway](/guides/supervisors-and-gateways/) for the
contract. If your topology strips the prefix, the never-wired warning above will fire,
correctly: no upgrade reached τjs because none could match.

**Security is unchanged from `'attached'`.** τjs performs no admission checks of its own; Vite's
own host and token checks run exactly as they do for the attached transport, after the hand-off.
The same trusted-development-network requirement applies - see the note above.

See also: [combining HMR with another upgrade consumer](/guides/hmr-cohabitation/) if your
application already has a WebSocket consumer of its own.

## Development Introspection

The development introspection surface (the `/__taujs/*` overlay endpoints and the hydration
beacon) is guarded independently of page serving: requests must arrive from a loopback
address, present a local `Host` and carry the per-boot token. Each opt-in below relaxes
exactly the guard it names, and neither implies the other.

### `introspection.allowedHosts`

Extends the introspection `Host` admission with exact DNS hostnames, for development behind
a reverse proxy that presents a non-localhost `Host`. Development only; without a
declaration the behaviour stays localhost-only.

```typescript
export default defineConfig({
  introspection: {
    allowedHosts: ['web.plt.local'],
  },
});
```

Rules:

- **Exact hostnames only.** No wildcards, IP literals, schemes, ports or paths - invalid
  entries are rejected at startup, in production too, so a shared configuration cannot hide
  a typo. Matching is case-insensitive and ignores the request port; subdomains are never
  implied. `localhost`, `*.localhost` and IP-literal hosts stay admitted without any
  declaration.
- **Declare the hostname as seen at the τjs hop.** A rewriting proxy substitutes its own
  upstream name for the browser-facing one - behind a Platformatic gateway, for example,
  the arriving `Host` is the internal service name (`web.plt.local`), not the public host.
- **A rewriting proxy owns browser-facing host validation.** Exact matching preserves the
  DNS-rebinding guard for direct connections, but τjs never sees the original hostname
  behind a rewriting proxy and reads no forwarding headers (`Forwarded`,
  `X-Forwarded-Host`). Ensure the proxy validates the browser-facing host, or use a trusted
  development network only - the boot summary repeats this whenever the list is non-empty.
- **Independent of `allowNonLoopback`.** `allowedHosts` relaxes only the `Host` check;
  `introspection.allowNonLoopback: true` relaxes only the remote-address check. A same-host
  gateway needs only `allowedHosts`; a proxy on another machine needs both. The per-boot
  token is always required.

Undeclared hostnames keep answering `403 invalid_host`; the first such refusal logs a
warning naming this field, so a proxied topology fails visibly rather than silently.

### `introspection.redaction`

What τjs withholds from the development introspection record written under
`node_modules/.taujs/` and served to the overlay. Redaction here is **structural**: τjs never
scans values looking for things that resemble secrets, and each rule acts on the one record
type that carries the data it filters. Episodes get URL hygiene; the log annex gets
metadata-key dropping; observations (service edges) are structural records - service and
method names, counts, timestamps and capped sample request ids - that carry neither query
values nor metadata, so these two redaction rules have no observation fields to act on.

Two rules apply, and both are unconditional for the records they act on:

- **Query values are never captured, for any key.** A URL is stored as its pathname, the
  surviving query key names, and a flag - never as a raw string. For `/reset?token=abc&ref=x`
  the record is `{ pathname: "/reset", queryKeys: ["ref"], queryValuesRedacted: true }`. The
  value `abc` never enters the buffer, and `token` is absent from `queryKeys` because its key
  name matched the denylist.
- **Metadata fields are dropped by key name**, along with the whole subtree beneath them. A
  matched key is not partially serialised; it is absent.

```typescript
introspection: {
  redaction: {
    denyKeys: ['internalRef'],        // extends the defaults
    replaceDefaultDenyKeys: false,    // true discards the defaults entirely
  },
}
```

**The matching rule, stated exactly.** A key is dropped when its name, lowercased, **contains**
any denylist entry as a substring. Default entries: `password`, `token`, `secret`, `ssn`,
`auth`, `cookie`, `session`, `key`.

**This deliberately over-redacts.** Because `key`, `auth` and `session` are short, innocent
fields disappear too - `monkeyId` and `keyboardLayout` match `key`, `authorName` matches
`auth`, `sessionCount` matches `session`. If a legitimate field is missing from the overlay,
this rule is why.

**It is a conservative heuristic on key names, not secret detection.** Substring matching
intentionally favours over-redaction, but the default list is not exhaustive and values are
never inspected. The denylist does not remove an unmatched metadata field, or secrets embedded
directly in log or error messages. Avoid putting secrets in introspection-visible metadata or
messages, and add project-specific deny keys where needed.

**If the defaults do not suit you, take ownership of the list.** `denyKeys` adds entries;
`replaceDefaultDenyKeys: true` discards τjs's defaults so only your entries apply - including
the defaults that protect, so choose the replacement list deliberately.

The whole surface is development-only. In production the introspection module is never loaded,
nothing is written, and there is nothing to redact.

## App Configuration

Define frontend applications with their entry points and routes.

```typescript
apps: [
  {
    appId: "web",
    entryPoint: "", // canonical root layout: the app lives at the client root
    routes: [
      /* ... */
    ],
    plugins: [
      /* optional Vite plugins */
    ],
  },
  {
    appId: "admin",
    entryPoint: "admin", // subordinate application directory and build namespace
    routes: [
      /* ... */
    ],
  },
];
```

### App Properties

| Property     | Type             | Required | Description                    |
| ------------ | ---------------- | -------- | ------------------------------ |
| `appId`      | `string`         | Yes      | Unique identifier for this app |
| `entryPoint` | `string`         | Yes      | `''` for the canonical root layout, or a directory under the client root |
| `routes`     | readonly route definitions | No       | See [Route Configuration](#route-configuration) |
| `plugins`    | `PluginOption[]` | No       | Vite plugins for this app      |

Any standard Vite plugin is accepted in `plugins` - the τjs renderer plugins are the
scaffolded defaults, not a closed set. Scope differs by mode: at build time each app is
built with exactly its own list; in development τjs runs one shared Vite dev server, so all
apps' plugin lists are composed into one list and duplicate plugin names are dropped (first
occurrence wins, and every collision is reported at warn level - see
[Plugin composition](#plugin-composition)).

`apps[].plugins` is one of three declared plugin channels; the top-level
[`vite`](#vite-configuration) field and the `taujsBuild({ vite })` escape hatch are the
other two. τjs never reads a `vite.config.*` - if one sits where Vite used to probe for it,
τjs emits a migration warning naming the file and pointing at these channels
(see [Vite Configuration](#vite-configuration)).

### Fastify owns HTTP routing

Every app route path is registered as a real Fastify GET route. Fastify selects the route and decodes its parameters; τjs then applies the declared auth, CSP, data, render and episode contract. There is no second τjs route matcher.

Configure HTTP routing on the Fastify instance passed to createServer:

~~~typescript
const fastify = Fastify({
  routerOptions: {
    caseSensitive: false,
    ignoreTrailingSlash: true,
  },
});

await createServer({ config, serviceRegistry, fastify });
~~~

Those native options govern τjs routes and host-owned Fastify routes alike. Use Fastify for case sensitivity, trailing or duplicate slash handling, bad-URL policy, parameter limits and other router behaviour; τjs does not mirror those settings in taujs.config.ts. See the [Fastify server router options](https://fastify.dev/docs/latest/Reference/Server/#routeroptions) and [route reference](https://fastify.dev/docs/latest/Reference/Routes/).

This is a deliberate product boundary: the server package is Node/Fastify-native. The renderer packages retain their standalone uses, but the integrated server does not carry a second runtime-neutral HTTP or router abstraction.

Route paths therefore use Fastify route syntax, not regular expressions. An exact path may be declared by only one τjs app. Ordinary Fastify routes can coexist beside τjs page routes.

Who answers an unmatched URL depends on who owns the host, including in the example above, since supplying an instance is itself an ownership decision:

- **τjs created the Fastify instance** - unmatched document URLs continue through the τjs SPA fallback document.
- **You supplied the Fastify instance** - your own not-found policy owns unmatched URLs, unless you declare an explicit τjs terminal wildcard page (`path: '/*'`).

See [Host Ownership](/guides/host-ownership/) for the full split and the embedded-host migration notes.

When migrating an existing config, replace path-to-regexp-only forms such as
`/app{/:feature}{/:id}`, `/app/:page*` and `/docs/*slug`. τjs rejects these known stale forms at
startup rather than allowing Fastify to register a literal or differently behaving route. Use a
terminal Fastify wildcard such as `/app/*`, a terminal optional parameter such as
`/products/:id?`, or explicit routes. `/app/*` owns paths below `/app/`; declare `/app`
separately when the bare prefix must render too.

Route ownership is now exact. Route-level auth and CSP apply only after Fastify selects that τjs
route; host-owned routes and unmatched case variants do not inherit policy merely because their
URL resembles a τjs declaration. Conversely, once a declared parameter route is selected, dotted
values such as `/products/logo.png` are valid parameter values. Asset-like URLs still 404 when no
page or static route owns them.

### Entry Point Structure

Each `entryPoint` directory must contain:

```
client/{entryPoint}/
├── index.html          # HTML template
├── entry-client.tsx    # Client hydration entry
└── entry-server.tsx    # SSR render entry
```

With `entryPoint: ""` (the canonical root layout) these files live directly in the client
root.

## Vite Configuration

τjs owns the Vite topology - roots, inputs, output directories, manifests, aliases, and the
single shared development server - and exposes the fields it does _not_ own through two
declared channels in `taujs.config.ts`:

- **`alias`** - the declarative home for path aliases, applied identically in dev and build.
- **`vite`** - an allowlisted Vite override (`TaujsViteOverride`), applied symmetrically to
  the shared dev server and to every per-app build.

A third channel, the `taujsBuild({ vite })` option, remains as a build-only escape hatch (see
the [build guide](/guides/build-deployment/#build-time-vite-override)).

**τjs never reads a `vite.config.*`.** Both the dev server and every build pin
`configFile: false`, so Vite never probes for one. If a `vite.config.*` sits where Vite used
to discover it (the shared client base root in dev, each per-app entry root in build), τjs
emits a migration warning naming the file, stating that it is not loaded, and pointing at the
`vite` / `alias` fields. A project-root `vite.config.*` was never read and is not warned about.
This is not a limitation of the ecosystem - the `vite` field _is_ your Vite configuration, with
a topology-aware home (see [Reusing Vite fragments](#reusing-vite-fragments)).

### The `vite` field

```typescript
type TaujsViteOverride = TaujsViteConfig | ((ctx: TaujsViteContext) => TaujsViteConfig);

type TaujsConfig = CoreTaujsConfig & {
  // ...
  alias?: Record<string, string>;
  vite?: TaujsViteOverride;
};
```

`vite` is either a static `TaujsViteConfig` object or a function of a discriminated
serve/build context. The type is an explicit allowlist - only the supported fields appear, so
the editor refuses a protected field up front rather than the merge dropping it silently.

```typescript
type TaujsViteConfig = {
  // Appended to the framework plugin list (append + dedupe by name).
  plugins?: PluginOption[];
  // Shallow-merged with the framework defines.
  define?: Record<string, unknown>;
  // Per-engine deep merge; only preprocessorOptions is admitted.
  css?: {
    preprocessorOptions?: CSSOptions["preprocessorOptions"];
  };
  // Dev-only (see below); never reaches build configs.
  optimizeDeps?: TaujsOptimizeDeps;
  esbuild?: ESBuildOptions | false;
  logLevel?: LogLevel;
  // resolve subset - alias is intentionally excluded (use the top-level alias field).
  resolve?: ResolveOptions;
  // Dev-only. An allowlist of one: everything else under Vite's `server` is either
  // framework-owned or meaningless in middleware mode. See the matrix below.
  server?: Pick<ServerOptions, "allowedHosts">;
  // Build-tuning subset - the framework owns everything else under build.
  build?: {
    sourcemap?: BuildOptions["sourcemap"];
    minify?: BuildOptions["minify"];
    terserOptions?: BuildOptions["terserOptions"];
    rollupOptions?: {
      external?: Rollup.ExternalOption;
      output?: {
        /** @deprecated Vite 8/Rolldown does not support the object form - FUNCTION form only. */
        manualChunks?: Rollup.OutputOptions["manualChunks"];
      };
    };
    // Canonical Vite 8 chunking, replacing the deprecated manualChunks above. Declaring both
    // is rejected rather than silently resolved.
    rolldownOptions?: {
      output?: {
        codeSplitting?: Rolldown.OutputOptions["codeSplitting"];
      };
    };
  };
};
```

The function form receives a discriminated context. Dev invokes it **once** with the `serve`
arm (there is no `appId` - the shared dev server is not per-app); build invokes it per app with
the `build` arm:

```typescript
type TaujsViteContext =
  | {
      command: "serve";
      mode: string;
      isSSRBuild: false;
      appId?: never;
      entryPoint?: never;
      clientRoot: string;
    }
  | {
      command: "build";
      mode: string;
      isSSRBuild: boolean;
      appId: string;
      entryPoint: string;
      clientRoot: string;
    };
```

```typescript
// taujs.config.ts
export default defineConfig({
  vite: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [visualizer()],
  },
  apps: [{ appId: "main", entryPoint: "", plugins: [pluginVue()] }],
});
```

```typescript
// Function form - branch on the serve/build context.
export default defineConfig({
  vite: (ctx) => ({
    // A visualiser only makes sense for client builds.
    plugins: ctx.command === "build" && !ctx.isSSRBuild ? [visualizer()] : [],
  }),
  apps: [/* ... */],
});
```

#### `optimizeDeps` (dev-only)

`optimizeDeps` tunes Vite's dependency pre-bundling on the shared dev server. It is
development-only - nothing from it reaches a client or SSR build. τjs admits a subset:

```typescript
type TaujsOptimizeDeps = Pick<
  DepOptimizationOptions,
  "include" | "exclude" | "esbuildOptions"
>;
```

- `include` forces a dependency into pre-bundling, `exclude` keeps an incompatible one out,
  and `esbuildOptions` accommodates dependency transforms, loaders, and esbuild plugins.
- `include` and `exclude` are deduplicated. The same package appearing in **both** is a
  config-validation error - it cannot be force-included and excluded at once.
- The remaining Vite optimiser fields (`entries`, `noDiscovery`, `force`, and the experimental
  set) are deliberately withheld: τjs retains authority over how the shared development
  application graph is discovered.

### The `alias` field

`alias` is the declarative home for path aliases - the field the previous docs described but
that did not exist. It is sourced by **both** dev and build and merged over the framework
defaults (`@client` / `@server` / `@shared`), user values winning on conflict:

```typescript
export default defineConfig({
  alias: {
    // Relative values resolve against the project root before the map is handed to Vite.
    "@components": "./src/client/shared/components",
    // Absolute values pass through untouched.
    "@icons": "/opt/shared/icons",
  },
  apps: [/* ... */],
});
```

**Normalisation rule:** Vite does not resolve relative alias replacements - it expects
absolute paths. τjs therefore normalises declarative values before the alias map is handed to
Vite (during dev-server setup and in `taujsBuild`, once the project root is known - not in
`defineConfig` itself): a relative replacement resolves against the project root, an absolute
one passes through untouched. This keeps the config file free of `path.resolve(...)`
boilerplate without shipping strings Vite would misread.

The project root is `taujsBuild({ projectRoot })` at build time and the `projectRoot` option
on `createServer` in development (default `process.cwd()`). Pass the same directory to both -
the scaffold already does - so relative aliases resolve identically in dev and build.

The programmatic `alias` options on `createServer` (dev) and `taujsBuild` (build) remain as
escape hatches, layered above the declarative field (see the
[build guide](/guides/build-deployment/#alias-configuration)). Programmatic values are passed
through untouched (callers already hold real paths); a per-key override of a differing
declarative value is logged at debug level, never warned.

### Vite support matrix

The matrix is the supported set. `Dev` is the shared development server; `Client build` and
`SSR build` are the per-app production builds.

| Surface                                                | Dev       | Client build | SSR build | Merge behaviour                        |
| ------------------------------------------------------ | --------- | ------------ | --------- | -------------------------------------- |
| `plugins`                                              | Yes       | Yes          | Yes       | Append + dedupe by name (first wins)   |
| `define`                                               | Yes       | Yes          | Yes       | Shallow merge                          |
| `css.preprocessorOptions`                              | Yes       | Yes          | Yes       | Per-engine deep merge                  |
| `optimizeDeps` (`include`/`exclude`/`esbuildOptions`)  | Yes       | N/A          | N/A       | Dev-only subset; stripped from builds  |
| `esbuild`, `logLevel`                                  | Yes       | Yes          | Yes       | Override                               |
| `resolve.*` (not `alias`)                              | Yes       | Yes          | Yes       | Merge per key                          |
| `build.sourcemap` / `minify` / `terserOptions`         | N/A       | Yes          | Yes       | Override                               |
| `build.rollupOptions.external`                         | N/A       | Yes          | Yes       | Override                               |
| `build.rollupOptions.output.manualChunks`              | N/A       | Yes          | Yes       | Deprecated, FUNCTION form only          |
| `build.rolldownOptions.output.codeSplitting`           | N/A       | Yes          | Yes       | Canonical chunking (replaces the above) |
| aliases                                                | Yes       | Yes          | Yes       | Via top-level `alias` only             |
| `server.allowedHosts`                                  | Yes       | N/A          | N/A       | Dev-only; stripped from builds         |
| `server.*` other than `allowedHosts`                   | Protected | N/A          | N/A       | Dev: warned and dropped. Builds: stripped silently with the whole dev-only `server` object |
| `root`, `base`, `publicDir`, `configFile`, `appType`, `build.outDir`, `build.ssr` / `ssrManifest`, `build.format` / `target` / `manifest`, `build.rollupOptions.input`, `resolve.alias` | Protected | Protected | Protected | Rejected; logged at warn |

Protected fields are absent from `TaujsViteConfig`, so they cannot be supplied through the
typed surface at all. If one reaches the merge engine anyway (a JavaScript config, or an
`as any` cast), it is rejected and logged at warn rather than silently applied - including
`build.manifest`, which warns like its siblings. In dev the whole `build` key is rejected
(builds are a per-app concern).

**Development-only fields are the exception to "always warned".** `optimizeDeps` and
`server.allowedHosts` configure the shared development server, and the same `config.vite`
declaration also reaches every app build - so a build strips them **silently**. Warning there
would report ordinary configuration as misuse once per app on every build.

Under `server`, only `allowedHosts` is admitted. `ws` is withheld because `ws: false` disables
the WebSocket connection HMR runs on, which the framework owns through `server.ws` (the
deprecated `server.hmr` remains protected as legacy input, but is no longer the active
facility); `host`,
`port`, `strictPort`, `https` and `open` configure Vite's own HTTP listener, which does not
exist in middleware mode because Fastify owns the listener; and `proxy` overlaps caller-route
ownership. Supplying any of them **in development** warns and is not applied. In a build the
whole `server` object is stripped silently, so nothing under it warns there.

### How τjs composes Vite config

One precedence chain runs through one merge engine, in both dev and build:

```
framework invariants  ->  config.vite  ->  taujsBuild({ vite })
```

- Each layer merges over the previous with the per-field rules in the matrix. A later layer
  wins **field conflicts** while unrelated fields from earlier layers survive - so a CI wrapper
  passing `taujsBuild({ vite: { build: { sourcemap: true } } })` tunes only that field and
  keeps every `plugins`, `define`, and CSS setting declared in `taujs.config.ts`.
- Both layers coexisting is normal operation and is silent. A genuine per-field conflict
  between the two user layers is reported at warn, naming the field, both sources, and the
  winner (the programmatic layer). A framework default being overridden by a user layer is
  never warned.
- The dev server reads `config.vite` only; `taujsBuild({ vite })` is build-only and is not
  consulted in development.

#### Plugin composition

Plugins from every channel are composed by one rule, in declared order, deduped by plugin
`name` with the first occurrence winning across all sources. The order is:

- **Dev (shared server):** every app's `plugins` in config order, then `config.vite.plugins`,
  then the internal framework plugin(s).
- **Build (per app):** the app's `plugins`, then `config.vite.plugins`, then
  `taujsBuild.vite.plugins`, then the internal framework plugin(s).

Every cross-source name collision is reported at warn with the plugin name, each declaring
source, and the winner. Plugin options are never serialised or compared - identity is by
`name` alone; a nameless plugin passes through undeduped. Internal framework plugins are
appended **last** and are exempt from the user dedupe. The `τjs-` name prefix (Greek tau,
U+03C4) is reserved: a user plugin carrying it is dropped with a warning, so it can neither
displace nor impersonate a framework plugin. The renderer wrappers use ordinary Latin names
(`@taujs/react`'s `taujs:react-refresh-preamble-fix`, `@taujs/vue`'s `vite:vue`) and are not
affected.

### Reusing Vite fragments

Not auto-loading `vite.config.ts` does not close the Vite ecosystem. Reusable configuration
lives in an ordinary module, shareable with tools that genuinely are Vite-hosted:

```typescript
// vite.shared.ts
import type { TaujsViteConfig } from "@taujs/server/config";

export const sharedVite = {
  define: { __VERSION__: JSON.stringify(version) },
  plugins: [ecosystemPlugin()],
} satisfies TaujsViteConfig;
```

```typescript
// taujs.config.ts
import { defineConfig } from "@taujs/server/config";
import { sharedVite } from "./vite.shared";

export default defineConfig({ vite: sharedVite, apps: [/* ... */] });
```

Vitest, Storybook, or a standalone Vite app import the same `sharedVite` pieces into their own
config files; τjs simply never discovers those files implicitly. The `satisfies TaujsViteConfig`
check keeps the shared fragment within the supported surface.

## Route Configuration

Routes define URL patterns, rendering strategies, and data requirements.

### Basic Route

```typescript
{
  path: '/about',
  attr: {
    render: 'ssr'
  }
}
```

### Route with Parameters

```typescript
{
  path: '/users/:id',
  attr: {
    render: 'ssr',
    data: async (params) => ({
      userId: params.id
    })
  }
}
```

### Route Properties

| Property | Type              | Required | Description                  |
| -------- | ----------------- | -------- | ---------------------------- |
| `path`   | `string`          | Yes      | Fastify route path |
| `attr`   | route attribute config | No       | See [Route Attributes](#route-attributes) |

### Route Attributes

| Property     | Type                      | Default     | Description         |
| ------------ | ------------------------- | ----------- | ------------------- |
| `render`     | `'ssr' \| 'streaming'`    | Required    | Rendering strategy  |
| `hydrate`    | `boolean`                 | `true`      | Hydrate the client renderer |
| `meta`       | `Record<string, unknown>` | `{}`        | Static metadata passed to `headContent` |
| `middleware` | `Middleware`              | `undefined` | Auth and CSP        |
| `data`       | `DataHandler`             | `undefined` | Data loader         |
| `deferred`   | `DeferredDataAttributes`  | `undefined` | **`streaming` only.** A flat record of named route-owned loaders whose values may arrive after rendering begins. See [Deferred Route Data](#deferred-route-data) |
| `head`       | `HeadAttributes`          | `undefined` | Dynamic head data loader: `{ data, timeoutMs?, optional? }`, resolved before the render starts on both strategies and passed to `headContent` as `headData`. `timeoutMs` must be positive finite (default 3000 ms); `optional: true` degrades loader failures to `headData: undefined` instead of failing the request |

## Rendering Strategies

### SSR (Server-Side Rendering)

Complete HTML rendered before sending:

```typescript
{
  path: '/products',
  attr: {
    render: 'ssr',
    data: async () => {
      const products = await db.products.findAll();
      return { products };
    }
  }
}
```

**Characteristics:**

- Data fully loaded before rendering
- Complete HTML in single response
- Guaranteed data in `headContent`
- `attr.head` (if declared) resolves before the render and arrives as `headData`

**React renderer semantics (`@taujs/react`):** the `ssr` strategy renders complete HTML with
React's `prerenderToNodeStream`, so `React.lazy` and `use()` content is included in the response.
Earlier versions used `renderToString`, which silently replaced any suspending subtree with its
Suspense fallback. The render is bounded by the renderer's `ssrOptions.prerenderTimeoutMs`
(default 10000 ms). On expiry, a page whose shell completed is served with its unfinished
Suspense boundaries in their fallback state - the client completes them after hydration - while a
page whose shell never completed fails the request instead of serving a blank page. Set
`prerenderTimeoutMs: 0` to wait indefinitely.

### Streaming SSR

Progressive HTML delivery:

```typescript
{
  path: '/dashboard',
  attr: {
    render: 'streaming',
    meta: {  // Required for streaming
      title: 'Dashboard',
      description: 'User dashboard'
    },
    data: async () => {
      const metrics = await fetchMetrics();
      return { metrics };
    }
  }
}
```

**Characteristics:**

- Renderer output streams after required pre-shell work
- Content streams according to the selected renderer semantics
- React and Vue may build the streamed head before route `data` settles; Solid waits for critical
  data. Declare `attr.head` for portable dynamic head data, resolved before rendering and delivered
  as `headData`; `meta` remains available as static input for the application fallback.
- **Requires `meta` property**

### Static (No Hydration)

SSR without client-side JavaScript:

```typescript
{
  path: '/terms',
  attr: {
    render: 'ssr',
    hydrate: false
  }
}
```

## Data Loading

### Direct Return

```typescript
{
  path: '/about',
  attr: {
    render: 'ssr',
    data: async (params, ctx) => {
      const res = await fetch('https://api.example.com/about');
      return await res.json();
    }
  }
}
```

### Service Descriptor

```typescript
{
  path: '/users/:id',
  attr: {
    render: 'ssr',
    data: async (params) => ({
      serviceName: 'UserService',
      serviceMethod: 'getUser',
      args: { id: params.id }
    })
  }
}
```

### Request Context

Data handlers receive context:

```typescript
data: async (params, ctx) => {
  // ctx.requestId: canonical request identity, always String(req.id)
  // ctx.logger: Scoped logger
  // ctx.headers: Request headers

  ctx.logger.info({ userId: params.id }, "Loading user");

  return { user: await getUser(params.id) };
};
```

### Deferred Route Data

A `streaming` route may additionally declare `attr.deferred`: a flat record of named loaders whose
values are allowed to arrive after rendering has begun. `attr.data` remains the critical snapshot
the response cannot start without; `deferred` declares response-owned work that is started but not
awaited. τjs starts deferred work without awaiting it before invoking the renderer, and
subsequent byte ordering follows the renderer's native streaming semantics.

```typescript
{
  path: '/products/:id',
  attr: {
    render: 'streaming',
    meta: { title: 'Product' },

    // critical: the response waits for this
    data: serviceData('catalogue', 'product', ({ id }) => ({ id })),

    // response-owned, started without being awaited
    deferred: {
      reviews: serviceData('reviews', 'forProduct', ({ id }) => ({ id })),
    },
  },
}
```

Entries are the ordinary `DataHandler` shape, `serviceData()` sugar included - there is no new
helper and no wrapper. τjs starts each named loader exactly once per request, outside the component
tree and before the head resolves, and the selected renderer projects the named promise onto its own
Suspense primitive. Because the work is declared, it appears in the request graph (contributing to a
service's `usedBy`) and each entry records one outcome on the request episode.

Deferred entries are not HTTP-status-bearing. Their outcome may arrive after the response has
committed - the status line and headers are long gone by the time a deferred loader settles. Any
condition that must prevent the response, redirect it or determine its status belongs in critical
route resolution before rendering (`attr.data`, `attr.middleware`, `attr.head`), never in
`attr.deferred`. `complete`, `failed` and `aborted` are deferred-data outcomes recorded on the
episode and delivered to the hydration seed - they are not HTTP response statuses.

Component-facing accessors live in the renderer packages:
[React](/renderers/react#deferred-route-data),
[Vue](/renderers/vue#deferred-route-data) and
[Solid](/renderers/solid#deferred-route-data).

**Rules, all enforced at boot:**

- `deferred` is valid on `render: 'streaming'` only. On an `ssr` route it is both a type error and a
  boot error: data a non-streamed response needs belongs in `attr.data`.
- the value must be a plain object whose members are functions, and each key must match
  `^[A-Za-z][A-Za-z0-9_]*$`.
- there is no per-entry timeout, retry, optionality or dependency between entries. `deferred`
  describes **timing**, not policy - an optional business outcome is expressed by the loader's own
  result (for example `{ available: false }`).

**Outcomes.** Every entry settles as exactly one of `complete`, `failed` or `aborted`, recorded once
on the request episode and readable through the existing MCP reader. `complete` means *deliverable*: a
resolved value that cannot cross the hydration boundary is classified `failed` on every surface at
once, with a single payload-free warning (`Deferred data could not cross the hydration boundary
key=<key>`) explaining why. An entry that no component read, whose loader rejects after the response
terminal, reads as `aborted` rather than `failed` - the response had already finished, so nothing
was waiting on the value. An unread rejection never turns a completed document into a 500; a failure
of critical `attr.data` (or of a non-optional `attr.head`) aborts and detaches deferred work that has
already started. No deferred work outlives the response as τjs-owned background work.

**Hydration.** Outcomes for the boundaries a component actually read travel in a private, internal
carrier written beside `window.__INITIAL_DATA__` at end of stream, read once by the client bootstrap
and then deleted. The public `__INITIAL_DATA__` shape is unchanged, no loader re-executes in the
browser, and no client refetch is issued. Under `hydrate: false` no carrier is emitted at all - the
value still streams into the server-rendered HTML natively.

**Types.** `DeferredDataOf<typeof route>` (exported from `@taujs/server/config`) infers the payload
of every declared entry from the route configuration alone, following the same three arms as
`HeadDataOf`: the selected method's result for `serviceData()` sugar, the resolved return type for a
closure handler, and `undefined` when a route declares no `deferred`. Applications therefore never
re-declare a deferred payload shape. The inferred type describes the loader's declared result; what
arrives is that value's JSON snapshot, the same caveat that already applies to `attr.data` crossing
`__INITIAL_DATA__`.

## Security Configuration

### Content Security Policy

```typescript
export default defineConfig({
  security: {
    csp: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
      },
    },
  },
});
```

### CSP with Reporting

```typescript
security: {
  csp: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"]
    },
    reporting: {
      endpoint: '/api/csp-violations',
      reportOnly: false,
      onViolation: (report, req) => {
        console.log('CSP violation:', report);
      }
    }
  }
}
```

### Per-Route CSP

```typescript
{
  path: '/embed',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        mode: 'merge',  // or 'replace'
        directives: {
          'frame-ancestors': ["'self'", 'https://trusted.com']
        }
      }
    }
  }
}
```

### Dynamic CSP

```typescript
{
  path: '/user/:id',
  attr: {
    render: 'ssr',
    middleware: {
      csp: {
        directives: ({ params }) => ({
          'img-src': [
            "'self'",
            `https://cdn.example.com/users/${params.id}/`
          ]
        })
      }
    }
  }
}
```

### Disabling CSP

```typescript
// Hard disable - no header
{
  path: '/legacy',
  attr: {
    middleware: {
      csp: false
    }
  }
}

// Soft disable - use global only
{
  path: '/report',
  attr: {
    middleware: {
      csp: {
        disabled: true
      }
    }
  }
}
```

## Authentication

### Require Authentication

```typescript
{
  path: '/dashboard',
  attr: {
    render: 'ssr',
    middleware: {
      auth: {}
    }
  }
}
```

### Role-Based Access

```typescript
{
  path: '/admin',
  attr: {
    render: 'ssr',
    middleware: {
      auth: {
        roles: ['admin', 'superadmin']
      }
    }
  }
}
```

### Custom Auth Metadata

```typescript
{
  path: '/api/data',
  attr: {
    render: 'ssr',
    middleware: {
      auth: {
        strategy: 'api-key',
        redirect: '/login'
      }
    }
  }
}
```

**Note:** τjs doesn't interpret `roles`, `strategy`, or `redirect`. These are metadata for your `authenticate` decorator to read.

## Complete Examples

### Single Page Application

```typescript
export default defineConfig({
  server: {
    port: 3000,
  },
  apps: [
    {
      appId: "web",
      entryPoint: "client",
      routes: [
        {
          path: "/",
          attr: {
            render: "ssr",
            data: async () => ({
              title: "Home",
              content: "Welcome",
            }),
          },
        },
      ],
    },
  ],
});
```

### Multi-App Configuration

```typescript
export default defineConfig({
  server: {
    host: "localhost",
    port: 5173,
  },
  apps: [
    {
      appId: "customer",
      entryPoint: "app",
      routes: [
        {
          path: "/app/*",
          attr: {
            render: "streaming",
            meta: { title: "App" },
            middleware: { auth: { strategy: "jwt" } },
          },
        },
      ],
    },
    {
      appId: "admin",
      entryPoint: "admin",
      routes: [
        {
          path: "/admin/*",
          attr: {
            render: "ssr",
            middleware: {
              auth: {
                strategy: "session",
                roles: ["admin"],
              },
            },
          },
        },
      ],
    },
  ],
  security: {
    csp: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  },
});
```

## Validation

τjs validates configuration at startup:

```
[τjs] [config] Loaded 2 app(s), 15 route(s) in 2.3ms
[τjs] [security] CSP configured (15/15 routes) in 0.8ms
[τjs] [auth] ✓ 5 route(s) require auth
```

### Common Errors

| Error                                            | Cause                         | Solution                        |
| ------------------------------------------------ | ----------------------------- | ------------------------------- |
| "At least one app must be configured"            | Empty `apps` array            | Add at least one app            |
| "Routes require auth but authenticate() missing" | Auth routes without decorator | Add `authenticate()` to Fastify |
| "Route path declared in multiple apps"           | Duplicate paths               | Use unique paths per app        |
| "Entry client file not found"                    | Missing build artifacts       | Run `npm run build`             |
| "meta required for streaming routes"             | Streaming without meta        | Add `meta: {}` to route         |

## Best Practices

### 1. Use defineConfig

```typescript
// type checking
export default defineConfig({
  apps: [
    /* ... */
  ],
});

// less ideal - no type checking
export default {
  apps: [
    /* ... */
  ],
};
```

### 2. Compose Route and App Fragments

Routes do not have to live in `taujs.config.ts`. `defineRoutes` is a const-preserving identity
helper: a domain or feature module builds its own route array, and composes at the root by
spreading - the literal path and data types survive the module boundary exactly as if the routes
had been declared inline.

```typescript
// authRoutes.ts
import { defineRoutes } from "@taujs/server/config";

export const authRoutes = defineRoutes([
  { path: "/login", attr: { render: "ssr" } },
  { path: "/register", attr: { render: "ssr" } },
]);
```

```typescript
// dashboardRoutes.ts
import { defineRoutes } from "@taujs/server/config";

export const dashboardRoutes = defineRoutes([
  { path: "/dashboard", attr: { render: "streaming", meta: {} } },
  { path: "/settings", attr: { render: "ssr" } },
]);
```

```typescript
// taujs.config.ts
import { defineConfig } from "@taujs/server/config";
import { reactRenderer } from "@taujs/react/renderer";
import { authRoutes } from "./authRoutes";
import { dashboardRoutes } from "./dashboardRoutes";

export default defineConfig({
  apps: [
    {
      appId: "web",
      entryPoint: "client",
      renderer: reactRenderer({ project: "./tsconfig.json" }),
      routes: [...authRoutes, ...dashboardRoutes],
    },
  ],
});
```

`defineRoutes` is the common form - most applications compose within one app. Reach for
`defineApp` only where a domain genuinely owns a whole application boundary: its own renderer,
its own client and SSR build.

```typescript
// adminApp.ts
import { defineApp } from "@taujs/server/config";
import { reactRenderer } from "@taujs/react/renderer";

export const adminApp = defineApp({
  appId: "admin",
  entryPoint: "admin",
  renderer: reactRenderer({ project: "./tsconfig.json" }),
  routes: [{ path: "/admin/*", attr: { render: "ssr" } }],
});
```

```typescript
// taujs.config.ts
import { defineConfig } from "@taujs/server/config";
import { adminApp } from "./adminApp";
import { webApp } from "./webApp";

export default defineConfig({
  apps: [webApp, adminApp],
});
```

Both helpers are identity at runtime - neither validates anything. Their entire job is to be the
point where a fragment's literal types are captured, so `RouteContext` and `RouteData` stay exact
wherever the fragment is authored. Only use them at a fragment's module boundary: wrapping routes
that are already declared inline inside `defineConfig` is redundant ceremony.

**A plain variable typed with a broad annotation before it reaches either helper still loses
precision - the composition still compiles, silently.** Neither helper can reconstruct precision
an upstream declaration already erased. One line pins the exact path union a fragment author
expects, so a regression fails to compile instead of degrading silently:

```typescript
// selfCheck.ts
import type { RouteContext } from "@taujs/server/config";
import config from "./taujs.config";

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _RoutesStayExact = Expect<Eq<RouteContext<typeof config>["path"], "/login" | "/register" | "/dashboard" | "/settings">>;
```

If any fragment's routes widen - a variable annotated with a broad type upstream, a missed
spread, a stray `satisfies AppConfig` on a mutable object - this assertion fails to compile,
naming exactly what changed.

**Composition is organisational, not runtime isolation.** Splitting configuration into fragments
is about which team owns which routes, reviewed and versioned wherever that team's code lives. It
does not create a second dev server, a second Fastify scope or a second service registry - one
τjs installation still runs exactly one of each, however many modules the configuration is
authored across. See [τjs Architecture](/guides/architecture#the-ownership-layers) for the full
ownership boundary.

### 3. Use Service Descriptors

```typescript
// testable, reusable
data: async (params) => ({
  serviceName: "UserService",
  serviceMethod: "getUser",
  args: { id: params.id },
});

// less ideal - mixed concerns
data: async (params) => {
  const res = await fetch(`/api/users/${params.id}`);
  return await res.json();
};
```

### 4. Provide Complete Meta for Streaming

```typescript
// reliable SEO
{
  path: '/blog/:slug',
  attr: {
    render: 'streaming',
    meta: {
      title: 'Blog Post',
      description: 'Read our latest blog',
      ogType: 'article'
    }
  }
}
```

### 5. Use Structured Logging

```typescript
data: async (params, ctx) => {
  ctx.logger.info({ userId: params.id }, "Loading user");

  try {
    const user = await getUser(params.id);
    return { user };
  } catch (err) {
    ctx.logger.error({ userId: params.id, error: err }, "Load failed");
    throw err;
  }
};
```

## Environment-Specific Configuration

### Using Environment Variables

```typescript
export default defineConfig({
  server: {
    host: process.env.HOST || "localhost",
    port: parseInt(process.env.PORT || "5173"),
  },
  apps: [
    {
      appId: "web",
      entryPoint: "client",
      routes: [
        /* ... */
      ],
    },
  ],
});
```

### Conditional Configuration

```typescript
// Development is requested explicitly. Every other value - `production`, `test`, `staging`,
// unset - is production, which is how τjs derives its own runtime mode.
const isDev = process.env.NODE_ENV === "development";

export default defineConfig({
  server: {
    port: isDev ? 5173 : 3000,
  },
  security: {
    csp: {
      directives: {
        "script-src": isDev
          ? ["'self'", "'unsafe-inline'"] // Dev only
          : ["'self'"], // Production
      },
    },
  },
});
```

<!-- ## What's Next?

- [Build & Deployment](/reference/build-deployment) - Build process and deployment
- [Static Assets](/reference/static-assets) - Serving static files
- [@taujs/react](/renderers/react) - React integration reference -->
