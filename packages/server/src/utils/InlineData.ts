export type SerializedInlineData = { ok: true; js: string } | { ok: false; error: Error };

// Coerce any thrown value to an Error without ever throwing — a hostile non-Error (e.g. an
// object with a throwing `toString`/`Symbol.toPrimitive` thrown from a `toJSON`) must not defeat
// the "never throws" guarantee below.
const toError = (err: unknown): Error => {
  if (err instanceof Error) return err;
  try {
    return new Error(String(err));
  } catch {
    return new Error('Value is not JSON-serializable (its thrown error could not be coerced to a string)');
  }
};

/**
 * Serialize route data for inline injection into `window.__INITIAL_DATA__`, SAFELY (R0-04).
 *
 * The single server-owned serialization boundary for BOTH render modes. Route data is nominally
 * the JSON contract (`Record<string, unknown>`), but the service layer only validates that the
 * result ROOT is a plain object — never recursively. This function's guarantee is CRASH-SAFETY,
 * not full contract enforcement:
 *   - Values that make `JSON.stringify` THROW — circular references, `BigInt`, a throwing
 *     `toJSON`/`valueOf` — ANYWHERE in the tree fail deterministically (`{ ok: false }`).
 *   - A value whose top-level `JSON.stringify` result is `undefined` (the value itself is
 *     `undefined`, a function, or a symbol) fails deterministically.
 *   - NESTED `undefined`/functions/symbols follow STANDARD JSON semantics — omitted from objects,
 *     `null` in arrays — and are NOT rejected (this matches `JSON.stringify`). Enforcing the full
 *     JSON contract for nested values (recursive validation with a path) is deferred to a future
 *     data-contract task (R3-03 / RFC-0004); R0-04 only removes the process-crash class.
 * This function NEVER throws, so the caller can terminate the response instead of crashing.
 *
 * Why "never throws" matters: the streaming `finish` listener runs on a stream tick, OUTSIDE the
 * request `try/catch`, so an uncaught throw there becomes an `uncaughtException` → process exit
 * (the second crash class; the first was R0-01's unobserved `done` rejection).
 *
 * Security: every `<` is replaced by its JS unicode escape so `</script>` and `<!--` cannot
 * break out of the inline script (RFC §4). Output is BYTE-IDENTICAL to the previous inline
 * `JSON.stringify(v).replace(/</g, '\\u003c')` for every valid input (existing tests and cached
 * pages must not observe a diff). U+2028/U+2029 are legal in ES2019+ string literals and pass
 * through unescaped.
 *
 * `__proto__` (ESC-3, RFC SEC4): FIXED. Previously the payload was ALWAYS emitted as a JS OBJECT
 * LITERAL (`window.__INITIAL_DATA__ = { ... }`), where a quoted `"__proto__":` key SETS THE
 * CREATED OBJECT'S PROTOTYPE (ES Annex B.3.1) instead of adding an own property. That never
 * polluted the global `Object.prototype`, but the client value's SHAPE differed from the server's
 * (own key on the server, prototype on the client) — semantic drift in the shared serializer,
 * found by S0-C2 and ruled a FIX (not a rejection) by the ESC-0 ruling.
 *
 * The fix is REPRESENTATIONAL, not a data-contract change: when (and only when) the payload
 * contains `__proto__` anywhere, the value is emitted as `JSON.parse("…")`. `JSON.parse` uses
 * CreateDataProperty, so `__proto__` round-trips as an ORDINARY OWN DATA PROPERTY at every depth,
 * the object's prototype stays `Object.prototype`, and the global prototype is untouched. Every
 * other payload keeps the object-literal form and is BYTE-IDENTICAL to before, so ordinary
 * responses and cached pages observe no diff.
 *
 * The trigger is a substring test for the QUOTED token `"__proto__"` in the JSON text. Because the
 * token includes both quotes, it matches exactly two things:
 *   - a property KEY named `__proto__` (at any depth) — the case that must be fixed; and
 *   - a string VALUE exactly equal to `__proto__` — a harmless false positive.
 * It does NOT match a string that merely mentions `__proto__` among other text (`"the __proto__
 * key"` has no quote adjacent to the token), and it does not need to: such a value is an ordinary
 * string and the object-literal form already round-trips it correctly.
 *
 * So the trigger is narrow, not "conservative over-matching": its only false positive is the exact
 * string `"__proto__"`. That is deliberate and safe, because both emission forms are semantically
 * identical for every input — over-triggering costs a few bytes, under-triggering would reintroduce
 * the drift. A substring test is also far more auditable than parsing the JSON to tell keys from
 * values. Breakout safety is unchanged: `<` is escaped in both forms, and inside the `JSON.parse`
 * string literal `<` is an ordinary escape that yields `<` after parsing.
 */
const PROTO_KEY_MARKER = '"__proto__"';

export const serializeInlineData = (value: unknown): SerializedInlineData => {
  try {
    const json = JSON.stringify(value);
    // `JSON.stringify` returns `undefined` for `undefined`, functions, and symbols — not a
    // representable value for inline injection.
    if (json === undefined) {
      return { ok: false, error: new Error('Value is not JSON-serializable (JSON.stringify returned undefined)') };
    }

    // ESC-3: a `__proto__` KEY at any depth (or the exact string value `"__proto__"`) — emit via
    // `JSON.parse` so it round-trips as an own data property instead of setting the created
    // object's prototype.
    if (json.includes(PROTO_KEY_MARKER)) {
      return { ok: true, js: `JSON.parse(${JSON.stringify(json).replace(/</g, '\\u003c')})` };
    }

    return { ok: true, js: json.replace(/</g, '\\u003c') };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
};
