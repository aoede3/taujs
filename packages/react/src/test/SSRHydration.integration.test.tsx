// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { hydrateApp } from '../SSRHydration';

// R2-01 / T1b — REAL react-dom/client in jsdom. Mocked-React tests cannot catch the R2-01 class:
// hydration render failures are ASYNC (they arrive via the root's onUncaughtError, verified against
// react-dom 19.2), and provable success is a component effect firing after FIRST COMMIT. A sync
// try/catch around hydrateRoot/createRoot never observes either (review #4). These repros are
// FAILING-FIRST against the pre-R2-01 renderer (which emits success synchronously and routes no
// client render error); they go green once the single root-error adapter + reporter land.

const flush = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));

type Beacon = 'hydration:start' | 'hydration:success' | 'hydration:error';

// Capture dev-hook beacon emissions AND their interleave with user callbacks (internal-first proof).
function harness() {
  const order: string[] = [];
  const beacons: Beacon[] = [];
  (window as unknown as { __TAUJS_DEVTOOLS_HOOK__?: unknown }).__TAUJS_DEVTOOLS_HOOK__ = {
    emit: (ev: Beacon) => {
      beacons.push(ev);
      order.push(`hook:${ev}`);
    },
  };
  return { order, beacons };
}

function setRoot(id = 'root', html = '') {
  document.body.innerHTML = `<div id="${id}">${html}</div>`;
  return document.getElementById(id)!;
}

const Boom = (): React.ReactElement => {
  throw new Error('render-boom');
};

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__INITIAL_DATA__;
  delete (window as unknown as Record<string, unknown>).__TAUJS_DEVTOOLS_HOOK__;
  // Real browsers expose globalThis.reportError; jsdom does NOT. Stub it present by default so the
  // renderer's global-surfacing takes the reportError branch (no unhandled window 'error' event that
  // would fail the run). The two dedicated global-surfacing tests override this locally.
  (globalThis as { reportError?: unknown }).reportError = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (globalThis as { reportError?: unknown }).reportError;
});

