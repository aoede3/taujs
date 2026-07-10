---
'@taujs/vue': minor
---

First release of `@taujs/vue` (V2-01): framework-agnostic Vue SSR primitives — the
transport layer for server-side rendering and hydration, sharing the τjs render-surface and
streaming protocol. Provides `createRenderer` (`renderSSR` + in-order streaming
`renderStream`), a Vue-native SSR data store (`createSSRStore`, `useSSRData`,
`useSSRDataAsync` under `<Suspense>`, `useSSRStore`, `useSSRReady`, `useSSRStatus`),
`hydrateApp` with hydration-error handling and a DevTools beacon twin, `setupApp` app-instance
customization on every render/mount path, `<Teleport>` collection on `renderSSR`, and
`pluginVue` (via `@taujs/vue/plugin`). Standalone and runtime-agnostic; ESM-only.
