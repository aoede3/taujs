import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createRenderer } from '../SSRRender';
import { INVALID_SHELL_TIMEOUTS, expectedRejectionMessage } from '../../../renderer-conformance/shellTimeout';

// PACKAGE-LOCAL, not part of the shared vector - see the equivalent vue test's own note: whether a
// per-call shellTimeoutMs override should exist at all is a separate, still-open shape question.
const renderer = () => createRenderer();

const callWith = (shellTimeoutMs: unknown) => () =>
  renderer().renderStream(new PassThrough(), { onHead: () => {} }, {}, '/product/42', undefined, {}, undefined, { shellTimeoutMs } as never);

describe('per-call shellTimeoutMs override (@taujs/html)', () => {
  it('rejects an invalid override at the renderStream boundary, naming that site', () => {
    for (const value of INVALID_SHELL_TIMEOUTS) {
      expect(callWith(value)).toThrow(TypeError);
      expect(callWith(value)).toThrow(expectedRejectionMessage('streamOptions.shellTimeoutMs', value, 'renderStream'));
    }
  });

  it('accepts a valid override, and an omitted one', () => {
    expect(callWith(50)).not.toThrow();
    expect(callWith(Infinity)).not.toThrow();
    expect(callWith(undefined)).not.toThrow();
  });
});
