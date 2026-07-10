import type { App, InjectionKey } from 'vue';

export const PLAYGROUND_KEY: InjectionKey<string> = Symbol('taujs:playground-name');

// The SAME setupApp runs on server (renderSSR/renderStream) and client (hydrate/CSR): a
// provide any component can inject. Proves setupApp fires on every path and stays consistent.
export const setupApp = (app: App): void => {
  app.provide(PLAYGROUND_KEY, 'taujs-vue-playground');
};
