import { serviceData } from '../services/registry.ts';

import type { DeferredDataOf } from '@taujs/server/config';

/**
 * The deferred example route: `attr.data` is the critical snapshot (cheap, so it is still resolving
 * fast); `attr.deferred` declares TWO response-owned entries - one that settles well inside the
 * fixture's 500ms `deferredTimeoutMs`, and one that never settles, so the deadline's `aborted`
 * classification is exercised too.
 */
export const deferredRoute = {
  path: '/deferred',
  attr: {
    render: 'streaming',
    meta: { title: 'τjs HTML playground - deferred route data' },
    hydrate: true,
    data: serviceData('content', 'home'),
    deferred: {
      reviews: serviceData('content', 'reviews'),
      neverResolves: serviceData('content', 'neverResolves'),
    },
  },
} as const;

/** Same shape, `hydrate: false` - the host never emits the deferred carrier or the bootstrap tag. */
export const deferredNoHydrateRoute = {
  path: '/deferred-no-hydrate',
  attr: {
    render: 'streaming',
    meta: { title: 'τjs HTML playground - deferred route data (no hydrate)' },
    hydrate: false,
    data: serviceData('content', 'home'),
    deferred: {
      reviews: serviceData('content', 'reviews'),
      neverResolves: serviceData('content', 'neverResolves'),
    },
  },
} as const;

/** The cross-package inference gate: the client's typed accessor is named from `typeof route` alone. */
export type DeferredRouteData = DeferredDataOf<typeof deferredRoute>;
