// @vitest-environment node
import { PassThrough } from 'node:stream';
import { createComponent, createResource, Suspense } from 'solid-js';
import { ssr } from 'solid-js/web';
import { describe, it, expect, vi } from 'vitest';

import { createRenderer } from '../SSRRender.js';
import { useSSRStore } from '../SSRDataStore.js';

import type { JSX } from 'solid-js';

type Data = Record<string, unknown>;

const tick = () => new Promise<void>((r) => setImmediate(r));

/** Wait for a condition rather than guessing a number of ticks - Solid schedules its shell
 *  completion on its own queue, so a fixed tick count is a flaky proxy for "the shell committed". */
const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within ' + timeoutMs + 'ms');
    await new Promise((r) => setTimeout(r, 1));
  }
};
const later = <T>(value: T, ms = 10) => new Promise<T>((r) => setTimeout(() => r(value), ms));
const laterReject = (reason: unknown, ms = 10) => new Promise<never>((_, j) => setTimeout(() => j(reason), ms));

/** A sink that records everything, and can be made to fail on demand. */
function makeSink() {
  const chunks: string[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => chunks.push(String(c)));
  sink.on('error', () => {});

  return { sink, text: () => chunks.join(''), chunks };
}

function makeCallbacks() {
  return {
    onHead: vi.fn(),
    onShellReady: vi.fn(),
    onAllReady: vi.fn(),
    onError: vi.fn(),
    onRenderError: vi.fn(),
  };
}

/** `ssr()` returns Solid's server `{ t: string }` marker, not a `JSX.Element`; one typed helper
 *  keeps the cast in a single place instead of scattering `as never` through every fixture. */
const html = (markup: string): JSX.Element => ssr(markup) as never;

const simpleApp = (): JSX.Element => html('<div id="app">solid</div>');

/** An app whose Suspense boundary settles AFTER the shell, so post-shell behaviour is reachable. */
const appWithLateResource = (fetcher: () => Promise<unknown>): JSX.Element =>
  [
    html('<div id="shell">shell</div>'),
    createComponent(Suspense, {
      fallback: html('<p>f</p>'),
      get children() {
        const [d] = createResource(fetcher);
        return html(`<p>${String(d() ?? '')}</p>`);
      },
    }),
  ] as never;

const renderer = (over: Partial<Parameters<typeof createRenderer>[0]> = {}) =>
  createRenderer({
    appComponent: simpleApp,
    headContent: () => '<title>t</title>',
    ...over,
  });

describe('createRenderer - contract shape', () => {
  it('returns branded renderSSR + renderStream', () => {
    const mod = renderer();

    expect(typeof mod.renderSSR).toBe('function');
    expect(typeof mod.renderStream).toBe('function');

    const brand = Object.getOwnPropertySymbols(mod.renderSSR).map((s) => (mod.renderSSR as unknown as Record<symbol, unknown>)[s]);
    expect(brand).toContainEqual({ key: 'solid', contractVersion: 'v1' });
    // the brand must be on BOTH functions - it has to survive a destructure
    const streamBrand = Object.getOwnPropertySymbols(mod.renderStream).map((s) => (mod.renderStream as unknown as Record<symbol, unknown>)[s]);
    expect(streamBrand).toContainEqual({ key: 'solid', contractVersion: 'v1' });
  });
});

describe('renderSSR (ssr strategy - a single promise, no stream vocabulary)', () => {
  it('renders and returns headContent + appHtml, with route data readable in the component', async () => {
    const { renderSSR } = createRenderer({
      appComponent: () => html('<div id="app">rendered</div>'),
      headContent: ({ data }) => `<title>${String(data.title)}</title>`,
    });

    const out = await renderSSR({ title: 'hello' }, '/');

    // headContent now carries Solid's hydration bootstrap appended after the app's own head
    // (design 4, cell 1) - the four-cell suite below pins that precisely.
    expect(out.headContent.startsWith('<title>hello</title>')).toBe(true);
    expect(out.appHtml).toContain('rendered');
  });

  it('an already-aborted signal short-circuits without rendering', async () => {
    const appComponent = vi.fn(() => html('<div>x</div>'));
    const { renderSSR } = createRenderer({ appComponent, headContent: () => '' });

    const ac = new AbortController();
    ac.abort();
    const out = await renderSSR({}, '/', {}, ac.signal);

    expect(out.appHtml).toBe('');
    expect(appComponent).not.toHaveBeenCalled();
  });

  it('a synchronous render throw REJECTS rather than escaping (B1 exp01 is handled)', async () => {
    // renderToStringAsync throws SYNCHRONOUSLY for a sync root throw - before a promise exists. The
    // adapter wraps the call so the host sees a normal rejection.
    const { renderSSR } = createRenderer({
      appComponent: () => {
        throw new Error('sync root throw');
      },
      headContent: () => '',
    });

    await expect(renderSSR({}, '/')).rejects.toThrow('sync root throw');
  });

  it('a render that exceeds prerenderTimeoutMs rejects rather than hanging', async () => {
    const { renderSSR } = createRenderer({
      appComponent: () =>
        createComponent(Suspense, {
          fallback: html('<p>f</p>'),
          get children() {
            const [d] = createResource(() => new Promise<string>(() => {})); // never settles
            return html(`<p>${String(d() ?? '')}</p>`);
          },
        }) as never,
      headContent: () => '',
      ssrOptions: { prerenderTimeoutMs: 30 },
    });

    await expect(renderSSR({}, '/')).rejects.toThrow(/prerenderTimeoutMs \(30ms\)/);
  });
});

