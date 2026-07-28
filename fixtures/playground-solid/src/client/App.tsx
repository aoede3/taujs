import { createResource, createSignal, ErrorBoundary, Show, Suspense } from 'solid-js';
import { createDeferredAccessor, useSSRStore } from '@taujs/solid';

import type { DeferredRouteData } from '../server/routes/deferred.ts';

export type RouteData = {
  title?: string;
  message?: string;
  items?: string[];
};

/**
 * An APP-OWNED Solid resource - a different class of work from τjs route data, and the thing
 * Solid's deferred `$df` patch channel exists for.
 *
 * The streaming routes need one of these to exercise that channel at all: under the snapshot
 * bridge, route data travels in `__INITIAL_DATA__` and is never streamed, so a page with only
 * route data has nothing to defer and emits no patch machinery. That is the documented trade
 * (design 3), not a defect - but it does mean "streaming" is only observable end to end when the
 * application itself owns some async work.
 */
function DeferredNote() {
  const [note] = createResource(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));

    return 'app-owned resource resolved';
  });

  return <p id="deferred">{note()}</p>;
}

/**
 * Proves hydration by EXECUTED BEHAVIOUR rather than markup: the server renders `count: 0`, and
 * only a hydrated, interactive root can turn a click into `count: 1`.
 *
 * It is also the pre-hydration capture/replay probe. Solid's hydration bootstrap installs
 * document-level `click`/`input` listeners that queue events into `_$HY.events` before the app is
 * interactive; `hydrate()` then replays them. So a click landing BEFORE the client entry executes
 * must still be reflected once hydration completes - without a second click.
 */
function Counter() {
  const [count, setCount] = createSignal(0);

  return (
    <button id="counter" type="button" onClick={() => setCount((n) => n + 1)}>
      count: {count()}
    </button>
  );
}

/**
 * RFC 0007: the ROUTE-DECLARED deferred read.
 *
 * The accessor is typed from the route config alone - `DeferredDataOf<typeof deferredRoute>` - so
 * the payload shape is never re-declared here. The component starts nothing: the host began this
 * work before the render, and `useDeferred` only projects the named promise onto Solid's own
 * resource model, suspending this boundary and nothing else.
 */
const useDeferred = createDeferredAccessor<DeferredRouteData>();

function DeferredReviews() {
  const reviews = useDeferred('reviews');
  // The annotation is the GATE: `count` is inferred from the route's `serviceData()` brand, so
  // changing the service's declared result type fails this typecheck rather than shipping.
  const count = (): number | undefined => reviews()?.count;

  return <p id="reviews">{`reviews: ${String(count() ?? '')} - ${String(reviews()?.top ?? '')}`}</p>;
}

/** An app-owned resource that REJECTS after the shell, to exercise the sanitiser in a browser. */
function RejectingNote() {
  const [note] = createResource(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    throw new Error('PLAYGROUND-SECRET db=hunter2 host=10.0.0.5');
  });

  return <p id="rejected">{String(note() ?? '')}</p>;
}

/**
 * Route data reaches the component through the store the renderer provides. On the server the
 * snapshot bridge has already committed it before the render begins; on the client `hydrateApp`
 * seeds it from `window.__INITIAL_DATA__`. Either way it is read like any other Solid accessor.
 */
export function App(props: { location: string }) {
  const store = useSSRStore<RouteData>();

  return (
    <main id="app">
      <h1>τjs + Solid</h1>
      <p id="route">{props.location}</p>

      <Show when={store.data().message} fallback={<p id="empty">No route data.</p>}>
        <p id="message">{store.data().message}</p>
      </Show>

      <Show when={store.data().items?.length}>
        <ul id="items">
          {store.data().items?.map((item) => (
            <li>{item}</li>
          ))}
        </ul>
      </Show>

      <Counter />

      <Suspense fallback={<p id="deferred-pending">loading deferred…</p>}>
        <DeferredNote />
      </Suspense>

      <Show when={props.location.startsWith('/deferred')}>
        {/* PLACEMENT: the ErrorBoundary sits INSIDE the Suspense, which is what makes a `failed` or
            `aborted` outcome render its fallback INTO the response rather than on the client. */}
        <Suspense fallback={<p id="reviews-pending">loading reviews…</p>}>
          <ErrorBoundary fallback={<p id="reviews-error">reviews unavailable</p>}>
            <DeferredReviews />
          </ErrorBoundary>
        </Suspense>
      </Show>

      <Show when={props.location.startsWith('/reject')}>
        <ErrorBoundary fallback={(error: unknown) => <p id="boundary">{`${(error as Error)?.name}: ${(error as Error)?.message}`}</p>}>
          <Suspense fallback={<p id="rejected-pending">loading…</p>}>
            <RejectingNote />
          </Suspense>
        </ErrorBoundary>
      </Show>
    </main>
  );
}
