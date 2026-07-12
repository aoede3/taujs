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

### Entry Point Structure

Each `entryPoint` directory must contain:

```
client/{entryPoint}/
├── index.html          # HTML template
├── entry-client.tsx    # Client hydration entry
└── entry-server.tsx    # SSR render entry
```

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
- Data may not be ready when `headContent` runs
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