describe('renderStream - normal completion', () => {
  it('fires onHead, onShellReady and onAllReady exactly once, ends the sink and RESOLVES done', async () => {
    const { sink, text } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = renderer();

    const handle = renderStream(sink, cb, { message: 'hi' }, '/');
    await handle.done;

    expect(cb.onHead).toHaveBeenCalledTimes(1);
    expect(cb.onShellReady).toHaveBeenCalledTimes(1);
    expect(cb.onAllReady).toHaveBeenCalledTimes(1);
    expect(cb.onAllReady).toHaveBeenCalledWith({ message: 'hi' });
    expect(cb.onError).not.toHaveBeenCalled();
    expect(text()).toContain('solid');
    expect(sink.writableEnded).toBe(true);
  });

  it('resolves a PROMISE seed and seeds onAllReady with the resolved value', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = renderer();

    await renderStream(sink, cb, later({ message: 'async' }, 5), '/').done;

    expect(cb.onAllReady).toHaveBeenCalledWith({ message: 'async' });
  });

  it('invokes a lazy thunk EXACTLY ONCE', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const thunk = vi.fn(async () => ({ message: 'lazy' }));
    const { renderStream } = renderer();

    await renderStream(sink, cb, thunk, '/').done;

    expect(thunk).toHaveBeenCalledTimes(1);
    expect(cb.onAllReady).toHaveBeenCalledWith({ message: 'lazy' });
  });

  it('waits for BOTH latches - a post-shell resource keeps onAllReady pending until Solid completes', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = createRenderer({
      appComponent: () => appWithLateResource(() => later('late', 20)),
      headContent: () => '',
    });

    const handle = renderStream(sink, cb, { message: 'ready-immediately' }, '/');

    // Route data is ready from the start; Solid is not. The two-latch rule must hold onAllReady.
    await waitFor(() => cb.onShellReady.mock.calls.length > 0);
    expect(cb.onShellReady).toHaveBeenCalledTimes(1);
    expect(cb.onAllReady).not.toHaveBeenCalled(); // data latch satisfied, Solid latch is not

    await handle.done;
    expect(cb.onAllReady).toHaveBeenCalledTimes(1);
  });
});

