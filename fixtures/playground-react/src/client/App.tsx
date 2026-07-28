import React, { Suspense, useState } from 'react';
import { createDeferredAccessor, useSSRStore } from '@taujs/react';

import type { DeferredRouteData } from '../server/routes/deferred.ts';

/**
 * RFC 0007: the ROUTE-DECLARED deferred read.
 *
 * The accessor is typed from the route config alone - `DeferredDataOf<typeof deferredRoute>` - so
 * the payload shape is never re-declared here. The component starts nothing: the host began this
 * work before the render, and `useDeferred` only projects the named promise onto React's own
 * `use()`, suspending this boundary and nothing else.
 */
const useDeferred = createDeferredAccessor<DeferredRouteData>();

function DeferredReviews() {
  const reviews = useDeferred('reviews');
  // The annotation is the GATE: `count` is inferred from the route's `serviceData()` brand, so
  // changing the service's declared result type fails this typecheck rather than shipping.
  const count: number = reviews.count;

  return <p id="reviews">{`reviews: ${count} - ${reviews.top}`}</p>;
}

/**
 * Proves hydration by EXECUTED BEHAVIOUR rather than markup: the server renders `count: 0`, and
 * only a hydrated, interactive root can turn a click into `count: 1`.
 */
function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button id="counter" type="button" onClick={() => setCount((n) => n + 1)}>
      count: {count}
    </button>
  );
}

export const App = ({ location = '' }: { location?: string }) => {
  const data = useSSRStore<Record<string, unknown>>();

  return (
    <main>
      <h1>τjs playground</h1>
      <p>Fixture app for the introspection substrate. Initial data below.</p>
      <Counter />
      <pre id="initial-data">{JSON.stringify(data, null, 2)}</pre>

      {location.startsWith('/deferred') ? (
        <Suspense fallback={<p id="reviews-pending">loading reviews</p>}>
          <DeferredReviews />
        </Suspense>
      ) : null}
    </main>
  );
};
