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
 * `__proto__` note (RFC SEC4): the inline script is emitted as a JS OBJECT LITERAL
 * (`window.__INITIAL_DATA__ = { ... }`), and a quoted `"__proto__":` key in an object literal
 * SETS THE CREATED OBJECT'S PROTOTYPE (ES Annex B.3.1), it does not add an own property. So a
 * `__proto__` DATA key lands on the initial-data object's prototype (reachable via the prototype
 * chain, with no own `__proto__` property) — it does NOT pollute the global `Object.prototype`,
 * but its shape differs between server (own key) and client (prototype). Removing that drift
 * (recursively rejecting `__proto__`, or emitting via `JSON.parse("…")`) is a data-contract
 * change, deferred with the nested-value handling above. Behaviour is unchanged from before R0-04.
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
