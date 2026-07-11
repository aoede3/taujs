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
 * The single server-owned serialization boundary for BOTH render modes. Route data is the JSON
 * contract (`Record<string, unknown>`), but the service layer only validates that the result
 * ROOT is a plain object — never recursively — so circular references, `BigInt`, a throwing
 * `toJSON`, functions, or an `undefined` result all reach here. Any of these fails
 * DETERMINISTICALLY (returns `{ ok: false }`) and this function NEVER throws, so the caller can
 * terminate the response instead of crashing the process.
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
 * `__proto__` fidelity (RFC SEC4): an object-literal `"__proto__"` key serializes as an ordinary
 * JSON string key and, on the client, re-parses as an OWN property of the initial-data object
 * (not a prototype mutation); it cannot pollute `Object.prototype`. Behaviour is unchanged.
 */
export const serializeInlineData = (value: unknown): SerializedInlineData => {
  try {
    const json = JSON.stringify(value);
    // `JSON.stringify` returns `undefined` for `undefined`, functions, and symbols — not a
    // representable value for inline injection.
    if (json === undefined) {
      return { ok: false, error: new Error('Value is not JSON-serializable (JSON.stringify returned undefined)') };
    }

    return { ok: true, js: json.replace(/</g, '\\u003c') };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
};