describe('renderStream - the ruled error matrix', () => {
  it('#1 sync root throw: FATAL, rejects done, never commits the sink', async () => {
    const { sink, text } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = createRenderer({
      appComponent: () => {
        throw new Error('sync root throw');
      },
      headContent: () => '<title>t</title>',
    });

    const handle = renderStream(sink, cb, {}, '/');

    await expect(handle.done).rejects.toThrow('sync root throw');
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onAllReady).not.toHaveBeenCalled();
    expect(text()).toBe(''); // nothing was written
  });

  it('#8 onHead throw: FATAL, rejects done, never pipes into an unconsumed sink', async () => {
    const { sink, text } = makeSink();
    const cb = makeCallbacks();
    cb.onHead.mockImplementation(() => {
      throw new Error('onHead exploded');
    });
    const { renderStream } = renderer();

    const handle = renderStream(sink, cb, {}, '/');

    await expect(handle.done).rejects.toThrow('onHead exploded');
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(text()).toBe('');
  });

  it('#9 advisory-callback throw is ISOLATED: onShellReady throws, the response still completes', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    cb.onShellReady.mockImplementation(() => {
      throw new Error('advisory boom');
    });
    const { renderStream } = renderer();

    await expect(renderStream(sink, cb, { a: 1 }, '/').done).resolves.toBeUndefined();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onAllReady).toHaveBeenCalledTimes(1);
  });

  it('#9 a throwing onAllReady is isolated too - done still resolves', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    cb.onAllReady.mockImplementation(() => {
      throw new Error('onAllReady boom');
    });
    const { renderStream } = renderer();

    await expect(renderStream(sink, cb, { a: 1 }, '/').done).resolves.toBeUndefined();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('route-data rejection is a PRE-SHELL fatal: no head, no seed, done rejects', async () => {
    const { sink, text } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = renderer();

    const handle = renderStream(sink, cb, laterReject(new Error('loader failed'), 5), '/');

    await expect(handle.done).rejects.toThrow('loader failed');
    expect(cb.onHead).not.toHaveBeenCalled(); // the shell was never committed
    expect(cb.onAllReady).not.toHaveBeenCalled(); // and it never seeded {}
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(text()).toBe('');
  });

  it('a synchronously throwing lazy thunk is a PRE-SHELL fatal', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = renderer();

    const handle = renderStream(
      sink,
      cb,
      () => {
        throw new Error('thunk threw synchronously');
      },
      '/',
    );

    await expect(handle.done).rejects.toThrow('thunk threw synchronously');
    expect(cb.onHead).not.toHaveBeenCalled();
  });

  it('caller abort() is a benign cancel: done RESOLVES', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = createRenderer({
      appComponent: () => appWithLateResource(() => later('late', 200)),
      headContent: () => '',
    });

    const handle = renderStream(sink, cb, { a: 1 }, '/');
    await tick();
    handle.abort();

    await expect(handle.done).resolves.toBeUndefined();
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('an AbortSignal already aborted resolves done without rendering', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const appComponent = vi.fn(simpleApp);
    const { renderStream } = createRenderer({ appComponent, headContent: () => '' });

    const ac = new AbortController();
    ac.abort();

    await expect(renderStream(sink, cb, { a: 1 }, '/', undefined, {}, ac.signal).done).resolves.toBeUndefined();
    expect(appComponent).not.toHaveBeenCalled();
  });

  it('a route-data stall is bounded by completionTimeoutMs, NOT the shell timeout', async () => {
    // Design 2: the completion timer bounds the WHOLE lifecycle including route-data resolution;
    // the shell timer starts immediately before the Solid render. Charging a loader stall to the
    // shell budget would report a data fault as a shell fault - different faults, different
    // operator response. The shell timeout here is deliberately the SHORTER of the two: if the
    // shell timer were still armed during loader resolution (the pre-correction behaviour) it
    // would win this race and the assertion would name the wrong budget.
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = renderer({ streamOptions: { shellTimeoutMs: 20, completionTimeoutMs: 60 } });

    const handle = renderStream(sink, cb, new Promise<Data>(() => {}), '/');

    await expect(handle.done).rejects.toThrow(/completionTimeoutMs \(60ms\)/);
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onHead).not.toHaveBeenCalled();
  });

  it('a SLOW loader does not consume the shell budget (the timer is armed after readiness)', async () => {
    // Direct regression on the arming point: a loader slower than shellTimeoutMs must still
    // render normally, because the shell timer has not been armed yet while it resolves.
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = renderer({ streamOptions: { shellTimeoutMs: 25, completionTimeoutMs: 5_000 } });

    await expect(renderStream(sink, cb, later({ message: 'slow' }, 60), '/').done).resolves.toBeUndefined();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onAllReady).toHaveBeenCalledWith({ message: 'slow' });
  });

  // NOTE, recorded honestly rather than faked: a post-render SHELL stall is NOT reachable at the
  // pinned Solid. `onCompleteShell` fires after the synchronous render in every case probed -
  // including a never-settling resource both inside and outside a `Suspense` boundary. The shell
  // timer is therefore a defensive backstop (against a Solid behaviour change or a pathological
  // synchronous render), and what IS testable is its arming point, covered by the two tests above.

  it('completion timeout after a committed shell is FATAL: rejects done and NEVER ends the sink', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = createRenderer({
      appComponent: () => appWithLateResource(() => new Promise<string>(() => {})), // never settles
      headContent: () => '<title>t</title>',
      streamOptions: { shellTimeoutMs: 5_000, completionTimeoutMs: 40 },
    });

    const handle = renderStream(sink, cb, { a: 1 }, '/');

    await expect(handle.done).rejects.toThrow(/document is incomplete/);
    expect(cb.onShellReady).toHaveBeenCalledTimes(1); // the shell HAD committed
    // FATAL-EMPTY guard: ending here would let the host serialise __INITIAL_DATA__ and present a
    // truncated document as a success. The sink must be destroyed, not ended.
    expect(sink.writableEnded).toBe(false);
    expect(sink.destroyed).toBe(true);
  });
});

