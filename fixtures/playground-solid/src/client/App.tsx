import { Show } from 'solid-js';
import { useSSRStore } from '@taujs/solid';

export type RouteData = {
  title?: string;
  message?: string;
  items?: string[];
};

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
    </main>
  );
}
