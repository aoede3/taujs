import { hydrate } from 'solid-js/web';

import { Counter } from './Counter';

// Plain Solid hydration - the same call τjs makes, with nothing between it and the runtime. The
// `renderId` is pinned to the value the server renders with (see vanilla-control.test.ts), so both
// sides share one hydration-key namespace. Solid derives a default renderId from ambient module
// state when none is given, and that default is not stable across a build vs a same-process SSR
// render under vitest, which surfaces as an "Unable to find DOM nodes for hydration key" mismatch.
// Pinning it is exactly how τjs's own renderer keeps the two sides aligned.
hydrate(() => <Counter />, document.getElementById('root')!, { renderId: 'vc' });
