// @vitest-environment node
import { PassThrough } from 'node:stream';
import { createComponent, createResource, Suspense } from 'solid-js';
import { ssr } from 'solid-js/web';
import { describe, it, expect } from 'vitest';

import { createRenderer } from '../SSRRender.js';

import type { JSX } from 'solid-js';

/**
 * Design 7.3's forced-GC leg, at the RENDERER's terminal paths.
 *
 * WHY THIS FILE EXISTS SEPARATELY, and what it adds over what already passes:
 *
 * `SSRDataStore.test.ts` already proves M1 causally with WeakRef + forced GC, but only for the
 * STORE in isolation - `detachStore(store)` called directly. `SSRRender.test.ts` covers the
 * renderer's four terminal paths, but observes detachment through the component-facing accessor:
 * it proves the accessor THROWS afterwards, which is a behavioural flag, not evidence that the
 * payload actually became collectable. Between the two there was an untested joint - whether
 * driving a REAL render to a REAL terminal releases a REAL payload - and 7.3 asks for exactly
 * that. It is written as the reviewer required: isolated in its own file and explicitly labelled,
 * so if the GC probe is ever flaky it degrades visibly here instead of contaminating unrelated
 * suites.
 *
 * The instrument follows the same discipline that made the store proof mean anything: the payload
 * is built inside an inner scope and only a WeakRef escapes, so no test-local binding keeps it
 * alive and a green result cannot be an artefact of the harness. That inner scope must be
 * SYNCHRONOUS, and the settled promise must be dropped before collecting - both learned the hard
 * way here. An earlier version built the payload inside an `async` setup function and awaited the
 * terminal inside it; the streaming leg then reported RETAINED. It was the async frame's context
 * holding the payload, not the adapter: the identical render, driven from a synchronous setup
 * outside vitest, releases it. A false leak is as damaging as a missed one, so the shape below is
 * load-bearing rather than stylistic. The CONTROL is what gives the
 * negative results their force - it runs the identical instrument against a render still IN
 * FLIGHT and requires the payload to survive. Without it, "collected" could just mean the WeakRef
 * was never observing the right object.
 *
 * Skipped visibly, never silently passed, when the runner has no `--expose-gc`
 * (`vitest.config.ts` supplies it via `poolOptions`).
 */
const html = (markup: string): JSX.Element => ssr(markup) as never;
const appComponent = (): JSX.Element => html('<div id="app">x</div>');

/** An app that suspends and NEVER settles, so the render cannot reach a terminal on its own. */
const neverSettlingApp = (): JSX.Element =>
  createComponent(Suspense, {
    fallback: html('<p>f</p>'),
    get children() {
      const [r] = createResource(() => new Promise<string>(() => {}));

      return html('<p>' + String(r() ?? '') + '</p>');
    },
  }) as never;

const makeSink = () => {
  const sink = new PassThrough();
  sink.on('data', () => {});
  sink.on('error', () => {});

  return sink;
};

/**
 * Plain no-op callbacks - `vi.fn()` is DISQUALIFIED in this suite, and that is not a style choice.
 *
 * A mock retains `mock.calls`, i.e. every argument it was ever handed, for the life of the test.
 * The renderer calls `onAllReady(data, ...)` with the route payload, so a `vi.fn()` here holds a
 * strong reference to the very object the WeakRef is watching, and the streaming leg reports a
 * leak that does not exist. That is exactly what happened while writing this file: streaming said
 * RETAINED under `vi.fn()` and `collected` under these no-ops, with the product byte-identical.
 *
 * Note also what the failure taught about scope: the payload reaching `onAllReady` is CORRECT -
 * the host is handed the data so it can serialise `__INITIAL_DATA__`. M1's claim is about what the
 * ADAPTER retains after a terminal, not about what a host chooses to keep afterwards.
 */
const makeCallbacks = () => ({
  onHead() {},
  onShellReady() {},
  onAllReady() {},
  onError() {},
  onRenderError() {},
});

const gc = (globalThis as { gc?: () => void }).gc;
const gcIt = gc ? it : it.skip;

const collect = async () => {
  for (let i = 0; i < 10; i++) {
    gc!();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe('7.3 forced-GC: a renderer terminal releases the route payload', () => {
  gcIt('CONTROL: a render still IN FLIGHT retains its payload', async () => {
    // The same instrument, deliberately denied a terminal. If this went green-as-collected the
    // probe would be measuring nothing and every result below would be worthless.
    const start = () => {
      const payload = { big: 'x'.repeat(4096) };
      const { renderStream } = createRenderer({ appComponent: neverSettlingApp, headContent: () => '' });
      // Real route data, handed to the adapter; the APP is what never settles, so no terminal is
      // reached and the adapter is still legitimately holding the payload.
      const handle = renderStream(makeSink(), makeCallbacks(), payload, '/');

      return { ref: new WeakRef(payload), handle };
    };
    const started = start();

    await collect();

    expect(started.ref.deref(), 'the control payload was collected with no terminal reached - the probe proves nothing').toBeDefined();
    expect(started.handle).toBeDefined();

    // Retention is proven; now REACH a terminal so nothing outlives the test. A never-settling
    // render leaves the shell and completion watchdogs armed (up to shellTimeoutMs / completionTimeoutMs),
    // and `done` never resolves. `abort()` runs the controller's cleanup - both timers cleared,
    // the store detached, `done` resolved - so no watchdog, timer or rejection leaks past here.
    started.handle.abort();
    await started.handle.done.catch(() => {});
  });

  gcIt('STREAMING: the payload is collectable once the stream completes', async () => {
    const start = () => {
      const payload = { big: 'x'.repeat(4096) };
      const { renderStream } = createRenderer({ appComponent, headContent: () => '' });

      return { ref: new WeakRef(payload), done: renderStream(makeSink(), makeCallbacks(), payload, '/').done };
    };
    const started = start();

    await started.done;
    started.done = undefined as never; // the settled promise would otherwise retain the frame

    await collect();

    expect(started.ref.deref(), 'the route payload survived a completed stream - the adapter is still holding it').toBeUndefined();
  });

  gcIt('SSR TIMEOUT: the payload is collectable after prerenderTimeoutMs rejects', async () => {
    // The path most likely to leak, and the reason 7.3 names it specifically: the render never
    // finished, so nothing on the success path can be relied on to clean up. Detachment has to
    // happen on the timeout exit too.
    const start = () => {
      const payload = { big: 'x'.repeat(4096) };
      const { renderSSR } = createRenderer({
        appComponent: neverSettlingApp,
        headContent: () => '',
        ssrOptions: { prerenderTimeoutMs: 30 },
      });

      // The route data RESOLVES and is genuinely held by the adapter; the APP overruns the
      // deadline. That is what makes this the timeout path rather than a data-never-arrives path.
      return { ref: new WeakRef(payload), pending: renderSSR(payload, '/') };
    };
    const started = start();

    await expect(started.pending).rejects.toThrow(/prerenderTimeoutMs/);
    started.pending = undefined as never;

    await collect();

    expect(started.ref.deref(), 'the route payload survived an SSR timeout - the timeout exit is not detaching').toBeUndefined();
  });
});
