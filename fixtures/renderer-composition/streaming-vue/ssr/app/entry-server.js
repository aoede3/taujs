// SPIKE (Unit 3, tier 2 - Vue leg): a REAL @taujs/vue render module in plain JS. Vue's semantics
// are measured independently; nothing here is copied from the React leg's expectations.
import { createRenderer, useDeferredData, useDeferredDataResult } from '@taujs/vue';
import { defineComponent, h, Suspense } from 'vue';

globalThis.__vueSpike = {
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

// Vue's documented PRIMARY accessor: the RESULT read never rejects for a declared key, so the
// application branches on the outcome and renders it INTO the response. `useDeferredData` is the
// throwing read, which Vue's own docs warn against for anything that can fail.
const Deferred = defineComponent({
  async setup() {
    const result = await useDeferredDataResult('slow');

    return () => h('span', { id: 'deferred' }, JSON.stringify(result));
  },
});

/** The THROWING read, which Vue's own documentation warns against for anything that can fail. */
const DeferredThrowing = defineComponent({
  async setup() {
    const value = await useDeferredData('slow');

    return () => h('span', { id: 'deferred' }, JSON.stringify(value));
  },
});

const App = defineComponent({
  props: { location: { type: String, required: true } },
  setup(props) {
    return () => {
      if (props.location.startsWith('/vue-shell-throw')) throw new Error('spike vue shell failure');

      return h('div', null, [
        h('main', null, `vue:${props.location}`),
        props.location.includes('deferred')
          ? h(Suspense, null, {
              default: () => h(props.location.includes('throwing') ? DeferredThrowing : Deferred),
              fallback: () => h('span', null, 'loading'),
            })
          : null,
      ]);
    };
  },
});

const renderer = createRenderer({
  appComponent: ({ location }) => h(App, { location }),
  headContent: (ctx) => {
    // A genuine PRE-HEAD failure: this runs before `onHead`, so nothing has been committed.
    if (ctx?.routeContext?.path?.startsWith('/vue-head-throw')) throw new Error('spike vue head failure');

    return '<title>vue spike</title>';
  },
  // Vue's OWN public option shape, verified against packages/vue/src/SSRRender.ts.
  streamOptions: { deferredTimeoutMs: 300 },
});

export const renderSSR = renderer.renderSSR;

const CONTRACT = Symbol.for('taujs.render-contract/v1');

const instrumented = (...args) => {
  const url = args[3];

  globalThis.__vueSpike.entries.push({ url, at: Date.now() });

  if (!url.includes('never')) {
    const gate = globalThis.__vueSpike.gateFor(url);

    setImmediate(() => {
      gate.release();
      globalThis.__vueSpike.gates.delete(url);
    });
  }

  return renderer.renderStream(...args);
};

Object.defineProperty(instrumented, CONTRACT, { value: renderer.renderStream[CONTRACT], enumerable: false });

export const renderStream = instrumented;
