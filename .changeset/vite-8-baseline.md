---
'@taujs/server': minor
'@taujs/react': minor
'@taujs/vue': minor
'@taujs/solid': minor
'@taujs/create-taujs': minor
---

feat: Vite 8 baseline - synchronised upgrade to Vite 8.2.1

**BREAKING CHANGES** (released as `minor` under the repository's pre-1.0 convention - these
packages are pre-1 and a `major` bump would declare τjs stable 1.0, which this work does not
decide).

**You must upgrade Vite to `^8.2.1` and Node to `^20.19.0 || >=22.12.0`.**

The four Vite-bearing packages move their `vite` dependency and peer baseline to `^8.2.1`,
and the workspace Node engine rises to `^20.19.0 || >=22.12.0` to match Vite's own
requirement. Renderer plugin peer FLOORS rise with it, because every previous floor admitted
a plugin release that cannot work with Vite 8: `@vitejs/plugin-react ^5.2.0`,
`@vitejs/plugin-vue ^6.0.3`, `vite-plugin-solid ^2.11.11`. The scaffolder emits the new pins.

BREAKING - the `manualChunks` OBJECT form is removed. Vite 8/Rolldown does not support it, so a
build declaring it would not chunk as written. taujs rejects it at the
configuration boundary with a migration error rather than letting that happen, and
deliberately does NOT translate it (exact Rollup object semantics involve module resolution
and dependency capture, so an approximation could produce different bundles).

```ts
// before - no longer supported
export default defineConfig({
  vite: { build: { rollupOptions: { output: { manualChunks: { vendor: ['react', 'react-dom'] } } } } },
});

// after - canonical Vite 8 chunking
export default defineConfig({
  vite: { build: { rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'vendor-react', test: /node_modules/ }] } } } } },
});

// also still accepted, deprecated: the FUNCTION form
export default defineConfig({
  vite: { build: { rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : null) } } } },
});
```

Declaring both the deprecated and canonical paths now fails with an error naming both, rather
than letting the bundler ignore one of them.

fix: the React compiler's plugin scope is intersected with transformable JS/TS extensions.
A tsconfig claim such as `src/client/**/*` legitimately covers `.css` and `.html` for
type-checking, and Vite 8's transform parses whatever the plugin claims as JavaScript - which
broke development SSR for any application importing CSS. Ownership claims are unchanged; only
the plugin scope is narrowed.
