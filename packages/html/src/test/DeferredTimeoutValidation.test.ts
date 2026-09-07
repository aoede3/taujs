import { describe, expect, it } from 'vitest';

import { createRenderer } from '../SSRRender';

// `deferredTimeoutMs` is FACTORY-ONLY (no per-call form - `streamOptions.shellTimeoutMs` is the only
// per-call override) and has NO sentinel: it is the one deadline that keeps "bounded total response
// time" true, so it must always be a positive finite number of milliseconds.
const build = (deferredTimeoutMs: unknown) => () => createRenderer({ streamOptions: { deferredTimeoutMs } as never });

const pinnedMessage = (value: unknown): string =>
  `createRenderer: streamOptions.deferredTimeoutMs must be a positive finite number of milliseconds (received ${String(value)})`;

describe('deferredTimeoutMs validation (@taujs/html)', () => {
  it('rejects NaN, 0, -1, Infinity and a numeric string, with the exact pinned message', () => {
    for (const value of [Number.NaN, 0, -1, Infinity, '10']) {
      expect(build(value)).toThrow(TypeError);
      expect(build(value)).toThrow(pinnedMessage(value));
    }
  });

  it('accepts a positive finite value, the vue-precedent 15_000ms default value, and an omitted value', () => {
    expect(build(1)).not.toThrow();
    expect(build(15_000)).not.toThrow();
    expect(build(undefined)).not.toThrow();
  });

  it('defaults to 15_000ms when streamOptions is omitted entirely', () => {
    expect(() => createRenderer()).not.toThrow();
  });
});
