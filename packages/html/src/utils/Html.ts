/**
 * Copied from `packages/vue/src/utils/Html.ts` at `73f2867`, for `@taujs/html`'s OWN attribute
 * writing (the streaming bootstrap tag). Module-local and NOT exported: `@taujs/html` provides no
 * templating or escaping helper to applications - the app owns its HTML safety.
 *
 * Escape a value for safe interpolation into RAW HTML - both element text and attribute values,
 * single- AND double-quoted. Escapes the five HTML-sensitive characters:
 *
 * - `&` -> `&amp;`
 * - `<` -> `&lt;`
 * - `>` -> `&gt;`
 * - `"` -> `&quot;`
 * - `'` -> `&#39;`
 *
 * SCOPE - this makes a value safe ONLY for HTML text and QUOTED HTML attributes. It does NOT make a
 * value safe for other contexts: JavaScript, `<script>` JSON / JSON-LD data, CSS, or URL scheme
 * validation.
 *
 * `&` is replaced FIRST so a freshly produced entity (e.g. `&lt;`) is not corrupted. This function is
 * therefore NOT idempotent - escape each value exactly once; do not double-escape. Input is `unknown`
 * and coerced with `String(value)`, so non-string values are supported.
 */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
