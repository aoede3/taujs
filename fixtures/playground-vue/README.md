# playground-vue

The Vue twin of `fixtures/playground`: one bootable τjs app that exercises `@taujs/vue`
end-to-end against the **workspace** package (`@taujs/vue: workspace:*`), so it runs on the
current source without publishing. It is the runtime evidence for Gate V2 — SSR, streaming
SSR, and hydration in a real Fastify server.

Two routes:

- `/` — `render: 'ssr'`; consumes data with `useSSRData` + `v-if` (non-blocking fallback idiom).
- `/streaming` — `render: 'streaming'`; `await useSSRDataAsync` under `<Suspense>` (blocking
  idiom), so the resolved data reaches the payload and the route hydrates.

`setupApp` (shared by `entry-server` and `entry-client`) installs a `provide` that `App.vue`
injects — proving the hook runs identically on every render/mount path.

## Run

```bash
pnpm --filter playground-vue dev        # dev server → http://localhost:5273
pnpm --filter playground-vue build      # client + SSR build
pnpm --filter playground-vue start      # prod server (after build)
pnpm --filter playground-vue typecheck  # vue-tsc
```

`pluginVue()` in `taujs.config.ts` is the load-bearing difference from the React fixture —
Vue SFCs need it in dev (`ssrLoadModule`) and in both Vite builds.
