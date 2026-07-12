---
'@taujs/vue': minor
---

R2-02: export `escapeHtml` and document the `headContent` raw-HTML contract.

- **New export `escapeHtml(value)`** (from the package root) — escapes the five HTML-sensitive
  characters (`& < > " '` → `&amp; &lt; &gt; &quot; &#39;`), text- AND attribute-safe (single- and
  double-quoted). Non-string input is coerced via `String(value)`. Byte-identical to `@taujs/react`'s
  helper (enforced by the utils drift guard).
- **`headContent` contract JSDoc** on the `createRenderer` option and `HeadContext`: the return value
  is written into `<head>` as RAW HTML and is intentionally NOT auto-escaped, so any value
  interpolated from services/user input must be escaped with `escapeHtml`.

No render-path behaviour change. `minor` for the additive export.
