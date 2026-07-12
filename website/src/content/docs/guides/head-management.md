---
title: <head> Management
description: How τjs manages document head content
---

τjs provides flexible document `<head>` management through a `headContent` function defined in your `entry-server.tsx`.

:::caution[headContent is a raw-HTML sink]
Whatever `headContent` returns is written into `<head>` **verbatim** - it is not auto-escaped. Escape
every value you interpolate that could carry service data, user input, or other untrusted content
(from **either** `data` **or** `meta` - route meta is often built from application data too). Use the
`escapeHtml` helper exported by `@taujs/react` / `@taujs/vue` for HTML text and quoted attributes; see
[Escape User Content](#3-escape-user-content) for the important exceptions (JSON-LD / `<script>`, URLs).
:::

## Composition Order

τjs assembles the document head in a fixed, intentional order:

1. **Template (`index.html`)**

   - Provides the static baseline:
     - `<html>`, `<head>`, `<body>`
     - `<meta charset>`, `<meta viewport>`
     - global links and static tags
   - Acts as the structural shell of the document.

2. **Route Meta (`taujs.config.ts`)**

   - Declares _intent_ at the routing layer.
   - Used for SEO-critical, deterministic values:
     - `title`
     - `description`
     - Open Graph defaults
   - Always available, including in streaming routes.

3. **Renderer Head (`headContent` in `entry-server.tsx`)**
   - Converts `meta` and (optionally) `data` into actual HTML tags.
   - Can enrich or override route meta.
   - Runs:
     - after data resolution in SSR
     - at shell-ready time in streaming

This separation ensures:

- routing controls _what the page represents_
- rendering controls _how it becomes HTML_
- streaming remains safe for SEO

## The headContent Function

```typescript
// entry-server.tsx
import { createRenderer, escapeHtml } from "@taujs/react";
import { App } from "./App";

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <App location={location} />,
  headContent: ({ data, meta }) => `
    <title>${escapeHtml(meta?.title || "τjs - Composing systems, not just apps")}</title>
    <meta name="description" content="${escapeHtml(
      meta?.description ||
        data?.message ||
        "τjs - Composing systems, not just apps",
    )}">
  `,
});
```

## Data Sources

### data

Result from your route's `attr.data` handler:

```typescript
// Route config
{
  path: '/products/:id',
  attr: {
    render: 'ssr',
    data: async (params) => {
      const product = await db.products.findById(params.id);
      return {
        title: product.name,
        description: product.description,
        image: product.imageUrl
      };
    }
  }
}
```

### meta

From your route's `attr.meta` configuration:

```typescript
// Route config
{
  path: '/about',
  attr: {
    render: 'ssr',
    meta: {
      title: 'About Us',
      description: 'Learn about our company'
    }
  }
}
```

## Data Availability by Mode

### SSR Mode

Data is **always fully resolved** before `headContent` runs:

```typescript
headContent: ({ data, meta }) => `
  <title>${escapeHtml(meta?.title || "Products")}</title>
  <meta name="description" content="${escapeHtml(data.product.description)}">
`;
```

### Streaming Mode

Data may not be ready when `headContent` runs. Use `meta` for reliable SEO:

```typescript
headContent: ({ data, meta }) => {
  // Use meta for guaranteed values
  return `
    <title>${escapeHtml(meta?.title || "Streaming page")}</title>
    <meta name="description" content="${escapeHtml(meta.description)}">
    ${
      data.ogImage
        ? `<meta property="og:image" content="${escapeHtml(data.ogImage)}">`
        : ""
    }
  `;
};
```

> Because `headContent` runs before all data is available in streaming mode,
> SEO-critical values should come from route `meta`, not fetched data.

## Common Patterns

Each interpolated value below is passed through `escapeHtml` at the point it enters the HTML string.

### Open Graph Tags

