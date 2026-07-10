---
title: <head> Management
description: How τjs manages document head content
---

τjs provides flexible document `<head>` management through a `headContent` function defined in your `entry-server.tsx`.

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
import { createRenderer } from "@taujs/react";
import { App } from "./App";

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <App location={location} />,
  headContent: ({ data, meta }) => `
    <title>${meta?.title || "τjs - Composing systems, not just apps"}</title>
    <meta name="description" content="${
      meta?.description ||
      data?.message ||
      "τjs - Composing systems, not just apps"
    }">
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
  <title>${meta?.title || "Products"}</title>
  <meta name="description" content="${data.product.description}">
`;
```

### Streaming Mode

Data may not be ready when `headContent` runs. Use `meta` for reliable SEO:

```typescript
headContent: ({ data, meta }) => {
  // Use meta for guaranteed values
  return `
    <title>${meta?.title || "Streaming page"}</title>
    <meta name="description" content="${meta.description}">
    ${
      data.ogImage ? `<meta property="og:image" content="${data.ogImage}">` : ""
    }
  `;
};
```

> Because `headContent` runs before all data is available in streaming mode,
> SEO-critical values should come from route `meta`, not fetched data.

## Common Patterns

### Open Graph Tags

```typescript
headContent: ({ data, meta }) => {
  const title = data?.title || meta?.title || "Default title";
  const description = data?.description || meta?.description || "";
  const image = data?.ogImage || meta?.ogImage;

  return `
    <title>${title}</title>
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    ${image ? `<meta property="og:image" content="${image}">` : ""}
  `;
};
```

### Structured Data (JSON-LD)

```typescript
headContent: ({ data, meta }) => {
  const jsonLd = data?.jsonLd || meta?.jsonLd;

  return `
    <title>${meta?.title || "Page"}</title>
    ${
      jsonLd
        ? `<script type="application/ld+json">${JSON.stringify(
            jsonLd
          )}</script>`
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
    <title>${meta.title}</title>
    ${canonical ? `<link rel="canonical" href="${canonical}">` : ""}
  `;
};
```

## Best Practices

### 1. Prioritise Meta Over Data in Streaming

```typescript
// reliable in streaming
headContent: ({ data, meta }) => `
  <title>${meta?.title || "Default Title"}</title>
  <meta name="description" content="${
    meta?.description || "Default description"
  }">
  ${data?.ogImage ? `<meta property="og:image" content="${data.ogImage}">` : ""}
`;
```

### 2. Provide Fallbacks

```typescript
const title = data.title || meta.title || "Default Title";
```

### 3. Escape User Content

```typescript
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

### 4. Use SSR for Data-Dependent Head

If your head content critically depends on fetched data, use `render: 'ssr'`.

<!--
## What's Next?

- [Services](/guides/services) - Learn the service registry pattern
- [Authentication](/guides/authentication) - Access user context
- [Data Loading](/guides/data-loading) - Understand data flow -->
