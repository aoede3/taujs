// SPIKE (Unit 3, tier 2 - Solid leg): a REAL @taujs/solid render module in plain JS.
//
// Solid has no runtime hyperscript on the server - `solid-js/h` needs a DOM `Element` - so this
// writes what the JSX compiler would emit: `ssr()` templates plus `createComponent`. Solid's
// semantics are measured on their own terms; neither React's shell model nor Vue's in-order model
// is assumed.
import { createRenderer, useDeferredData } from '@taujs/solid';
import { Suspense } from 'solid-js';
import { createComponent, escape, ssr } from 'solid-js/web';

globalThis.__solidSpike = {
  entries: [],
  gates: new Map(),
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

  return ssr(['<span id="deferred">', '</span>'], () => escape(JSON.stringify(value())));
};

const App = (props) => {
  if (props.location.startsWith('/solid-shell-throw')) throw new Error('spike solid shell failure');

  const body = props.location.includes('deferred')
    ? createComponent(Suspense, {
        fallback: ssr(['<span>loading</span>']),
        get children() {
          return createComponent(Deferred, {});
        },
      })
    : '';

  return ssr(['<div><main>solid:', '</main>', '</div>'], escape(props.location), body);
};

const renderer = createRenderer({
  appComponent: ({ location }) => createComponent(App, { location }),
  headContent: (ctx) => {
    // Genuine PRE-HEAD failure: runs before `onHead`, so nothing has been committed.
    if (ctx?.routeContext?.path?.startsWith('/solid-head-throw')) throw new Error('spike solid head failure');

    return '<title>solid spike</title>';
  },
  // SOLID's own public option shape, verified against packages/solid/src/SSRRender.tsx.
  streamOptions: { deferredTimeoutMs: 300 },
});

export const renderSSR = renderer.renderSSR;

const CONTRACT = Symbol.for('taujs.render-contract/v1');

const instrumented = (...args) => {
  const url = args[3];

  globalThis.__solidSpike.entries.push({ url, at: Date.now() });

  if (!url.includes('never')) {
    const gate = globalThis.__solidSpike.gateFor(url);

    setImmediate(() => {
      gate.release();
      globalThis.__solidSpike.gates.delete(url);
    });
  }

  return renderer.renderStream(...args);
};

Object.defineProperty(instrumented, CONTRACT, { value: renderer.renderStream[CONTRACT], enumerable: false });

export const renderStream = instrumented;
