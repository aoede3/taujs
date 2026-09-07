import { describe, expect, it } from 'vitest';

import { createRenderer } from '../SSRRender';
import { startShellTimer } from '../utils/Streaming';
import {
  CONFORMING_REJECTION,
  INVALID_SHELL_TIMEOUTS,
  MAX_NATIVE_TIMEOUT,
  SENTINEL_SHELL_TIMEOUTS,
  TIMEOUT_OVERFLOW,
  VALID_FINITE_SHELL_TIMEOUTS,
  collectProcessWarnings,
  expectedRejectionMessage,
  probeAcceptance,
  probeRejection,
} from '../../../renderer-conformance/shellTimeout';

// Shared conformance vector, run in THIS renderer's own environment rather than through a common
// runner - see packages/renderer-conformance/README.md. The renderers are pattern-parity by ruling,
// so a vector is the only thing that can hold an invariant across them.
const build = (shellTimeoutMs: unknown) => createRenderer({ streamOptions: { shellTimeoutMs } as never });

describe('shellTimeoutMs conformance (@taujs/html)', () => {
  it('rejects every invalid value at the factory, with the exact shared message', () => {
    for (const value of INVALID_SHELL_TIMEOUTS) {
      const report = probeRejection(build, value);

      expect(report).toMatchObject(CONFORMING_REJECTION);
      expect(report.message).toBe(expectedRejectionMessage('streamOptions.shellTimeoutMs', value));
    }
  });

  it('accepts the sentinels, an omitted value, and ordinary finite timeouts', () => {
    for (const value of [...SENTINEL_SHELL_TIMEOUTS, ...VALID_FINITE_SHELL_TIMEOUTS, undefined]) {
      expect(probeAcceptance(build, value)).toMatchObject({ threw: false });
    }
  });

  it("reports a string value QUOTED, so '10' is not indistinguishable from 10", () => {
    expect(probeRejection(build, '10').message).toContain("(received '10')");
  });

  it('draws the upper bound exactly at Node 32-bit range', () => {
    expect(probeAcceptance(build, MAX_NATIVE_TIMEOUT)).toMatchObject({ threw: false });
    expect(probeRejection(build, MAX_NATIVE_TIMEOUT + 1)).toMatchObject(CONFORMING_REJECTION);
  });

  it('does not arm a timer for a sentinel: no callback, and no TimeoutOverflowWarning', async () => {
    const fired: number[] = [];

    const warnings = await collectProcessWarnings(async () => {
      for (const value of SENTINEL_SHELL_TIMEOUTS) startShellTimer(value, () => fired.push(value));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(fired).toEqual([]);
    expect(warnings.filter((w) => w.includes(TIMEOUT_OVERFLOW))).toEqual([]);
  });

  it('still arms for a finite value', async () => {
    const fired: string[] = [];
    startShellTimer(1, () => fired.push('fired'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fired).toEqual(['fired']);
  });
});
