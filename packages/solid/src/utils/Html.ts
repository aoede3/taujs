/**
 * Escape a value for safe interpolation into RAW HTML — both element text and attribute values,
 * single- AND double-quoted. Escapes the five HTML-sensitive characters:
 *
 * - `&` → `&amp;`
 * - `<` → `&lt;`
 * - `>` → `&gt;`
 * - `"` → `&quot;`
 * - `'` → `&#39;`
 *
 * SCOPE — this makes a value safe ONLY for HTML text and QUOTED HTML attributes. It does NOT make a
 * value safe for other contexts: JavaScript, `<script>` JSON / JSON-LD data (character references are
 * NOT decoded in script raw text — there you must escape `<` as the JSON escape `\u003c`), CSS, or URL
 * scheme validation. For URL-bearing attributes it prevents attribute breakout but does not validate the
 * scheme or authorize the destination — construct or allow-list URLs separately.
 *
 * Intended for `headContent` interpolations (see `HeadContext`): a renderer's `headContent` return
 * value is written into `<head>` as RAW HTML, so any value drawn from services or user input must be
 * escaped before interpolation. The framework-rendered application HTML does NOT need this — React and
 * Vue escape it for you.
 *
 * `&` is replaced FIRST so a freshly produced entity (e.g. `&lt;`) is not corrupted. This function is
 * therefore NOT idempotent — escape each value exactly once; do not double-escape. Input is `unknown`
 * and coerced with `String(value)`, so non-string values are supported.
 */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
