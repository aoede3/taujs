import { createResource, Show, Suspense } from 'solid-js';
import { useSSRStore } from '@taujs/solid';

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
        <ul id="items">{store.data().items?.map((item) => <li>{item}</li>)}</ul>
      </Show>

      <Suspense fallback={<p id="deferred-pending">loading deferred…</p>}>
        <DeferredNote />
      </Suspense>
    </main>
  );
}