describe('R2-01 hydration observability (real react-dom/client)', () => {
  it('SUCCESS TIMING: hydration:success/onSuccess fire only AFTER first commit, not synchronously (fails today: sync)', async () => {
    setRoot('root', '<div>app</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { order, beacons } = harness();
    const onSuccess = vi.fn(() => order.push('user:success'));
    const onStart = vi.fn(() => order.push('user:start'));

    hydrateApp({ appComponent: <div>app</div>, onStart, onSuccess });

    // Synchronously after the call, START has fired but SUCCESS has NOT (it awaits first commit).
    expect(beacons).toContain('hydration:start');
    expect(beacons).not.toContain('hydration:success');
    expect(onSuccess).not.toHaveBeenCalled();

    await flush();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(beacons.filter((b) => b === 'hydration:success')).toHaveLength(1);
    // internal-first: the success beacon precedes the user success callback
    expect(order.indexOf('hook:hydration:success')).toBeLessThan(order.indexOf('user:success'));
  });

  it('HYDRATE THROW (no boundary): onHydrationError + hydration:error fire (async); success does NOT (fails today)', async () => {
    setRoot('root', '<div>app</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    const onHydrationError = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: <Boom />, logger: { error: vi.fn() }, onHydrationError, onSuccess });

    await flush();

    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(onHydrationError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(beacons).toContain('hydration:error');
    expect(beacons).not.toContain('hydration:success');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('CSR THROW (no data → createRoot): onHydrationError fires (async), NO beacon (CSR is not a hydration) (fails today)', async () => {
    setRoot('root'); // no SSR html
    // no __INITIAL_DATA__ → CSR path
    const { beacons } = harness();
    const onHydrationError = vi.fn();

    hydrateApp({ appComponent: <Boom />, logger: { error: vi.fn(), warn: vi.fn() }, onHydrationError });

    await flush();

    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(beacons).toHaveLength(0); // CSR emits NO beacon events (vue parity)
  });

  it('MISMATCH → recoverable: success still fires on commit, NO failure report, warn logged', async () => {
    setRoot('root', '<div>SERVER</div>'); // server html differs from client
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    const warn = vi.fn();
    const onSuccess = vi.fn();
    const onHydrationError = vi.fn();

    hydrateApp({ appComponent: <div>CLIENT</div>, logger: { warn }, onSuccess, onHydrationError });

    await flush();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(beacons).toContain('hydration:success');
    expect(onHydrationError).not.toHaveBeenCalled();
    expect(beacons).not.toContain('hydration:error');
    expect(warn).toHaveBeenCalled(); // recoverable mismatch is a warning
  });

  it('MISSING ROOT: routes to onHydrationError + hydration:error (fails today: log + return only)', async () => {
    document.body.innerHTML = ''; // no #root
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    const onHydrationError = vi.fn();

    hydrateApp({ appComponent: <div>app</div>, logger: { error: vi.fn() }, onHydrationError });

    await flush();

    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect((onHydrationError.mock.calls[0]![0] as Error).message).toContain('not found');
    expect(beacons).toContain('hydration:error');
  });

  it('SINGLE SETTLEMENT: a hydrate throw settles failure exactly once — one hydration:error, no success', async () => {
    setRoot('root', '<div>app</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    const onHydrationError = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: <Boom />, logger: { error: vi.fn() }, onHydrationError, onSuccess });

    await flush(80); // give StrictMode's double-invoke + any late ticks time

    expect(onHydrationError).toHaveBeenCalledTimes(1);
    expect(beacons.filter((b) => b === 'hydration:error')).toHaveLength(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(beacons).not.toContain('hydration:success');
  });

  it('POST-SETTLEMENT: success survives a LATER uncaught error — onHydrationError NOT re-fired, no 2nd beacon, but it still surfaces globally', async () => {
    setRoot('root', '<div>ok</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    const onSuccess = vi.fn();
    const onHydrationError = vi.fn();
    const reportErrorSpy = vi.fn();
    const prevReportError = (globalThis as { reportError?: unknown }).reportError;
    (globalThis as { reportError?: unknown }).reportError = reportErrorSpy;

    // Commits cleanly (settles success), then a delayed state update makes it throw with no boundary.
    const Later = (): React.ReactElement => {
      const [boom, setBoom] = React.useState(false);
      React.useEffect(() => {
        const t = setTimeout(() => setBoom(true), 10);
        return () => clearTimeout(t);
      }, []);
      if (boom) throw new Error('post-commit-boom');

      return <div>ok</div>;
    };

    try {
      hydrateApp({ appComponent: <Later />, logger: { error: vi.fn() }, onSuccess, onHydrationError });

      await flush(90); // first commit (success) + the 10ms delayed throw

      expect(onSuccess).toHaveBeenCalledTimes(1); // settled on first commit
      expect(onHydrationError).not.toHaveBeenCalled(); // NOT re-fired post-settlement (log-only)
      expect(beacons.filter((b) => b === 'hydration:error')).toHaveLength(0); // no 2nd beacon
      expect(beacons.filter((b) => b === 'hydration:success')).toHaveLength(1);
      // The later error still reaches the global channel (window.onerror / monitoring) — the
      // observability the custom onUncaughtError would otherwise suppress.
      expect(reportErrorSpy).toHaveBeenCalled();
    } finally {
      (globalThis as { reportError?: unknown }).reportError = prevReportError;
    }
  });

  it('CSR SUCCESS + settled-guard: onSuccess fires once on commit (createRoot DOUBLE-invokes the reporter effect under StrictMode), NO beacon, NO onStart', async () => {
    setRoot('root'); // no SSR html
    // no __INITIAL_DATA__ → CSR path. NB: unlike hydrateRoot, createRoot double-invokes the reporter
    // effect under <StrictMode>, so this is the case where the single-settlement guard is genuinely
    // exercised — onSuccess-once proves the `settled` flag collapses the double fire.
    const { beacons } = harness();
    const onStart = vi.fn();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: <div>csr</div>, onStart, onSuccess });

    await flush(80);

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
    expect(beacons).toHaveLength(0);
  });

  it('HYDRATE SUCCESS settles onSuccess exactly once (hydrateRoot does not double-invoke the effect)', async () => {
    setRoot('root', '<div>app</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    const onSuccess = vi.fn();

    hydrateApp({ appComponent: <div>app</div>, onSuccess });

    await flush(80);

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(beacons.filter((b) => b === 'hydration:success')).toHaveLength(1);
  });

  // Gate-review HIGH: onSuccess runs INSIDE the reporter's React effect. An un-isolated throw would
  // become an uncaught ROOT error → our own onUncaughtError → mis-classified as post-settlement
  // telemetry WHILE React tears the committed root down. Isolation must keep the throw out of React's
  // error domain: the DOM stays mounted, success fires once, and NO failure is manufactured.
  it('CALLBACK ISOLATION: a throwing onSuccess is logged; root stays mounted, one success, NO failure', async () => {
    setRoot('root', '<div>app</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    const errorLog = vi.fn();
    const onHydrationError = vi.fn();
    let successCalls = 0;
    const onSuccess = () => {
      successCalls += 1;
      throw new Error('onSuccess-boom');
    };

    hydrateApp({ appComponent: <div>app</div>, logger: { error: errorLog }, onSuccess, onHydrationError });

    await flush(90);

    expect(successCalls).toBe(1); // fired once
    expect(onHydrationError).not.toHaveBeenCalled(); // the throw did NOT become a failure
    expect(beacons.filter((b) => b === 'hydration:error')).toHaveLength(0);
    expect(beacons.filter((b) => b === 'hydration:success')).toHaveLength(1);
    expect(document.getElementById('root')?.innerHTML ?? '').toContain('app'); // root NOT torn down
    expect(errorLog).toHaveBeenCalled(); // the throw was logged
  });

  // Recheck MEDIUM: global surfacing must work even when globalThis.reportError is ABSENT (older
  // browsers / runtimes) — React's default falls back to dispatching a window 'error' event, so a
  // plain reportError?.() would silently lose window.onerror monitoring. Complements POST-SETTLEMENT
  // (which stubs reportError present) so BOTH branches are covered.
  it('GLOBAL SURFACING FALLBACK: with no globalThis.reportError, an uncaught error still reaches window.onerror via ErrorEvent', async () => {
    setRoot('root', '<div>app</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const prevReportError = (globalThis as { reportError?: unknown }).reportError;
    (globalThis as { reportError?: unknown }).reportError = undefined; // runtime without reportError

    const globalErrors: unknown[] = [];
    const handler = (e: Event) => {
      e.preventDefault(); // suppress jsdom's default noisy logging
      globalErrors.push((e as ErrorEvent).error);
    };
    window.addEventListener('error', handler);

    try {
      hydrateApp({ appComponent: <Boom />, logger: { error: vi.fn() }, onHydrationError: vi.fn() });

      await flush();

      expect(globalErrors.length).toBeGreaterThanOrEqual(1);
      expect(globalErrors[0]).toBeInstanceOf(Error);
      expect((globalErrors[0] as Error).message).toBe('render-boom');
    } finally {
      window.removeEventListener('error', handler);
      (globalThis as { reportError?: unknown }).reportError = prevReportError;
    }
  });

  // Gate-review HIGH (companion): onHydrationError runs inside our onUncaughtError handler. A throw
  // must be logged, not escape the root adapter, and not create a second settlement.
  it('CALLBACK ISOLATION: a throwing onHydrationError is logged and does not escape or double-settle', async () => {
    setRoot('root', '<div>app</div>');
    (window as unknown as Record<string, unknown>).__INITIAL_DATA__ = { a: 1 };
    const { beacons } = harness();
    let errCalls = 0;
    const onHydrationError = () => {
      errCalls += 1;
      throw new Error('onHydrationError-boom');
    };

    hydrateApp({ appComponent: <Boom />, logger: { error: vi.fn() }, onHydrationError });

    await flush(90);

    expect(errCalls).toBe(1); // called once, its throw swallowed
    expect(beacons.filter((b) => b === 'hydration:error')).toHaveLength(1); // single settlement
    expect(beacons.filter((b) => b === 'hydration:success')).toHaveLength(0);
  });
});
