---
'@taujs/solid': minor
'@taujs/create-taujs': patch
---

Solid is now a full τjs renderer

`@taujs/solid` ships `createRenderer`, `createSSRStore`, `useSSRStore` and `hydrateApp`, and
`@taujs/solid/renderer` exposes `solidRenderer({ project })`. Declare a Solid app the same way as
React and Vue:

```ts
import { solidRenderer } from '@taujs/solid/renderer';

renderer: solidRenderer({ project: './tsconfig.solid.json' }),
```

`create-taujs` gains `--framework solid`, and the CLI is now scriptable:

```sh
create-taujs my-app --framework solid --package-manager pnpm --no-install
```

`--package-manager npm|pnpm|yarn` and the mutually exclusive `--install` / `--no-install` suppress
only their own prompts; omit them and the prompts behave exactly as before. With all four supplied
the CLI never needs a TTY, so CI, scripts and agents can drive it. There is deliberately no
`--yes`: its defaults, and whether it would install from the network, would be ambiguous.

What is worth knowing before you write Solid components:

- **Route data comes from the store, not a resource.** `useSSRStore<T>().data()` is a Solid
  accessor. The server commits route data before rendering, so it reads synchronously; the client
  seeds it from `window.__INITIAL_DATA__`. The documented trade is that τjs route data is not
  streamed through Solid's `$df` patch channel - it travels in the single `__INITIAL_DATA__`
  authority instead. Application-owned `createResource` values still stream normally.
- **The renderer owns the compiler.** `solidRenderer({ project })` supplies `vite-plugin-solid`
  internally with `ssr: true` forced; do not add it to `plugins` yourself. Point `project` at a
  tsconfig that claims only your client TSX. Raw `pluginSolid()` from `@taujs/solid/plugin` remains
  the portable escape hatch for plain Vite, with the full option surface.
- **`renderId` must match between entries.** Export one constant and import it into both
  entry-server and entry-client.
- **Serialised errors are redacted.** Every `Error` that Solid serialises into the page becomes
  exactly `{ name: 'Error', message: '[redacted]' }` - message, stack, cause and custom properties
  are stripped in development and production alike, because they otherwise reach the browser
  verbatim. This applies to ordinary `Error` values in your data too, so send a safe DTO such as
  `{ code: 'NOT_FOUND', publicMessage: 'Item unavailable' }` rather than an `Error` when you want
  detail on the client. Server-side detail belongs in server logs.
- **Solid never calls `onRenderError`.** A rejected resource after the shell has flushed is
  indistinguishable, through Solid's supported APIs, from an ordinary serialised `Error` value, so
  τjs does not guess: the response completes, the rejection is redacted, and your client
  `ErrorBoundary` handles it at hydration. Report resource failures where you create the resource.
  The callback stays in the shared contract because React genuinely supplies it.
- **`hydrateApp` is deliberately lean** - `app`, `renderId`, `rootElementId`, `onHydrationError`.
  A hydration failure reports and stops rather than silently remounting, so a server/client
  divergence stays visible instead of hiding behind a page that looks fine.

Also fixed in `create-taujs`, for React and Vue as well as Solid - three defects that meant no
generated project of any framework fully worked:

- `src/server/types.d.ts` now imports `@taujs/server/config` before augmenting it. Without the
  import the block was an ambient module declaration that replaced the real module, so
  `defineConfig`/`defineService`/`defineServiceRegistry` failed to resolve and route `data`
  callbacks fell to implicit `any`. Generated projects did not typecheck.
- `esbuild` is now a declared devDependency; `build:server` invokes its binary and failed with
  "command not found".
- The Vite builds pin `NODE_ENV=production`. Without it the bundle followed the caller's
  `NODE_ENV` - and CI commonly sets `NODE_ENV=test` - which baked React's development JSX runtime
  into the production SSR bundle and crashed the production server.