describe('renderStream - Solid never emits onRenderError (v6 ruling)', () => {
  it('a post-shell resource REJECTION completes normally with no callback', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = createRenderer({
      appComponent: () => appWithLateResource(() => laterReject(new Error('post-shell rejection'), 10)),
      headContent: () => '',
    });

    // Matrix #5/#6: degraded completion. Transport completed, so done RESOLVES.
    await expect(renderStream(sink, cb, { a: 1 }, '/').done).resolves.toBeUndefined();

    expect(cb.onRenderError).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
    expect(cb.onAllReady).toHaveBeenCalledTimes(1);
  });

  it('an ordinary RESOLVED Error value also completes normally with no callback', async () => {
    // The SEAM-proof's case 2: indistinguishable from the above at the seroval seam. Both must
    // therefore be silent - reporting either would report a render failure on a successful render.
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = createRenderer({
      appComponent: () => appWithLateResource(() => later(new Error('an ordinary value'), 10)),
      headContent: () => '',
    });

    await expect(renderStream(sink, cb, { a: 1 }, '/').done).resolves.toBeUndefined();

    expect(cb.onRenderError).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });
});

describe('renderStream - terminal guard + M1 detachment', () => {
  it('a late Solid settlement after a terminal resumes nothing', async () => {
    const { sink, text } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = createRenderer({
      appComponent: () => appWithLateResource(() => later('late', 60)),
      headContent: () => '',
    });

    const handle = renderStream(sink, cb, { a: 1 }, '/');
    await tick();
    handle.abort();
    await handle.done;

    const afterAbort = text().length;
    await new Promise((r) => setTimeout(r, 120)); // let the resource settle post-terminal

    expect(text().length).toBe(afterAbort); // nothing more was written
    expect(cb.onAllReady).not.toHaveBeenCalled(); // and no callback fired after the terminal
  });

  /**
   * REAL detachment evidence. The previous version of this test captured raw head data and checked
   * callbacks; it passed with `controller.setDetach(...)` deleted entirely, so it proved nothing.
   * This observes the store accessor the COMPONENT holds - the only thing that can distinguish a
   * released payload from a retained one.
   */
  describe('adapter detachment is observable through the component-facing accessor', () => {
    const captureStore = () => {
      let read: (() => unknown) | undefined;
      const appComponent = () => {
        const store = useSSRStore<Data>();
        read = () => store.data();
        return html('<div id="app">x</div>');
      };

      return { appComponent, readAfterwards: () => read };
    };

    const expectDetached = (read: (() => unknown) | undefined) => {
      expect(read, 'the component never ran, so this proves nothing').toBeDefined();
      expect(read!).toThrow(/released when the response terminated/);
    };

    it('after NORMAL completion', async () => {
      const { sink } = makeSink();
      const cb = makeCallbacks();
      const { appComponent, readAfterwards } = captureStore();
      const { renderStream } = createRenderer({ appComponent, headContent: () => '' });

      await renderStream(sink, cb, { secret: 'REQUEST-DATA' }, '/').done;

      expectDetached(readAfterwards());
    });

    it('after a caller ABORT', async () => {
      const { sink } = makeSink();
      const cb = makeCallbacks();
      let read: (() => unknown) | undefined;
      const { renderStream } = createRenderer({
        appComponent: () => {
          const store = useSSRStore<Data>();
          read = () => store.data();
          return appWithLateResource(() => later('late', 300));
        },
        headContent: () => '',
      });

      const handle = renderStream(sink, cb, { secret: 'REQUEST-DATA' }, '/');
      await waitFor(() => read !== undefined);
      handle.abort();
      await handle.done;

      expectDetached(read);
    });

    it('after a completion TIMEOUT', async () => {
      const { sink } = makeSink();
      const cb = makeCallbacks();
      let read: (() => unknown) | undefined;
      const { renderStream } = createRenderer({
        appComponent: () => {
          const store = useSSRStore<Data>();
          read = () => store.data();
          return appWithLateResource(() => new Promise<string>(() => {}));
        },
        headContent: () => '',
        streamOptions: { shellTimeoutMs: 5_000, completionTimeoutMs: 40 },
      });

      await expect(renderStream(sink, cb, { secret: 'REQUEST-DATA' }, '/').done).rejects.toThrow();

      expectDetached(read);
    });

    it('after an R3 serialisation FATAL', async () => {
      const { sink } = makeSink();
      const cb = makeCallbacks();
      let read: (() => unknown) | undefined;
      const { renderStream } = createRenderer({
        appComponent: () => {
          const store = useSSRStore<Data>();
          read = () => store.data();
          return appWithLateResource(() => later({ s: Symbol('unserialisable') }, 10));
        },
        headContent: () => '',
      });

      await expect(renderStream(sink, cb, { secret: 'REQUEST-DATA' }, '/').done).rejects.toThrow(/seroval|serializ/i);

      expectDetached(read);
    });
  });
});

