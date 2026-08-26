/**
 * Conformance vector: `streamOptions.shellTimeoutMs`.
 *
 * The contract every renderer must hold identically:
 *
 * 1. The factory REJECTS anything that is neither a documented sentinel nor a positive number of
 *    milliseconds within Node's usable timer range, with a `TypeError` naming the option - and
 *    with the SAME message text in every renderer.
 * 2. The factory ACCEPTS the sentinels `0` and `Infinity`, an omitted value, and any ordinary
 *    finite timeout up to `MAX_NATIVE_TIMEOUT`.
 * 3. The timer is NOT ARMED for a sentinel.
 *
 * Why there is an UPPER BOUND, which the first version of this vector wrongly omitted: Node stores
 * a delay as a 32-bit signed integer, so anything above 2_147_483_647 is clamped to 1ms and warned
 * about, exactly like `Infinity`. Measured on Node 22.19.0:
 *
 *   2_147_483_647      -> honoured (24.8 days)
 *   2_147_483_648      -> 1ms + TimeoutOverflowWarning
 *   MAX_SAFE_INTEGER   -> 1ms + TimeoutOverflowWarning
 *   NaN                -> 1ms, no warning
 *
 * A vector that blessed "any positive finite number" would therefore have declared a value correct
 * while the renderer demonstrably reproduced the defect the vector exists to prevent.
 *
 * Note also that a non-number does NOT simply clamp: `'10'` is coerced to a ten-millisecond delay,
 * not to 1ms. It is still rejected, because the option's contract is a number - but the runtime
 * symptom differs, and an earlier version of this comment overstated it.
 *
 * ZERO IMPORTS, deliberately - see this directory's README. Everything returns a result for the
 * calling suite to assert on, so the vector couples to no test framework.
 */

/** The largest delay Node stores without clamping: 2^31 - 1 milliseconds, about 24.8 days. */
export const MAX_NATIVE_TIMEOUT = 2_147_483_647;

/** Values every renderer's factory must reject. `undefined` is NOT here: it selects the default. */
export const INVALID_SHELL_TIMEOUTS: readonly unknown[] = [
  Number.NaN,
  -1,
  -Infinity,
  '10',
  null,
  {},
  // Above Node's 32-bit range: clamped to 1ms with a TimeoutOverflowWarning, exactly like Infinity
  // but without looking like a sentinel.
  MAX_NATIVE_TIMEOUT + 1,
  Number.MAX_SAFE_INTEGER,
];

/** Documented sentinels every renderer's factory must accept, both meaning "no bound". */
export const SENTINEL_SHELL_TIMEOUTS: readonly number[] = [0, Infinity];

/**
 * Ordinary values every renderer's factory must ACCEPT. Without these a renderer could reject every
 * finite timeout and still pass most of this file.
 */
export const VALID_FINITE_SHELL_TIMEOUTS: readonly number[] = [1, 10_000, MAX_NATIVE_TIMEOUT];

export type FactoryProbe = (shellTimeoutMs: unknown) => void;

export type RejectionReport = {
  value: string;
  threw: boolean;
  isTypeError: boolean;
  namesOption: boolean;
  message: string;
};

/**
 * Describe a value the way an error message should: strings are QUOTED, everything else is
 * `String()`.
 *
 * The quoting is load-bearing rather than cosmetic. `String('10')` and `String(10)` are the same
 * two characters, so an unquoted message reports the string case as though a number had been
 * passed - and the string case is the one whose runtime symptom differs, because it COERCES to a
 * ten-millisecond delay rather than clamping. Since this vector pins the exact message text, an
 * indistinguishable rendering would be conformance-checked into the contract.
 */
export const describeValue = (value: unknown): string => (typeof value === 'string' ? `'${value}'` : String(value));

/**
 * The EXACT message a conforming renderer produces. Pinning the text, not merely the type, is what
 * makes "all three behave identically" a checked claim rather than an aspiration: a renderer whose
 * message omits the range, or names the option differently, is telling its caller something else.
 */
export const expectedRejectionMessage = (name: string, value: unknown, site = 'createRenderer'): string =>
  `${site}: ${name} must be 0, Infinity, or a positive number of milliseconds no greater than ${MAX_NATIVE_TIMEOUT} (received ${describeValue(value)})`;

/**
 * Invoke `probe` with `value` and report HOW it failed, rather than merely whether it did. A
 * renderer that throws the wrong error type, or one whose message does not name the option, is
 * still failing the contract: the point of rejecting is to tell the caller what to fix.
 */
export const probeRejection = (probe: FactoryProbe, value: unknown, optionName = 'shellTimeoutMs'): RejectionReport => {
  try {
    probe(value);

    return { value: describeValue(value), threw: false, isTypeError: false, namesOption: false, message: '' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return {
      value: describeValue(value),
      threw: true,
      isTypeError: err instanceof TypeError,
      namesOption: message.includes(optionName),
      message,
    };
  }
};

/** The shape a conforming rejection produces, for a single `toMatchObject`-style assertion. */
export const CONFORMING_REJECTION = { threw: true, isTypeError: true, namesOption: true } as const;

export type AcceptanceReport = { value: string; threw: boolean; message: string };

export const probeAcceptance = (probe: FactoryProbe, value: unknown): AcceptanceReport => {
  try {
    probe(value);

    return { value: describeValue(value), threw: false, message: '' };
  } catch (err) {
    return { value: describeValue(value), threw: true, message: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Collect Node process warnings raised while `run` executes.
 *
 * A `TimeoutOverflowWarning` here proves a value reached `setTimeout` and was clamped to 1ms - the
 * exact defect this vector exists to catch, and one that is otherwise invisible because the
 * resulting failure looks like an ordinary timeout.
 *
 * This is a runtime PROBE rather than a pure function, and deliberately so: the warning channel is
 * the only place the clamp is observable. It still imports nothing.
 */
export const collectProcessWarnings = async (run: () => Promise<void> | void): Promise<string[]> => {
  const warnings: string[] = [];
  const onWarning = (w: Error) => {
    warnings.push(`${w.name}: ${w.message}`);
  };

  process.on('warning', onWarning);
  try {
    await run();
    // Node emits process warnings on the next turn, so give them one before unhooking.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('warning', onWarning);
  }

  return warnings;
};

export const TIMEOUT_OVERFLOW = 'TimeoutOverflowWarning';
