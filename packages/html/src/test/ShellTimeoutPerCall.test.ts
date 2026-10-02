import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createRenderer } from '../SSRRender';
import {
  CONFORMING_REJECTION,
  INVALID_SHELL_TIMEOUTS,
  OVERRIDE_PRECEDENCE,
  PER_CALL_SITE,
  SENTINEL_SHELL_TIMEOUTS,
  VALID_FINITE_SHELL_TIMEOUTS,
  expectedRejectionMessage,
  probeAcceptance,
  probeRejection,
} from '../../../renderer-conformance/shellTimeout';

// The shared per-call vector (packages/renderer-conformance/shellTimeout.ts, rules 4-6), run in THIS
// renderer's own environment (node). The setTimeout spy lives here, never in the vector: the
// armed delay is what every renderer can be observed to use, whatever its stream machinery.
const build = (shellTimeoutMs?: unknown) => createRenderer({ streamOptions: { shellTimeoutMs } as never });

const call = (shellTimeoutMs: unknown, override: unknown) =>
  build(shellTimeoutMs).renderStream(new PassThrough(), { onHead: () => {} }, {}, '/product/42', undefined, {}, undefined, {
    shellTimeoutMs: override,
  } as never);

const callWith = (override: unknown) => () => call(undefined, override);

// Run one complete render with the given factory and per-call values and return every delay
// `setTimeout` was armed with. The shell timer is armed before the stream can finish, so awaiting
// `done` is the terminal condition: nothing is recorded after it that this could have missed.
const armedDelays = async (factory: unknown, override: unknown): Promise<unknown[]> => {
  const spy = vi.spyOn(globalThis, 'setTimeout');

  try {
    const handle = call(factory, override);

    await handle.done;

    return spy.mock.calls.map(([, delay]) => delay);
  } finally {
    spy.mockRestore();
  }
};

describe('per-call shellTimeoutMs override (@taujs/html)', () => {
  it('rejects every invalid override at the renderStream boundary, with the exact shared message', () => {
    for (const value of INVALID_SHELL_TIMEOUTS) {
      const report = probeRejection(callWith(value), value);

      expect(report).toMatchObject(CONFORMING_REJECTION);
      expect(report.message).toBe(expectedRejectionMessage('streamOptions.shellTimeoutMs', value, PER_CALL_SITE));
    }
  });

  it('throws on an invalid override before any timer is armed', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');

    try {
      for (const value of INVALID_SHELL_TIMEOUTS) {
        spy.mockClear();

        expect(callWith(value)).toThrow(TypeError);
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts the sentinels, ordinary finite values and an omitted override', async () => {
    const handles: { abort(): void; done: Promise<void> }[] = [];

    for (const value of [...SENTINEL_SHELL_TIMEOUTS, ...VALID_FINITE_SHELL_TIMEOUTS, undefined]) {
      expect(probeAcceptance(() => handles.push(call(undefined, value)), value)).toMatchObject({ threw: false });
    }

    // Let every stream reach its own end, so no timer outlives the cell. A finite value as small as
    // 1ms may legitimately expire the shell timer, so only settling matters here, not the outcome.
    await Promise.allSettled(handles.map((h) => h.done));
  });

  it('arms the shell timer with the override, not the factory value', async () => {
    const delays = await armedDelays(OVERRIDE_PRECEDENCE.factory, OVERRIDE_PRECEDENCE.override);

    expect(delays).toContain(OVERRIDE_PRECEDENCE.override);
    expect(delays).not.toContain(OVERRIDE_PRECEDENCE.factory);
  });

  it('arms no shell timer for a per-call sentinel, even when the factory value is finite', async () => {
    for (const sentinel of SENTINEL_SHELL_TIMEOUTS) {
      const delays = await armedDelays(OVERRIDE_PRECEDENCE.factory, sentinel);

      expect(delays).not.toContain(OVERRIDE_PRECEDENCE.factory);
      // Identical to the same sentinel set at the factory: nothing was armed for the shell.
      expect(delays).toEqual(await armedDelays(sentinel, undefined));
    }
  });
});
