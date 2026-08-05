// SPIKE (Unit 3, tier 2): a REAL @taujs/react render module, in plain JS so production loads it
// directly with no Vite transform. The only instrumentation records WHEN the renderer is entered
// and releases a fixture gate; there is no host branch and no contract change.
import { createElement, Suspense } from 'react';
import { createRenderer, useDeferredData } from '@taujs/react';

globalThis.__reactSpike = {
  entries: [],
  loaderStartedAt: [],
  loaderSettledAt: [],
  gates: new Map(),
  /** A per-request settlement gate, so the fixture releases work relative to MEASURED entry. */
  gateFor(url) {
    let gate = this.gates.get(url);

    if (!gate) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      gate = { promise, release };
      this.gates.set(url, gate);
    }

    return gate;
  },
};

const Deferred = () => {
  const value = useDeferredData('slow');

  return createElement('span', { id: 'deferred' }, JSON.stringify(value));
};

/** Behaviour is selected by URL so one module serves every cell. */
const App = ({ location }) => {
  if (location.startsWith('/react-shell-throw')) throw new Error('spike react shell failure');

  const wantsDeferred = location.includes('deferred');

  return createElement(
    'div',
    null,
    createElement('main', null, `react:${location}`),
    wantsDeferred ? createElement(Suspense, { fallback: createElement('span', { id: 'fallback' }, 'loading') }, createElement(Deferred)) : null,
  );
};

const renderer = createRenderer({
  appComponent: ({ location }) => createElement(App, { location }),
  headContent: () => '<title>react spike</title>',
  // Deterministic budgets for the leg. NOTHING here reaches τjs: these are RENDERER options, and
  // they belong under `streamOptions` - at the top level they are silently ignored and the
  // renderer's 15s default applies, which is exactly the mistake this fixture first made.
  streamOptions: { dataTimeoutMs: 5000, deferredTimeoutMs: 300 },
});

export const renderSSR = renderer.renderSSR;

const CONTRACT = Symbol.for('taujs.render-contract/v1');

const instrumented = (...args) => {
  const url = args[3];

  // args[3] is `location`; record WHEN the renderer was actually entered.
  globalThis.__reactSpike.entries.push({ url, at: Date.now() });

  // Release the EAGERLY-STARTED loader just after entry, except for the cell that deliberately
  // never releases it (the deferred-deadline case). Settlement is then relative to the measured
  // renderer entry rather than to a second independently scheduled timer.
  if (!url.includes('never')) {
    const gate = globalThis.__reactSpike.gateFor(url);

    setImmediate(() => {
      gate.release();
      globalThis.__reactSpike.gates.delete(url);
    });
  }

  return renderer.renderStream(...args);
};

// The wrapper must carry the SAME contract brand, so this stays instrumentation rather than a
// second renderer identity.
Object.defineProperty(instrumented, CONTRACT, { value: renderer.renderStream[CONTRACT], enumerable: false });

export const renderStream = instrumented;