```typescript
headContent: ({ data, meta }) => {
  const title = data?.title || meta?.title || "Default title";
  const description = data?.description || meta?.description || "";
  const image = data?.ogImage || meta?.ogImage;

  return `
    <title>${escapeHtml(title)}</title>
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ""}
  `;
};
```

### Structured Data (JSON-LD)

JSON-LD is written into `<script>` **raw text**, which is a different context from HTML - HTML
character references are _not_ decoded there, so `escapeHtml` is the wrong tool and would corrupt the
JSON. `JSON.stringify` alone is **not** safe either: a value containing `</script>` closes the element
and lets the rest parse as markup. Escape `<` as the JSON unicode escape so the tag can never be
closed from inside the data:

```typescript
// `<` -> `\u003c` keeps valid JSON but prevents `</script>` breakout.
const jsonForScript = (value: unknown) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

headContent: ({ data, meta }) => {
  const jsonLd = data?.jsonLd || meta?.jsonLd;

  return `
    <title>${escapeHtml(meta?.title || "Page")}</title>
    ${
      jsonLd
        ? `<script type="application/ld+json">${jsonForScript(jsonLd)}</script>`
        : ""
    }
  `;
};
```

If you use CSP with script-src restrictions, inline JSON-LD may require a nonce/hash depending on your policy.

### Canonical URLs

```typescript
headContent: ({ data, meta }) => {
  const canonical = data.canonical || meta.canonical;

  return `
    <title>${escapeHtml(meta.title)}</title>
    ${
      canonical
        ? `<link rel="canonical" href="${escapeHtml(canonical)}">`
        : ""
    }
  `;
};
```

> `escapeHtml` stops a URL from breaking out of the `href` attribute, but it does **not** validate the
> scheme. If the URL is user-influenced, also reject/allow-list schemes (e.g. permit only
> `https:`/`http:`) so you don't emit `javascript:` or `data:` links.

## Best Practices

### 1. Prioritise Meta Over Data in Streaming

```typescript
import { escapeHtml } from "@taujs/react"; // or "@taujs/vue"

// reliable in streaming
headContent: ({ data, meta }) => `
  <title>${escapeHtml(meta?.title || "Default Title")}</title>
  <meta name="description" content="${escapeHtml(
    meta?.description || "Default description",
  )}">
  ${
    data?.ogImage
      ? `<meta property="og:image" content="${escapeHtml(data.ogImage)}">`
      : ""
  }
`;
```

### 2. Provide Fallbacks

```typescript
const title = data.title || meta.title || "Default Title";
```

### 3. Escape User Content

`headContent` returns **raw HTML** written verbatim into `<head>`, so any value that could carry
service data or user input - from **`data` or `meta`** - must be escaped at the point it enters the
string. Escape by output **context**, not by property name:

- **HTML text and quoted attributes** → `escapeHtml` (exported by both renderers; escapes
  `& < > " '`, so it is safe in single- and double-quoted attributes):

  ```typescript
  import { escapeHtml } from "@taujs/react"; // or "@taujs/vue"

  headContent: ({ data }) => `
    <meta property="og:image" content="${escapeHtml(data.ogImage)}">
  `;
  ```

- **`<script>` / JSON-LD data** → not `escapeHtml`; escape `<` as `\u003c` in the serialised JSON
  (see [Structured Data](#structured-data-json-ld)).
- **URL attributes** → `escapeHtml` prevents attribute breakout but does not validate the scheme;
  allow-list schemes separately for user-influenced URLs.

`escapeHtml` accepts any value (`String()`-coerced) and is not idempotent - escape each value exactly
once. If you can't import it, roll your own - but escape `'` too, or single-quoted attributes stay
vulnerable:

```typescript
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

### 4. Use SSR for Data-Dependent Head

If your head content critically depends on fetched data, use `render: 'ssr'`.

<!--
## What's Next?

- [Services](/guides/services) - Learn the service registry pattern
- [Authentication](/guides/authentication) - Access user context
- [Data Loading](/guides/data-loading) - Understand data flow -->