describe('renderStream - onHead commits the response at the SHELL, not before the render', () => {
  /**
   * A host-realistic `onHead`: in the real host it writes the 200 response head and connects the
   * stream, so once it has run the response IS committed. A spy that writes nothing hides
   * premature commits entirely - which is how the earlier ordering defect passed its tests.
   */
  const makeHost = () => {
    const events: string[] = [];
    const { sink, text } = makeSink();
    sink.on('data', () => events.push('body-write'));

    return {
      sink,
      text,
      events,
      committed: () => events.includes('commit'),
      onHead: vi.fn(() => {
        events.push('commit');
      }),
    };
  };

  it('commits BEFORE any body byte reaches the sink', async () => {
    const host = makeHost();
    const cb = { ...makeCallbacks(), onHead: host.onHead };
    const { renderStream } = renderer();

    await renderStream(host.sink, cb, { a: 1 }, '/').done;

    expect(host.committed()).toBe(true);
    expect(host.events[0]).toBe('commit'); // the head precedes every body write
  });

  it('a SYNC ROOT THROW never commits the response', async () => {
    const host = makeHost();
    const cb = { ...makeCallbacks(), onHead: host.onHead };
    const { renderStream } = createRenderer({
      appComponent: () => {
        throw new Error('sync root throw');
      },
      headContent: () => '<title>t</title>',
    });

    await expect(renderStream(host.sink, cb, { a: 1 }, '/').done).rejects.toThrow('sync root throw');

    // The whole point of the correction: previously onHead ran before renderToStream, so a 200 was
    // already committed for a response that then failed pre-shell.
    expect(host.onHead).not.toHaveBeenCalled();
    expect(host.committed()).toBe(false);
    expect(host.text()).toBe('');
  });

  it('an R3 serialisation failure that fires BEFORE the shell never commits the response', async () => {
    const host = makeHost();
    const cb = { ...makeCallbacks(), onHead: host.onHead };
    const { renderStream } = createRenderer({
      appComponent: () => appWithLateResource(() => Promise.resolve({ fn: () => {} })),
      headContent: () => '<title>t</title>',
    });

    await expect(renderStream(host.sink, cb, { a: 1 }, '/').done).rejects.toThrow(/seroval|serializ/i);

    expect(host.onHead).not.toHaveBeenCalled();
    expect(host.committed()).toBe(false);
  });

  it('a throwing onHead leaves the shell UNMARKED, so the fatal stays pre-shell', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    cb.onHead.mockImplementation(() => {
      throw new Error('onHead exploded');
    });
    const { renderStream } = renderer();

    await expect(renderStream(sink, cb, { a: 1 }, '/').done).rejects.toThrow('onHead exploded');
    expect(cb.onShellReady).not.toHaveBeenCalled(); // never marked committed
  });
});

describe('renderStream - every adapter-owned sink op is inert after a terminal', () => {
  it('a SYNCHRONOUSLY throwing write is FATAL and does not escape into Solid', async () => {
    const { sink } = makeSink();
    const cb = makeCallbacks();
    const { renderStream } = renderer();

    // Render-origin by construction: Solid is mid-render and called us.
    vi.spyOn(sink, 'write').mockImplementation(() => {
      throw new Error('synchronous write failure');
    });

    await expect(renderStream(sink, cb, { a: 1 }, '/').done).rejects.toThrow('synchronous write failure');
    expect(cb.onError).toHaveBeenCalledTimes(1);
  });
});

