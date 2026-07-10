---
'@taujs/create-taujs': minor
---

Add a Vue framework option to the scaffolder (V2-02). `create-taujs` now prompts
"Framework: React / Vue" (React default) and accepts a non-interactive
`--framework react|vue` flag. The Vue template scaffolds an app equivalent to the React
one — same `/` (ssr) and `/streaming` (streaming) routes, same shared server half, same MCP
wiring — using `@taujs/vue`: `App.vue` with a route switch, `HomePage.vue` (`useSSRData` +
`v-if`) and `StreamingPage.vue` (`await useSSRDataAsync` under `<Suspense>`), `.ts` client
entries, a `*.vue` type shim, `plugins: [pluginVue()]` in `taujs.config.ts`, and `vue-tsc`
for client typechecking. React output is unchanged (byte-identical, golden-tested).
