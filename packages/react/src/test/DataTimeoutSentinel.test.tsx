// @vitest-environment node
import { PassThrough } from 'node:stream';

import React, { Suspense } from 'react';
import { describe, it, expect, vi } from 'vitest';

import { createRenderer } from '../SSRRender';
import { useSSRStore } from '../SSRDataStore';
import {
  INVALID_SHELL_TIMEOUTS,
  SENTINEL_SHELL_TIMEOUTS,
  TIMEOUT_OVERFLOW,
  collectProcessWarnings,
  expectedRejectionMessage,
} from '../../../renderer-conformance/shellTimeout';

// PACKAGE-LOCAL, not part of the shared vector: `dataTimeoutMs` has no vue/solid equivalent, so
// there is no three-way invariant to pin (docs/followups/react-vue-stream-timeouts-unvalidated.md).
// The values and message shape are reused from shellTimeoutMs's conformance vector because the
// rule - same sentinels, same bound, same rejection text - is identical; only the option name and
// timer site differ.

type Data = { value?: number };

const OPTION = 'streamOptions.dataTimeoutMs';

const build = (dataTimeoutMs: unknown) => createRenderer({ appComponent: () => <div />, headContent: () => '', streamOptions: { dataTimeoutMs } as never });

describe('dataTimeoutMs factory validation (@taujs/react)', () => {
  it('rejects an invalid value at the factory, naming the option', () => {
    for (const value of INVALID_SHELL_TIMEOUTS) {
      expect(() => build(value)).toThrow(TypeError);
      expect(() => build(value)).toThrow(expectedRejectionMessage(OPTION, value));
    }
  });

  it('accepts the sentinels 0 and Infinity', () => {
    for (const value of SENTINEL_SHELL_TIMEOUTS) {
      expect(() => build(value)).not.toThrow();
    }
  });
});

const renderer = () => createRenderer({ appComponent: () => <div />, headContent: () => '' });

const callWith = (dataTimeoutMs: unknown) => () =>
  renderer().renderStream(new PassThrough(), { onHead: () => {} }, {}, '/product/42', undefined, {}, undefined, { dataTimeoutMs } as never);

describe('per-call dataTimeoutMs override (@taujs/react)', () => {
  it('rejects an invalid override at the renderStream boundary, naming that site', () => {
    for (const value of INVALID_SHELL_TIMEOUTS) {
      expect(callWith(value)).toThrow(TypeError);
      expect(callWith(value)).toThrow(expectedRejectionMessage(OPTION, value, 'renderStream'));
    }
  });

  it('accepts a valid override, and an omitted one', () => {
    expect(callWith(50)).not.toThrow();
    expect(callWith(Infinity)).not.toThrow();
    expect(callWith(undefined)).not.toThrow();
  });
});

// Load-bearing: the sentinel must not reach `armDataDeadline`'s raw `setTimeout`. Before the fix,
// `Infinity` (and `0`) clamped to 1ms there and fatally failed the response with "Route data not
// ready after <n>ms" whenever route data was still pending at shell commit - see
// docs/followups/react-vue-stream-timeouts-unvalidated.md. A finite `dataTimeoutMs` still fires and
// still fatals: covered already by SSRRender.integration.test.tsx's "bounded liveness: a suspending
// store consumer whose data NEVER settles -> ... done REJECTS with the data-timeout error", not
// duplicated here.
describe('dataTimeoutMs sentinel behaviour (@taujs/react)', () => {
  it.each(SENTINEL_SHELL_TIMEOUTS)(
    'dataTimeoutMs %s arms no timer - the response completes once route data settles, no TimeoutOverflowWarning',
    async (dataTimeoutMs) => {
      const writable = new PassThrough();
      const onAllReady = vi.fn();

      const Consumer = () => {
        const data = useSSRStore<Data>();
        return <div>value:{String(data.value)}</div>;
      };
      const App = () => (
        <div>
          <p>shell</p>
          <Suspense fallback={<span>loading-fallback</span>}>
            <Consumer />
          </Suspense>
        </div>
      );

      let done!: Promise<void>;
      const warnings = await collectProcessWarnings(async () => {
        ({ done } = createRenderer<Data>({ appComponent: () => <App />, headContent: () => '<title>x</title>' }).renderStream(
          writable,
          { onHead: () => {}, onAllReady },
          () => new Promise<Data>((resolve) => setTimeout(() => resolve({ value: 1 }), 30)), // settles AFTER shell commit
          '/sentinel-data-timeout',
          undefined,
          undefined,
          undefined,
          { dataTimeoutMs },
        ));

        // Completes when the data settles - NOT a fatal at ~1ms.
        await expect(done).resolves.toBeUndefined();
      });

      expect(warnings.filter((w) => w.includes(TIMEOUT_OVERFLOW))).toEqual([]);
      expect(onAllReady).toHaveBeenCalledWith({ value: 1 });
    },
  );
});
