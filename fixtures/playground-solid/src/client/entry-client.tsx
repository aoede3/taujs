import { hydrateApp } from '@taujs/solid';

import { App } from './App';
import { RENDER_ID } from './renderId';

// Fixture-owned state so the real-browser smoke (test/browser.test.ts) can observe the hydration
// lifecycle - onStart, onSuccess and the debug logs - through window state. Harmless playground
// instrumentation, not something an application must do. Logs go to this probe, NOT the console, so
// the suite's "no console errors" assertions stay honest.
type HydrationProbe = { events: string[]; logs: string[] };
const probe: HydrationProbe = ((window as unknown as { __TAUJS_HYDRATION_PROBE__?: HydrationProbe }).__TAUJS_HYDRATION_PROBE__ ??= {
  events: [],
  logs: [],
});

hydrateApp({
  app: ({ location }) => <App location={location} />,
  renderId: RENDER_ID,
  rootElementId: 'root',
  enableDebug: true,
  logger: {
    log: (...args: unknown[]) => {
      probe.logs.push(args.map((a) => String(a)).join(' '));
    },
    warn: (...args: unknown[]) => {
      probe.logs.push(args.map((a) => String(a)).join(' '));
    },
    error: (...args: unknown[]) => {
      probe.logs.push(args.map((a) => String(a)).join(' '));
    },
  },
  onStart: () => probe.events.push('onStart'),
  onSuccess: () => probe.events.push('onSuccess'),
  onHydrationError: (error) => {
    probe.events.push('onHydrationError');
    console.error('[playground-solid] hydration failed:', error);
  },
});
