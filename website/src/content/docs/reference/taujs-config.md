---
title: τjs Configuration
description: Complete reference for configuring τjs applications
---

Complete reference for configuring τjs applications.

## Overview

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
      entryPoint: "client",
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
  apps: AppConfig[];
  alias?: Record<string, string>;
  vite?: TaujsViteOverride;
};

type ServerConfig = {
  host?: string; // Default: 'localhost'
  port?: number; // Default: 5173
  hmrPort?: number; // Default: 5174
};

type AppConfig = {
  appId: string;
  entryPoint: string;
  plugins?: PluginOption[];
  routes?: AppRoute[];
};

type AppRoute = {
  path: string;
  attr?: RouteAttributes;
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

3. **Config object**: `server.*` properties

4. **Defaults**: `{ host: 'localhost', port: 5173, hmrPort: 5174 }`

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

## App Configuration

Define frontend applications with their entry points and routes.

```typescript
apps: [
  {
    appId: "web",
    entryPoint: "client",
    routes: [
      /* ... */
    ],
    plugins: [
      /* optional Vite plugins */
    ],
  },
  {
    appId: "admin",
    entryPoint: "admin",
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
| `entryPoint` | `string`         | Yes      | Directory under client root    |
| `routes`     | `AppRoute[]`     | No       | Route definitions              |
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

### Entry Point Structure

Each `entryPoint` directory must contain:

```
client/{entryPoint}/
├── index.html          # HTML template
├── entry-client.tsx    # Client hydration entry
└── entry-server.tsx    # SSR render entry
```

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
  // Build-tuning subset - the framework owns everything else under build.
  build?: {
    sourcemap?: BuildOptions["sourcemap"];
    minify?: BuildOptions["minify"];
    terserOptions?: BuildOptions["terserOptions"];
    rollupOptions?: {
      external?: Rollup.ExternalOption;
      output?: {
        manualChunks?: Rollup.ManualChunksOption;
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
    // Relative values resolve against the project root at config load.
    "@components": "./src/client/shared/components",
    // Absolute values pass through untouched.
    "@icons": "/opt/shared/icons",
  },
  apps: [/* ... */],
});
```

**Normalisation rule:** Vite does not resolve relative alias replacements - it expects
absolute paths. τjs therefore normalises declarative values at config load: a relative
replacement resolves against the project root, an absolute one passes through untouched. This
keeps the config file free of `path.resolve(...)` boilerplate without shipping strings Vite
would misread.

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
| `build.rollupOptions.output.manualChunks`              | N/A       | Yes          | Yes       | Merge into output                      |
| aliases                                                | Yes       | Yes          | Yes       | Via top-level `alias` only             |
| `root`, `base`, `publicDir`, `configFile`, `appType`, `server.*`, `build.outDir`, `build.ssr` / `ssrManifest`, `build.format` / `target` / `manifest`, `build.rollupOptions.input`, `resolve.alias` | Protected | Protected | Protected | Rejected; logged at warn |

Protected fields are absent from `TaujsViteConfig`, so they cannot be supplied through the
typed surface at all. If one reaches the merge engine anyway (a JavaScript config, or an
`as any` cast), it is rejected and logged at warn rather than silently applied - including
`build.manifest`, which warns like its siblings. In dev the whole `build` key is rejected
(builds are a per-app concern), and `optimizeDeps` never reaches any build config.

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
| `path`   | `string`          | Yes      | URL pattern (path-to-regexp) |
| `attr`   | `RouteAttributes` | No       | Rendering and data config    |

### Route Attributes

| Property     | Type                      | Default     | Description         |
| ------------ | ------------------------- | ----------- | ------------------- |
| `render`     | `'ssr' \| 'streaming'`    | Required    | Rendering strategy  |
| `hydrate`    | `boolean`                 | `true`      | Add React on client |
| `meta`       | `Record<string, unknown>` | `{}`        | Metadata for head   |
| `middleware` | `Middleware`              | `undefined` | Auth and CSP        |
| `data`       | `DataHandler`             | `undefined` | Data loader         |
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

- Shell sent immediately
- Content streams as it renders
- Route `data` may not be ready when `headContent` runs - declare `attr.head` for DYNAMIC head
  data (resolved before the shell, delivered as `headData`); `meta` remains the static layer
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
  // ctx.traceId: Request trace ID
  // ctx.logger: Scoped logger
  // ctx.headers: Request headers

  ctx.logger.info({ userId: params.id }, "Loading user");

  return { user: await getUser(params.id) };
};
```

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
          path: "/app/:feature?/:id?",
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
          path: "/admin/:section?/:id?",
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

### 2. Group Routes by Feature

```typescript
const authRoutes: AppRoute[] = [
  { path: "/login", attr: { render: "ssr" } },
  { path: "/register", attr: { render: "ssr" } },
];

const dashboardRoutes: AppRoute[] = [
  { path: "/dashboard", attr: { render: "streaming", meta: {} } },
  { path: "/settings", attr: { render: "ssr" } },
];

export default defineConfig({
  apps: [
    {
      appId: "web",
      entryPoint: "client",
      routes: [...authRoutes, ...dashboardRoutes],
    },
  ],
});
```

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
const isDev = process.env.NODE_ENV !== "production";

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