describe('renderSSR - a mid-render abort is terminal (not deferred to the prerender deadline)', () => {
  it('settles promptly and detaches, well inside prerenderTimeoutMs', async () => {
    const { renderSSR } = createRenderer({
      appComponent: () =>
        createComponent(Suspense, {
          fallback: html('<p>f</p>'),
          get children() {
            const [d] = createResource(() => new Promise<string>(() => {})); // never settles
            return html(`<p>${String(d() ?? '')}</p>`);
          },
        }) as never,
      headContent: () => '',
      ssrOptions: { prerenderTimeoutMs: 5_000 }, // deliberately far longer than the abort
    });

    const ac = new AbortController();
    const started = Date.now();
    const pending = renderSSR({ a: 1 }, '/', {}, ac.signal);

    setTimeout(() => ac.abort(), 20);
    const out = await pending;

    // Previously this waited for the 5s prerender deadline, holding the request and the holder.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).toEqual({ headContent: '', appHtml: '' });
  });

  it('an abandoned render that later REJECTS raises no unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);

    try {
      let boom!: (e: unknown) => void;
      const { renderSSR } = createRenderer({
        appComponent: () =>
          createComponent(Suspense, {
            fallback: html('<p>f</p>'),
            get children() {
              const [d] = createResource(() => new Promise<string>((_, reject) => (boom = reject)));
              return html(`<p>${String(d() ?? '')}</p>`);
            },
          }) as never,
        headContent: () => '',
        ssrOptions: { prerenderTimeoutMs: 5_000 },
      });

      const ac = new AbortController();
      const pending = renderSSR({ a: 1 }, '/', {}, ac.signal);
      setTimeout(() => ac.abort(), 10);
      await pending;

      boom(new Error('abandoned render failed later'));
      await tick();
      await tick();

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('createRenderer - timeout option validation', () => {
  const cases: Array<[string, unknown]> = [
    ['negative', -1],
    ['NaN', Number.NaN],
    ['-Infinity', -Infinity],
    ['a string', '5000'],
    ['null', null],
  ];

  for (const [label, value] of cases) {
    it(`rejects shellTimeoutMs = ${label} rather than silently disabling the watchdog`, () => {
      expect(() => renderer({ streamOptions: { shellTimeoutMs: value as number } })).toThrow(TypeError);
    });
  }

  it('rejects an invalid completionTimeoutMs and prerenderTimeoutMs', () => {
    expect(() => renderer({ streamOptions: { completionTimeoutMs: -5 } })).toThrow(/completionTimeoutMs/);
    expect(() => renderer({ ssrOptions: { prerenderTimeoutMs: Number.NaN } })).toThrow(/prerenderTimeoutMs/);
  });

  it('accepts the documented 0 / Infinity sentinels and ordinary positive values', () => {
    expect(() => renderer({ streamOptions: { shellTimeoutMs: 0, completionTimeoutMs: Infinity } })).not.toThrow();
    expect(() => renderer({ ssrOptions: { prerenderTimeoutMs: 1 } })).not.toThrow();
  });
});

/**
 * Design 4 (R1) - the exact four-cell hydration/CSP table.
 *
 * SCOPE, stated so these are not over-read: these establish RENDERER OUTPUT and host wiring. They
 * do NOT establish browser hydration - no script here is executed, no `_$HY` runtime runs, no
 * event is captured or replayed. The real-browser D2 proof (design 7.3) remains an
 * acceptance-stage requirement and is not discharged by anything below.
 */
describe('design 4 - the four-cell hydration/CSP table (renderer output)', () => {
  const NONCE = 'N0NCE-123';
  const CLIENT_ENTRY = '/assets/entry-client.js';

  const scriptsIn = (markup: string) => markup.match(/<script\b[^>]*>/g) ?? [];
  const everyScriptNonced = (markup: string) => scriptsIn(markup).every((tag) => tag.includes(`nonce="${NONCE}"`));

  /**
   * Count Solid's bootstrap DEFINITION across the COMPLETE renderer output, never one half of it.
   * Counting only `headContent` (or only the streamed head) leaves a duplicate definition emitted
   * into `appHtml` or the streaming body completely invisible - verified: injecting a second
   * `generateHydrationScript()` into the streamed body passed the whole suite before this change.
   */
  const countBootstrap = (completeOutput: string) => (completeOutput.match(/window\._\$HY\|\|/g) ?? []).length;

  const appWithResource = () => appWithLateResource(() => later('resource-value', 5));

  // ---- cell 1: ssr + shouldHydrate:true --------------------------------------------------------
  describe('ssr + hydrate:true', () => {
    const render = () =>
      createRenderer({ appComponent: appWithResource, headContent: () => '<title>t</title>' }).renderSSR({ a: 1 }, '/', {}, undefined, {
        cspNonce: NONCE,
        shouldHydrate: true,
      });

    it("emits Solid's bootstrap EXACTLY ONCE across the whole renderer output", async () => {
      const { headContent, appHtml } = await render();

      expect(countBootstrap(headContent + appHtml)).toBe(1);
      expect(countBootstrap(headContent)).toBe(1); // ...and it is the HEAD that carries it
      expect(headContent.startsWith('<title>t</title>')).toBe(true); // the app's head comes first
    });

    it("nonces the bootstrap AND Solid's own resource scripts", async () => {
      const { headContent, appHtml } = await render();

      expect(everyScriptNonced(headContent)).toBe(true);
      expect(scriptsIn(appHtml).length).toBeGreaterThan(0); // Solid emitted resource scripts
      expect(everyScriptNonced(appHtml)).toBe(true);
    });

    it('does NOT emit the host client entry - on ssr the HOST owns that tag', async () => {
      const { headContent, appHtml } = await render();

      expect(headContent + appHtml).not.toContain('type="module"');
    });
  });

  // ---- cell 2: ssr + shouldHydrate:false -------------------------------------------------------
  describe('ssr + hydrate:false', () => {
    it('the RENDERER OUTPUT is script-free: no $R, no _$HY, no $df, no bootstrap', async () => {
      // Precise claim: this is the SOLID RENDERER's output. It is NOT a claim about the complete
      // τjs document, which still legitimately carries the host-owned, nonced `__INITIAL_DATA__`
      // assignment - the snapshot bridge's single data authority, which is unrelated to hydration
      // policy. See the complete-document test below for what must be absent from the response.
      const { headContent, appHtml } = await createRenderer({
        appComponent: appWithResource,
        headContent: () => '<title>t</title>',
      }).renderSSR({ a: 1 }, '/', {}, undefined, { cspNonce: NONCE, shouldHydrate: false });

      const rendererOutput = headContent + appHtml;

      expect(countBootstrap(rendererOutput)).toBe(0);
      expect(rendererOutput).not.toContain('$R');
      expect(rendererOutput).not.toContain('_$HY');
      expect(rendererOutput).not.toContain('$df');
      expect(scriptsIn(rendererOutput)).toEqual([]);
      // ...and the actual content still rendered
      expect(appHtml).toContain('resource-value');
    });

    it('the COMPLETE document keeps the host snapshot script but no hydration machinery', async () => {
      // What must be absent from the complete response is the HOST CLIENT ENTRY and Solid's
      // `$R`/`_$HY`/`$df` machinery - not every `<script>`. The host's `__INITIAL_DATA__`
      // assignment stays, nonced, because route data is still delivered under `hydrate:false`.
      const { headContent, appHtml } = await createRenderer({
        appComponent: appWithResource,
        headContent: () => '<title>t</title>',
      }).renderSSR({ message: 'route-data' }, '/', {}, undefined, { cspNonce: NONCE, shouldHydrate: false });

      // Compose the document the way HandleRender.ts does on the `ssr` path: renderer output, the
      // host's inline snapshot script, and (gated off here) the host client entry.
      const hostSnapshotScript = `<script nonce="${NONCE}">window.__INITIAL_DATA__ = {"message":"route-data"};</script>`;
      const completeDocument = `<!doctype html><html><head>${headContent}</head><body>${appHtml}${hostSnapshotScript}</body></html>`;

      // present: the host's data authority, nonced
      expect(completeDocument).toContain('window.__INITIAL_DATA__');
      expect(everyScriptNonced(completeDocument)).toBe(true);

      // absent: the client entry and every piece of Solid hydration machinery
      expect(completeDocument).not.toContain('type="module"');
      expect(countBootstrap(completeDocument)).toBe(0);
      expect(completeDocument).not.toContain('_$HY');
      expect(completeDocument).not.toContain('$df');
      expect(completeDocument).not.toMatch(/\$R\b/);
    });

    it('emits no orphaned _$HY.r writes (the pre-v6 contradiction)', async () => {
      // The defect the v6 ruling fixed: a resource emits `_$HY.r[...]` regardless of hydration
      // policy, so omitting the bootstrap WITHOUT `noScripts` produced a ReferenceError in the
      // browser before hydration was even attempted.
      const { appHtml } = await createRenderer({
        appComponent: appWithResource,
        headContent: () => '',
      }).renderSSR({ a: 1 }, '/', {}, undefined, { shouldHydrate: false });

      expect(appHtml).not.toMatch(/_\$HY\.r/);
    });
  });

  // ---- cells 3 + 4: streaming ------------------------------------------------------------------
  const streamCell = async (shouldHydrate: boolean, opts: { bootstrapModules?: string } = {}) => {
    const { sink, text } = makeSink();
    const cb = makeCallbacks();
    let head = '';
    cb.onHead.mockImplementation((h: string) => {
      head = h;
    });

    const { renderStream } = createRenderer({ appComponent: appWithResource, headContent: () => '<title>t</title>' });
    await renderStream(sink, cb, { a: 1 }, '/', opts.bootstrapModules ?? CLIENT_ENTRY, {}, undefined, { cspNonce: NONCE, shouldHydrate }).done;

    return { head, body: text() };
  };

  describe('streaming + hydrate:true', () => {
    it('emits the client entry, the bootstrap exactly once, and patch scripts - all nonced', async () => {
      const { head, body } = await streamCell(true);

      expect(countBootstrap(head + body)).toBe(1); // across the WHOLE response, not just the head
      expect(body).toContain(`src="${CLIENT_ENTRY}"`);
      expect(body).toContain('type="module"');
      expect(body).toMatch(/\$df|_\$HY\.r|\$R/); // deferred patch machinery retained
      expect(everyScriptNonced(head)).toBe(true);
      expect(everyScriptNonced(body)).toBe(true);
    });
  });

  describe('streaming + hydrate:false', () => {
    it('omits the client entry but RETAINS the nonced bootstrap and patch machinery', async () => {
      const { head, body } = await streamCell(false);

      // No application hydration can run - so no beacon can fire either.
      expect(body).not.toContain('type="module"');
      expect(body).not.toContain(CLIENT_ENTRY);

      // ...but the deferred patches still need `_$HY`, so it stays, nonced - exactly once across
      // the whole response.
      expect(countBootstrap(head + body)).toBe(1);
      expect(body).toMatch(/\$df|_\$HY\.r|\$R/);
      expect(everyScriptNonced(head)).toBe(true);
      expect(everyScriptNonced(body)).toBe(true);
    });

    it('never uses noScripts on the streaming path (it would suppress the patches)', async () => {
      const { body } = await streamCell(false);

      // If `noScripts` leaked onto this path the response itself would break: the placeholder
      // content would never be replaced.
      expect(body).toMatch(/\$R|_\$HY\.r/);
      expect(body).toContain('resource-value');
    });

    it('emits no client entry even if the host still passed bootstrapModules', async () => {
      // Defence in depth: the host already gates this (HandleRender.ts:663), but the renderer
      // executes the ruled policy rather than inferring intent from the argument's presence.
      const { body } = await streamCell(false, { bootstrapModules: CLIENT_ENTRY });

      expect(body).not.toContain(CLIENT_ENTRY);
    });
  });

  describe('nonce handling', () => {
    it('omits nonce attributes entirely when the host supplies none', async () => {
      const { head, body } = await (async () => {
        const { sink, text } = makeSink();
        const cb = makeCallbacks();
        let h = '';
        cb.onHead.mockImplementation((v: string) => {
          h = v;
        });
        const { renderStream } = createRenderer({ appComponent: appWithResource, headContent: () => '' });
        await renderStream(sink, cb, { a: 1 }, '/', CLIENT_ENTRY, {}, undefined, { shouldHydrate: true }).done;

        return { head: h, body: text() };
      })();

      expect(head).not.toContain('nonce=');
      expect(body).not.toContain('nonce=');
      expect(head).toContain('_$HY'); // still emitted, just un-nonced
    });

    it('escapes a hostile client-entry src into the emitted attribute', async () => {
      const { body } = await streamCell(true, { bootstrapModules: '/a.js" onload="alert(1)' });

      expect(body).not.toContain('onload="alert(1)"');
      expect(body).toContain('&quot;');
    });
  });

  it('adds no nonce-bearing public API: HeadContext carries no nonce', async () => {
    let seen: Record<string, unknown> | undefined;
    await createRenderer({
      appComponent: simpleApp,
      headContent: (ctx) => {
        seen = ctx as unknown as Record<string, unknown>;
        return '';
      },
    }).renderSSR({ a: 1 }, '/', {}, undefined, { cspNonce: NONCE, shouldHydrate: true });

    expect(Object.keys(seen ?? {}).sort()).toEqual(['data', 'headData', 'meta', 'routeContext']);
    expect(JSON.stringify(seen)).not.toContain(NONCE);
  });
});
