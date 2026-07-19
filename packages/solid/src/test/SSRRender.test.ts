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
const later = <T,>(value: T, ms = 10) => new Promise<T>((r) => setTimeout(() => r(value), ms));
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

    expect(out.headContent).toBe('<title>hello</title>');
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
