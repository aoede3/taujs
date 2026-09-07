# @taujs/html

`npm install @taujs/html`

`yarn add @taujs/html`

`pnpm add @taujs/html`

# τjs

HTML Renderer: SSR and Streaming SSR with no component framework

https://taujs.dev/

A framework-free HTML renderer for the τjs (taujs) ecosystem: `render()` returns raw
`{ headContent, appHtml }` fragments, written to the response verbatim. Standalone and
runtime-agnostic - no dependencies, no templating helper, no escaping helper. The application owns
its own HTML safety.

https://taujs.dev/renderers/html/

## Quick start

```ts
// entry-server.ts
import { createRenderer } from '@taujs/html';

// @taujs/html provides NO escaping helper - this three-line escaper is the APPLICATION's own
// responsibility for any value interpolated from `data`/`meta` into the returned HTML.
const escape = (value: unknown): string =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const { renderSSR, renderStream } = createRenderer({
  render: ({ data, meta }) => ({
    headContent: `<title>${escape(meta.title ?? '')}</title>`,
    appHtml: `<section>${escape((data as { message?: string }).message ?? '')}</section>`,
  }),
});
```

```ts
// taujs.config.ts
import { htmlRenderer } from '@taujs/html/renderer';

export default defineConfig({
  apps: [{ appId: 'app', entryPoint: '', renderer: htmlRenderer(), routes: [/* ... */] }],
});
```

```ts
// entry-client.ts - reads the deferred envelope this renderer delivers as DATA, never as markup.
import { onDataReady } from '@taujs/html/client';

onDataReady(({ data, deferred }) => {
  // enhance the server-rendered HTML in place
});
```

`render` is entirely optional: omit it to let the template own the whole document. `@taujs/html`
provides no escaping helper - any value interpolated from `data`, `headData` or user input into
`render`'s returned HTML must be escaped by the application before interpolation.
