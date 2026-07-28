---
title: <head> Management
description: Build document head content from route metadata, critical data and dedicated head loaders
---

Each renderer accepts a `headContent` callback in its server entry. The callback returns the
request-specific HTML that τjs places inside the document `<head>`.

Route `meta` does not emit tags by itself. It is one input to `headContent`, alongside critical
`data`, dedicated `headData` and `routeContext`.

::::caution[headContent is a raw-HTML sink]
The returned string is written into `<head>` verbatim. It is not escaped or sanitised. Escape every
untrusted value at the point where it enters the HTML string, using the correct escaping rule for
that output context.
::::

## How the pieces fit

A rendered document combines three sources:

1. `index.html` supplies the static structure and tags shared by the application.
2. `headContent` produces request-specific tags from the route inputs.
3. τjs adds any build, development and renderer tags required for the response.

The route inputs available to `headContent` are:

| Input          | Source                                  | Use                                                        |
| -------------- | --------------------------------------- | ---------------------------------------------------------- |
| `meta`         | `attr.meta`                             | Static route metadata and fallback values                  |
| `data`         | `attr.data`                             | Critical route data, subject to renderer timing below      |
| `headData`     | `attr.head.data`                        | Dynamic data resolved before the renderer starts           |
| `routeContext` | `{ appId, path, attr, params }`         | Route-aware values outside the data snapshot               |

If two sources produce the same tag, `headContent` decides which value wins. τjs does not merge or
deduplicate application-provided titles, metadata or links.

## Define headContent

This React example has the same shape in Vue and Solid. Import `createRenderer` and `escapeHtml`
from `@taujs/vue` or `@taujs/solid` for those renderers.

```tsx
import { createRenderer, escapeHtml } from "@taujs/react";
import { App } from "./App";

export const { renderSSR, renderStream } = createRenderer({
  appComponent: ({ location }) => <App location={location} />,
  headContent: ({ headData, meta }) => {
    const title = headData?.title ?? meta?.title ?? "My application";
    const description =
      headData?.description ?? meta?.description ?? "Application description";

    return `
      <title>${escapeHtml(title)}</title>
      <meta name="description" content="${escapeHtml(description)}">
    `;
  },
});
```

`escapeHtml` is exported by all three renderer packages. It is suitable for HTML text and quoted
attribute values. It does not validate URL schemes and it is not the right encoding for script
contents.

## Choose the right data source

Use the narrowest declaration that satisfies the response:

| Requirement                                           | Put it in                                      |
| ----------------------------------------------------- | ---------------------------------------------- |
| Fixed for the route                                   | `attr.meta`                                    |
| Critical body data                                | `attr.data`                                    |
| Dynamic value required in a streamed document head    | `attr.head.data`                               |
| Content allowed to arrive behind a streamed boundary  | `attr.deferred`                                |
| A change after client-only navigation                 | The client application or router head handling |

Deferred values are never passed to `headContent`. Work that can cause a redirect or determine
response status belongs in critical resolution. A value that must appear in the initial document
head belongs in `meta`, `data` or `headData`, not `attr.deferred`.

## Data availability by rendering strategy

### SSR

On `render: "ssr"`, all three renderers receive fully resolved critical `data`. A declared
`attr.head` loader runs after critical data resolution and before the renderer starts.

```ts
headContent: ({ data, meta }) => `
  <title>${escapeHtml(data.title ?? meta?.title ?? "Product")}</title>
`;
```

### Streaming

The availability of critical `data` reflects native renderer behaviour:

- **React** builds the head at shell readiness from the current snapshot, which may be empty.
- **Vue** builds the head once before rendering from the current snapshot, which may be empty.
- **Solid** builds the head after critical route data has settled.

The portable rule is therefore: use `meta` for static values and `attr.head` for dynamic values
that must be present in a streamed document head. This keeps the declaration correct if an
application changes renderer and makes the head dependency explicit in the request contract.

Independent shell content is not delayed by deferred data. Head work is different: `attr.head`
resolves before the renderer starts, so it delays the shell by design.

## Dedicated dynamic head data

