import { serviceData } from '../services/registry.ts';

import type { DeferredDataOf } from '@taujs/server/config';

/**
 * RFC 0007: the deferred example route, declared ONCE here so its TYPE is nameable.
 *
 * `attr.data` is the critical snapshot; `attr.deferred` declares response-owned work that may
 * complete after rendering begins. The host starts each named loader once per request, outside the
 * component tree, and `@taujs/react` projects it onto React's own `use()` + `<Suspense>`.
 */
export const deferredRoute = {
  path: '/deferred',
  attr: {
    render: 'streaming',
    meta: { title: 'τjs React playground - deferred route data' },
    hydrate: true,
    data: serviceData('content', 'home'),
    deferred: {
      reviews: serviceData('content', 'reviews'),
    },
  },
} as const;

/**
 * The CROSS-PACKAGE inference gate: the component-facing accessor is typed from `typeof route`
 * alone, so the application never re-declares a payload shape. Type-only, so importing it from the
 * client bundle pulls in no server code.
 */
export type DeferredRouteData = DeferredDataOf<typeof deferredRoute>;
