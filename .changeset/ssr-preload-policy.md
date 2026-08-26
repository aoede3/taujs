---
'@taujs/server': minor
---

Browser asset hints come from the client manifest, and `ssr-manifest.json` is no longer generated

Production SSR pages emitted `<link rel="modulepreload">` tags built from `ssr-manifest.json`, which taujs generated on the SSR build. That manifest describes the SSR bundle's own private chunk graph: a directory that is never served, with content hashes unrelated to the client build's. Every tag it produced pointed at a URL that does not exist under `dist/client`, so any app with a dynamic `import()` in its client tree served a console 404 and a wasted request on every server-rendered page. A second defect sat in the same path: Vite bakes the configured `base` into every ssr-manifest value inside its own plugin, while the client `manifest.json` carries no prefix, and taujs applied one prepending convention to both - so the emitted URL gained the base segment twice.

Browser asset information now comes exclusively from the client build's `.vite/manifest.json`, the artefact taujs already reads for the entry script and stylesheets. `ssr-manifest.json` is no longer generated, read or retained.

The preload policy is now stated rather than implied:

- the client entry ships as the bootstrap `<script type="module">`, and is never additionally preloaded;
- its recursive **static**-import closure is emitted as `<link rel="modulepreload">`;
- `dynamicImports` are not followed. A dynamically imported route or component may well have taken part in the server render, but taujs cannot yet identify which ones did, so preloading them all would be guessing at the browser's expense. Render-used lazy modules need every renderer to report the modules a render touched, which is deferred to its own RFC;
- module preloads are emitted only when the route's effective `hydrate` is true. A route that does not hydrate has no client execution graph to accelerate;
- images and fonts are no longer preloaded, for the same evidential reason as dynamic imports.

Stylesheets are deliberately unchanged in scope: every stylesheet the client build emitted for the app is still applied. Narrowing CSS to the static closure in the same change would leave a server-rendered lazy component unstyled until hydration fetched its CSS, which is a visual regression, so the existing behaviour is kept and the trade-off recorded: until render-used module reporting exists across all renderers, taujs favours SSR styling correctness over route-level CSS selectivity.

The stylesheet tag itself changes from `rel="preload stylesheet" as="style"` to `rel="stylesheet"`. taujs has no separate CSS-preload policy here: HTML processes multiple `rel` keywords as separate link relationships (`as` belongs to the `preload` one), so combining `preload` and `stylesheet` does not create a special mode, and a stylesheet in the head already initiates its own fetch. Every emitted `href` is now HTML-attribute-escaped, matching the bootstrap script tag.

`build.ssrManifest` remains a protected field. Its framework-owned value is now `false`, and it stays protected so an override cannot reintroduce an unmanaged manifest.

If you have a post-build workaround that empties or deletes `dist/ssr/**/.vite/ssr-manifest.json`, it can be removed - but make it tolerate the file's absence before upgrading.