`attr.head.data` uses the same handler and service-dispatch contract as `attr.data`. The result is
passed to `headContent` as `headData` on both rendering strategies.

```ts
{
  path: "/products/:id",
  attr: {
    render: "streaming",
    meta: {
      title: "Products",
      description: "Product details",
    },
    data: (params, ctx) =>
      ctx.call("catalogue", "getProduct", { id: params.id }),
    head: {
      data: (params, ctx) =>
        ctx.call("catalogue", "getProductHead", { id: params.id }),
      timeoutMs: 3_000,
      optional: false,
    },
  },
}
```

```ts
headContent: ({ headData, meta }) => `
  <title>${escapeHtml(headData?.title ?? meta?.title ?? "Product")}</title>
  <meta
    name="description"
    content="${escapeHtml(headData?.description ?? meta?.description ?? "")}">
`;
```

The host applies these rules:

- `timeoutMs` defaults to 3,000 ms and must be a positive finite number.
- A live-request timeout aborts the head loader where possible, logs an advisory and continues with
  `headData: undefined`.
- An ordinary loader rejection fails the request unless `optional: true` is declared.
- `optional: true` reclassifies an ordinary rejection as degradation and continues with
  `headData: undefined`.
- A client disconnect aborts the work and the renderer does not start.
- `headData` is never included in `__INITIAL_DATA__`; it exists only for server head generation.

| Outcome                                    | Response behaviour                                      |
| ------------------------------------------ | ------------------------------------------------------- |
| Resolved                                   | `headData` contains the result                          |
| Deadline while request remains live        | Advisory log, then `headData: undefined`                |
| Rejection, `optional` omitted or `false`    | Request fails through the normal error path             |
| Rejection, `optional: true`                 | Advisory log, then `headData: undefined`                |
| Client disconnect                          | Request work is aborted and rendering does not continue |

Always handle `headData` as optional and keep the loader small. It is intentionally on the
pre-shell path.

## Client-routed screens

`headContent` runs for a server-rendered τjs route. It is not a client-side head manager.

A screen known only to the client router can be CSR by omission, but navigation to that screen does
not rerun `headContent`. Update `document.title` and any route-specific metadata through the client
application or router. On a direct document request, the server-selected shell still determines the
initial head. See [Request Contracts & Data](/guides/request-contracts/#undeclared-urls-and-client-routing)
for the shell ownership rules.

## Escape by output context

### HTML text and quoted attributes

Use `escapeHtml` for title text and quoted attribute values:

```ts
import { escapeHtml } from "@taujs/react"; // or @taujs/vue, @taujs/solid

headContent: ({ headData, meta }) => {
  const title = headData?.title ?? meta?.title ?? "Default title";
  const image = headData?.image ?? meta?.image;

  return `
    <title>${escapeHtml(title)}</title>
    ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ""}
  `;
};
```

`escapeHtml` prevents an untrusted URL from escaping an attribute. It does not make the URL safe.
For user-influenced canonical or image URLs, parse the value and allow only the schemes and origins
the application expects.

### JSON-LD and other script data

HTML escaping corrupts JSON inside a script raw-text element. Serialise the value as JSON and
escape `<` so an embedded `</script>` cannot terminate the element:

```ts
const jsonForScript = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("JSON-LD value is not serialisable");
  return json.replace(/</g, "\\u003c");
};

headContent: ({ headData }) =>
  headData?.jsonLd
    ? `<script type="application/ld+json">${jsonForScript(headData.jsonLd)}</script>`
    : "";
```

`headContent` does not receive the request CSP nonce, and τjs does not rewrite application-provided
head scripts to add one. τjs nonces the scripts it emits itself. If the application CSP requires an
inline head script to be authorised, account for it explicitly with a policy-supported hash or a
different delivery strategy.

## Practical rules

- Use `meta` as static input, not as an automatic tag generator.
- Use `attr.head` for dynamic streamed-head dependencies.
- Treat `headData` as optional and provide a static fallback.
- Keep status-bearing, redirect-bearing and head-critical values out of `attr.deferred`.
- Escape every dynamic value according to its output context.
- Keep head loaders fast because they delay the shell.
- Manage head changes after client-only navigation in the client application.
