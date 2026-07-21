import { createSignal } from 'solid-js';

/**
 * A standalone Solid counter with NO τjs in scope - the control for the replay investigation.
 * Same shape as the playground's Counter (button#counter, click increments "count: N"), so the
 * only variable between this and the playground is τjs itself.
 */
export function Counter() {
  const [n, setN] = createSignal(0);

  return (
    <button id="counter" type="button" onClick={() => setN((v) => v + 1)}>
      count: {n()}
    </button>
  );
}
