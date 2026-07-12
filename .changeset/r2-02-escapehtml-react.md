---
'@taujs/react': minor
---

R2-02: export `escapeHtml` and document the `headContent` raw-HTML contract.

- **New export `escapeHtml(value)`** (from the package root) — escapes the five HTML-sensitive
  characters (`& < > " '` → `&amp; &lt; &gt; &quot; &#39;`), so it is safe for both element text AND
  attribute values (single- and double-quoted). Non-string input is coerced via `String(value)`.
  Ships the helper the head-management guide previously told users to hand-roll (and whose hand-rolled
  version missed `'`).
- **`headContent` contract JSDoc** on the `createRenderer` option and `HeadContext`: the return value
  is written into `<head>` as RAW HTML and is intentionally NOT auto-escaped, so any value
  interpolated from services/user input must be escaped with `escapeHtml`.

No render-path behaviour change. `minor` for the additive export.
