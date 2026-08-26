import { h } from 'vue';
import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';

import { createRenderer } from '../SSRRender';
import { INVALID_SHELL_TIMEOUTS, expectedRejectionMessage } from '../../../renderer-conformance/shellTimeout';

// PACKAGE-LOCAL, not part of the shared vector: `renderStream` accepts a per-call `shellTimeoutMs`
// in react and vue but NOT in solid, so there is no three-way invariant to pin yet. Whether the
// surface should exist at all is an open shape ruling
// (docs/followups/renderer-surface-asymmetries.md); until it is taken, the value is validated, so
// that an invalid override can neither fire the watchdog immediately (the old behaviour) nor
// silently disable it (what guarding the timer site alone would have produced).
const renderer = () => createRenderer({ appComponent: () => h('div'), headContent: () => '' });

const callWith = (shellTimeoutMs: unknown) => () =>
  renderer().renderStream(new PassThrough(), { onHead: () => {} }, {}, '/product/42', undefined, {}, undefined, { shellTimeoutMs } as never);

describe('per-call shellTimeoutMs override (@taujs/vue)', () => {
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
