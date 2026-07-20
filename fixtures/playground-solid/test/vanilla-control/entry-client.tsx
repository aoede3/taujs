import { hydrate } from 'solid-js/web';

import { Counter } from './Counter';

// Plain Solid hydration - the same call τjs makes, with nothing between it and the runtime. The
// `renderId` is pinned to the SAME value the server renders with (see vanilla-control.test.ts), so
// server and client share one hydration-key namespace. Solid derives a default renderId from
// ambient module state when none is given, and that default is not stable across a build vs a
// same-process SSR render under vitest - which surfaces as an "Unable to find DOM nodes for
// hydration key" mismatch. Pinning it is exactly how τjs's own renderer keeps the two sides aligned.
hydrate(() => <Counter />, document.getElementById('root')!, { renderId: 'vc' });

// A deterministic "hydration ran" flag for the driver. Solid replays captured events INSIDE
// hydrate() (the compiler emits `runHydrationEvents` into the component), so by the line after the
// call the replay decision is final. Unlike the playground, vanilla Solid does not reset `_$HY`
// after hydration - its event queue stays populated - so there is no non-mutating internal signal
// to poll; this flag supplies one without touching the compiler, bootstrap or hydration path.
(window as unknown as { __controlHydrated?: boolean }).__controlHydrated = true;
