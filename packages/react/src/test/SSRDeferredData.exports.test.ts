// @vitest-environment node
// RFC 0007 (decision 10 / renderer contract item 9): the package's PUBLIC surface for this feature
// is the component-facing accessors and their result/error types - and nothing else. A private
// transport must never become an importable package surface.
import { describe, it, expect } from 'vitest';

import * as pkg from '../index';
import * as internals from '../SSRDeferredData';

const PUBLIC = ['createDeferredAccessor', 'DeferredDataError', 'useDeferredData', 'useDeferredDataResult'];

// Everything the adapter module exports for `SSRRender` / `SSRHydration` / this package's own tests
// and which must NOT reach the package root.
const FORBIDDEN = ['DEFERRED_STATE_CARRIER', 'createDeferredHolder', 'createHydrationHolder', 'DeferredDataProvider', 'takeDeferredHydrationState'];

describe('@taujs/react deferred-data export hygiene', () => {
  it('exports exactly the frozen public spellings (decision 19)', () => {
    for (const name of PUBLIC) expect(Object.keys(pkg)).toContain(name);
  });

  it('exports NONE of the private transport', () => {
    for (const name of FORBIDDEN) {
      expect(internals).toHaveProperty(name); // it really is a module export...
      expect(Object.keys(pkg)).not.toContain(name); // ...and really is not a package export
    }
  });

  it('never exposes the carrier NAME through any exported value', () => {
    for (const value of Object.values(pkg)) {
      if (typeof value === 'string') expect(value).not.toContain('__TAUJS_DEFERRED_STATE__');
    }
  });
});
