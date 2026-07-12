/**
 * Escape a string for safe interpolation into RAW HTML — both element text and attribute values,
 * single- AND double-quoted. Escapes the five HTML-sensitive characters:
 *
 * - `&` → `&amp;`
 * - `<` → `&lt;`
 * - `>` → `&gt;`
 * - `"` → `&quot;`
 * - `'` → `&#39;`
 *
 * Intended for `headContent` interpolations (see `HeadContext`): a renderer's `headContent` return
 * value is written into `<head>` as RAW HTML, so any value drawn from services or user input must be
 * escaped before interpolation. The framework-rendered application HTML does NOT need this — React and
 * Vue escape it for you.
 *
 * `&` is replaced FIRST so a freshly produced entity (e.g. `&lt;`) is not corrupted. This function is
 * therefore NOT idempotent — escape each value exactly once; do not double-escape. Non-string input is
 * coerced with `String(value)`.
 */
export function escapeHtml(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
