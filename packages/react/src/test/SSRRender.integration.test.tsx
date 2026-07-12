// @vitest-environment node
import { PassThrough } from 'node:stream';

import React, { Suspense } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';

import { createRenderer } from '../SSRRender';
import type { RenderErrorInfo } from '../SSRRender';
import { useSSRStore } from '../SSRDataStore';

// R1-01 / T1a — REAL react-dom/server, REAL PassThrough. Mocked-React tests cannot catch the
// R2/R3 class because those live in the interaction with React's actual stream-end + error timing.
//
// These repros are FAILING-FIRST against the pre-rework renderer (documented in the report); they
// go green once the bounded end-gate + onRenderError policy land.

type Data = { value?: number };

// Collect the streamed bytes AND simulate the server's `finish` handler: it appends
// `window.__INITIAL_DATA__ = finalData ?? {}` when the writable finishes (HandleRender.ts).
function driveServerSide() {
  const writable = new PassThrough();
  const chunks: string[] = [];
  writable.on('data', (c) => chunks.push(c.toString()));

  const state: { finalData: unknown; finishData: unknown; finished: boolean } = {
    finalData: undefined,
    finishData: undefined,
    finished: false,
  };

  writable.on('finish', () => {
    state.finishData = state.finalData ?? {};
    state.finished = true;
  });

  return { writable, chunks, state };
}

const settle = (ms = 120) => new Promise<void>((r) => setTimeout(r, ms));

// ── React behaviour FACTS (pure react-dom/server) ────────────────────────────────────────────
// The R3 policy (post-shell errors are recoverable; timing does not prove recoverability) rests on
// how React's own `renderToPipeableStream` sequences onShellReady / onShellError / onError / finish.
// These probes drive React DIRECTLY (no τjs renderer) and record the observed order — if any
// contradicts the R1-01 ground truth, that's an escalation, not an implementation detail.
describe('React behaviour facts (pure react-dom/server)', () => {
  const driveReact = (element: React.ReactElement) =>
    new Promise<{ events: string[]; errors: string[]; finished: boolean }>((resolve) => {
      const writable = new PassThrough();
      const events: string[] = [];
      const errors: string[] = [];
      let finished = false;
      writable.on('finish', () => {
        finished = true;
      });

      const done = () => resolve({ events, errors, finished });

      const { pipe } = renderToPipeableStream(element, {
        onShellReady() {
          events.push('shellReady');
          pipe(writable);
        },
        onShellError() {
          events.push('shellError');
          done();
        },
        onAllReady() {
          events.push('allReady');
        },
        onError(err) {
          events.push('error');
          errors.push(String((err as Error)?.message ?? err));
        },
      });

      writable.on('finish', done);
      setTimeout(done, 1500); // safety net
    });

  it('POST-SHELL boundary error → onError fires, NOT onShellError; shell commits and the stream still COMPLETES', async () => {
    let resolved = false;
    const gate = new Promise<void>((r) =>
      setTimeout(() => {
        resolved = true;
        r();
      }, 30),
    );
    const PostShellThrower = () => {
      if (!resolved) throw gate; // suspend past the shell
      throw new Error('post-shell boom'); // then throw (post-shell)
    };

    const { events, errors, finished } = await driveReact(
      <div>
        <p>shell</p>
        <Suspense fallback={<span>loading</span>}>
          <PostShellThrower />
        </Suspense>
      </div>,
    );

    expect(events).toContain('shellReady');
    expect(events).toContain('error');
    expect(events).not.toContain('shellError');
    expect(finished).toBe(true); // React completed the stream despite the post-shell error
    expect(errors).toContain('post-shell boom');
  });

  it('PRE-SHELL error inside a boundary whose fallback ships in the shell → onError (pre-shell), shell still commits', async () => {
    const PreShellThrower = () => {
      throw new Error('pre-shell recoverable'); // synchronous throw during shell render
    };

    const { events, errors, finished } = await driveReact(
      <div>
        <p>shell</p>
        <Suspense fallback={<span>fallback</span>}>
          <PreShellThrower />
        </Suspense>
      </div>,
    );

    // error observed; shell still commits (fallback in shell); no shellError; stream completes.
    expect(events).toContain('error');
    expect(events).toContain('shellReady');
    expect(events).not.toContain('shellError');
    expect(finished).toBe(true);
    expect(errors).toContain('pre-shell recoverable');
  });

  it('PRE-SHELL error OUTSIDE any boundary → onShellError (fatal), shell does NOT commit', async () => {
    const FatalNoBoundary = () => {
      throw new Error('pre-shell fatal');
    };

    const { events, errors } = await driveReact(
      <div>
        <FatalNoBoundary />
      </div>,
    );

    expect(events).toContain('shellError');
    expect(events).not.toContain('shellReady');
    // React reports the error via BOTH onError and onShellError.
    expect(errors).toContain('pre-shell fatal');
  });
});

describe('R1-01 integration (real react-dom/server)', () => {
  it('R2: late-resolving data with NO store consumer — finish must serialize the RESOLVED data, not {}', async () => {
    const { writable, state } = driveServerSide();

    // App that never reads the store, so nothing suspends → React ends the shell immediately.
    const AppNoConsumer = () => <div>no consumer</div>;

    const { renderStream } = createRenderer<Data>({
      appComponent: () => <AppNoConsumer />,
      headContent: () => '<title>x</title>',
    });

    const { done } = renderStream(
      writable,
      { onAllReady: (d) => (state.finalData = d) },
      () => new Promise<Data>((r) => setTimeout(() => r({ value: 42 }), 40)), // resolves AFTER the shell
      '/no-consumer',
    );

    await done.catch(() => {});
    await settle();

    // Pre-rework: the pipe ends before the thunk resolves → finishData === {} (silent data loss).
    // Post-rework (bounded end-gate): end is deferred until readiness → the resolved data is present.
    expect(state.finished).toBe(true);
    expect(state.finishData).toEqual({ value: 42 });
  });

  it('control: a suspending consumer already serializes resolved data today (should pass pre- and post-rework)', async () => {
    const { writable, state } = driveServerSide();

    // App that READS the store → suspends until data resolves → React defers stream end already.
    const AppConsumer = () => {
      const data = useSSRStore<Data>();
      return <div>{String(data.value)}</div>;
    };

    const { renderStream } = createRenderer<Data>({
      appComponent: () => (
        <Suspense fallback={<div>loading</div>}>
          <AppConsumer />
        </Suspense>
      ),
      headContent: () => '<title>x</title>',
    });

    const { done } = renderStream(
      writable,
      { onAllReady: (d) => (state.finalData = d) },
      () => new Promise<Data>((r) => setTimeout(() => r({ value: 42 }), 40)),
      '/consumer',
    );

    await done.catch(() => {});
    await settle();

    expect(state.finishData).toEqual({ value: 42 });
  });

  it('THROW/SUSPENSE INTACT: a component reading the store SUSPENDS (fallback in the shell), then the resolved content streams out-of-order', async () => {
    const { writable, chunks, state } = driveServerSide();

    // getServerSnapshot throws serverDataPromise while pending → this component SUSPENDS. The
    // refactor left that throw untouched and the end-gate waits on the SAME serverDataPromise.
    const Consumer = () => {
      const data = useSSRStore<Data>();
      return <div>value:{String(data.value)}</div>;
    };
    const App = () => (
      <div>
        <p>shell</p>
        <Suspense fallback={<span>loading-fallback</span>}>
          <Consumer />
        </Suspense>
      </div>
    );

    const { done } = createRenderer<Data>({ appComponent: () => <App />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {}, onAllReady: (d) => (state.finalData = d) },
      () => new Promise<Data>((r) => setTimeout(() => r({ value: 42 }), 40)),
      '/suspends',
    );

    await done.catch(() => {});
    await settle();

    // React splits adjacent text with a `<!-- -->` marker (`value:<!-- -->42`), so strip HTML
    // comments before matching the resolved text.
    const html = chunks.join('');
    const text = html.replace(/<!--.*?-->/g, '');
    // React suspended on the store's throw (`<!--$?-->` pending boundary, NOT `<!--$!-->` error) →
    // the shell carried the FALLBACK, and the resolved content streamed out-of-order once the data
    // settled. The throw-a-promise + Suspense + streaming path is intact and the data serialized.
    expect(html).toContain('<!--$?-->'); // React suspended (pending), did NOT error the boundary
    expect(html).not.toContain('server rendering errored'); // no client-render fallback
    expect(html).toContain('loading-fallback'); // fallback shipped in the shell (component suspended)
    expect(text).toContain('value:42'); // resolved content streamed after the suspension resolved
    expect(state.finishData).toEqual({ value: 42 });
  });

  it('R3 post-shell: a boundary error AFTER the shell → done RESOLVES, onRenderError {post-shell, recoverable:true}, NO fatal onError', async () => {
    const { writable, state } = driveServerSide();
    const onError = vi.fn();
    const renderErrors: RenderErrorInfo[] = [];

    let resolved = false;
    const gate = new Promise<void>((r) =>
      setTimeout(() => {
        resolved = true;
        r();
      }, 30),
    );
    const PostShellThrower = () => {
      if (!resolved) throw gate; // suspend past the shell
      throw new Error('post-shell boom'); // then throw (post-shell)
    };
    const App = () => (
      <div>
        <p>shell</p>
        <Suspense fallback={<span>loading</span>}>
          <PostShellThrower />
        </Suspense>
      </div>
    );

    const { done } = createRenderer<Data>({ appComponent: () => <App />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onAllReady: (d) => (state.finalData = d), onError, onRenderError: (i) => renderErrors.push(i) },
      { value: 1 }, // resolved data → the end-gate is immediate; isolates the R3 behaviour
      '/post-shell',
    );

    // Pre-rework: the renderer fatal-aborts on the post-shell onError → done REJECTS (over-abort).
    // Post-rework: React recovers the boundary client-side; done RESOLVES, no fatal, onRenderError fired.
    await expect(done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(renderErrors).toContainEqual(expect.objectContaining({ phase: 'post-shell', recoverable: true }));
  });

  it('R3 pre-shell recoverable: fallback-in-shell boundary error → onRenderError {pre-shell, unknown}, shell commits, done RESOLVES', async () => {
    const { writable, state } = driveServerSide();
    const onError = vi.fn();
    const renderErrors: RenderErrorInfo[] = [];

    const PreShellThrower = () => {
      throw new Error('pre-shell recoverable'); // synchronous throw; boundary fallback is in the shell
    };
    const App = () => (
      <div>
        <p>shell</p>
        <Suspense fallback={<span>fallback</span>}>
          <PreShellThrower />
        </Suspense>
      </div>
    );

    const { done } = createRenderer<Data>({ appComponent: () => <App />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onAllReady: (d) => (state.finalData = d), onError, onRenderError: (i) => renderErrors.push(i) },
      { value: 1 },
      '/pre-shell-recoverable',
    );

    await expect(done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(renderErrors).toContainEqual(expect.objectContaining({ phase: 'pre-shell', recoverable: 'unknown' }));
  });

  it('R3 pre-shell fatal: error OUTSIDE any boundary → done REJECTS from onShellError; onRenderError fired {pre-shell} but was NOT the fatal source', async () => {
    const { writable } = driveServerSide();
    const onError = vi.fn();
    const renderErrors: RenderErrorInfo[] = [];

    const FatalNoBoundary = () => {
      throw new Error('pre-shell fatal');
    };

    const { done } = createRenderer<Data>({
      appComponent: () => (
        <div>
          <FatalNoBoundary />
        </div>
      ),
      headContent: () => '<title>x</title>',
    }).renderStream(writable, { onError, onRenderError: (i) => renderErrors.push(i) }, { value: 1 }, '/pre-shell-fatal');

    await expect(done).rejects.toThrow('pre-shell fatal');
    // the advisory channel still observed it as pre-shell (fails today: onRenderError not wired)
    expect(renderErrors).toContainEqual(expect.objectContaining({ phase: 'pre-shell' }));
    // fatal came via the fatal onError (onShellError → fail), exactly once
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('bounded gate: no consumer + never-settling data + small dataTimeoutMs → done REJECTS, writable destroyed (fails today: ends early with data loss)', async () => {
    const { writable } = driveServerSide();
    const AppNoConsumer = () => <div>no consumer</div>;

    const { done } = createRenderer<Data>({ appComponent: () => <AppNoConsumer />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {} },
      () => new Promise<Data>(() => {}), // never resolves
      '/never-settles',
      undefined,
      undefined,
      undefined,
      undefined,
      { dataTimeoutMs: 60 }, // small → the end-gate must fail deterministically
    );

    await expect(done).rejects.toThrow();
    await settle();
    expect(writable.destroyed).toBe(true);
  });

  it('store data error: rejecting loader → end-gate observes store.status "error" → done REJECTS with the loader error, no silent empty finish', async () => {
    const { writable, state } = driveServerSide();
    const boom = new Error('loader exploded');
    const AppNoConsumer = () => <div>no consumer</div>;

    // No store consumer → React finishes immediately and ends the gate; the gate then races the
    // (rejecting) data promise. The store swallows the rejection into status:'error', so readiness
    // RESOLVES and the gate must read the error status and fatal-abort — rather than end() the
    // response with empty data (the R2 silent-data-loss class).
    const { done } = createRenderer<Data>({ appComponent: () => <AppNoConsumer />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {} },
      () => Promise.reject(boom),
      '/store-error',
      undefined,
      undefined,
      undefined,
      undefined,
      { dataTimeoutMs: 5_000 },
    );

    await expect(done).rejects.toThrow('loader exploded');
    await settle();
    // The gate fatal-aborted; it did NOT let the writable finish with `{}` serialized as data.
    expect(state.finished).toBe(false);
  });

  it('onHead throws → done REJECTS (fatal, required callback) and NOTHING is piped (fails today: warns and continues)', async () => {
    const { writable, chunks } = driveServerSide();

    const { done } = createRenderer<Data>({ appComponent: () => <div>app-body</div>, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      {
        onHead: () => {
          throw new Error('onHead boom');
        },
      },
      { value: 1 },
      '/onhead-throws',
    );

    await expect(done).rejects.toThrow('onHead boom');
    expect(chunks.join('')).not.toContain('app-body');
  });

  // Gate-review finding 1 (HIGH): a <Suspense> store consumer whose data NEVER settles keeps React's
  // stream open, so React never calls the sink's end(). The route-data deadline must fire ANYWAY —
  // it is armed at shell commit, independent of end(). (Before the fix, the timer lived only in the
  // end path, so this leaked the request/render/writable/loader indefinitely.)
  it('bounded liveness: a suspending store consumer whose data NEVER settles → fallback shell ships, done REJECTS with the data-timeout error, writable torn down', async () => {
    const { writable, chunks, state } = driveServerSide();
    const onAllReady = vi.fn();

    const Consumer = () => {
      const data = useSSRStore<Data>();
      return <div>value:{String(data.value)}</div>;
    };
    const App = () => (
      <div>
        <p>shell</p>
        <Suspense fallback={<span>loading-fallback</span>}>
          <Consumer />
        </Suspense>
      </div>
    );

    const { done } = createRenderer<Data>({ appComponent: () => <App />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {}, onAllReady },
      () => new Promise<Data>(() => {}), // NEVER settles; the consumer suspends on it forever
      '/never-settles-consumer',
      undefined,
      undefined,
      undefined,
      undefined,
      { dataTimeoutMs: 80 },
    );

    await expect(done).rejects.toThrow(/Route data not ready/); // bounded despite React never ending
    // The fallback shell WAS streamed before the deadline fired (React committed the shell).
    expect(chunks.join('')).toContain('loading-fallback');
    expect(onAllReady).not.toHaveBeenCalled();
    await settle(40);
    expect(writable.destroyed).toBe(true); // React + writable torn down, not leaked
    expect(state.finished).toBe(false);
  });

  // Gate-review finding 2 (HIGH): the host onError may synchronously abort the SAME AbortSignal wired
  // to the renderer's benign-cancel path (the server calls ac.abort() inside onError). A fatal must
  // still REJECT done — the re-entrant benign abort must not win the one-shot controller and downgrade
  // it to a benign resolve. (Before the fix, failFatal called onError before claiming fatal, so the
  // re-entrant benignAbort resolved done and the contract-mandated rejection was lost.)
  it('re-entrant abort: a fatal whose onError aborts the passed signal still REJECTS done (no benign downgrade), onError once', async () => {
    const { writable } = driveServerSide();
    const ac = new AbortController();
    const original = new Error('reentrant-fatal-original');
    const onError = vi.fn(() => ac.abort()); // aborts the very signal wired to controller.benignAbort

    const FatalNoBoundary = () => {
      throw original; // synchronous throw OUTSIDE any boundary → onShellError → failFatal(original)
    };

    const { done } = createRenderer<Data>({ appComponent: () => <FatalNoBoundary />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {}, onError },
      { value: 1 },
      '/reentrant-abort',
      undefined,
      undefined,
      undefined,
      ac.signal, // the signal onError will abort re-entrantly
    );

    await expect(done).rejects.toThrow('reentrant-fatal-original'); // rejected, NOT benign-resolved
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // Recheck finding (MEDIUM): the data deadline must be torn down by CONTROLLER cleanup, not by the
  // writable's 'close' event — a writable created with `emitClose: false` is destroyed WITHOUT emitting
  // 'close'. On abort with pending data, the deadline's timer + 'close' listener must be released
  // promptly (without waiting out dataTimeoutMs), not retained. (React keeps its OWN 'close' listener
  // on the piped destination, so we isolate the DEADLINE's listener via an once() spy rather than a
  // raw count.)
  it("emitClose:false writable: controller cleanup disarms the data deadline (its 'close' listener is removed without a 'close' event)", async () => {
    const writable = new PassThrough({ emitClose: false }); // destroy() will NOT emit 'close'
    const onError = vi.fn();
    const onAllReady = vi.fn();

    // Both the writable guards and the deadline register `once('close', …)`; the deadline's is LAST
    // (armed at shell commit, after guards). Capture the last close-once handler = the deadline disarm.
    let deadlineClose: ((...a: unknown[]) => void) | undefined;
    const realOnce = writable.once.bind(writable);
    vi.spyOn(writable, 'once').mockImplementation(((event: string, handler: (...a: unknown[]) => void) => {
      if (event === 'close') deadlineClose = handler;
      return realOnce(event as never, handler);
    }) as never);

    const AppNoConsumer = () => <div>no consumer</div>;
    const { done, abort } = createRenderer<Data>({ appComponent: () => <AppNoConsumer />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {}, onError, onAllReady },
      () => new Promise<Data>(() => {}), // never settles → deadline armed at shell commit
      '/emit-close-false',
      undefined,
      undefined,
      undefined,
      undefined,
      { dataTimeoutMs: 5_000 }, // long — the point is PROMPT disarm on abort, not waiting it out
    );

    await settle(40); // shell commits → deadline armed; deadlineClose captured
    expect(deadlineClose).toBeDefined();
    expect(writable.listeners('close')).toContain(deadlineClose); // armed

    abort(); // manual benign abort → controller cleanup → stopDataDeadline (authoritative, no 'close')
    await expect(done).resolves.toBeUndefined();
    await settle(20); // brief — nowhere near the 5s deadline; no 'close' event fires (emitClose:false)

    // The deadline's specific 'close' listener was removed by CONTROLLER cleanup, not by a 'close'
    // event. (Before the fix it relied on 'close' and would linger here until dataTimeoutMs.)
    expect(writable.listeners('close')).not.toContain(deadlineClose);
    expect(onError).not.toHaveBeenCalled();
    expect(onAllReady).not.toHaveBeenCalled();
  });

  // Review finding (HIGH + #10): abort DURING the deferred-end data wait must not leak the
  // dataTimeout timer, must not fire a spurious/late fatal onError, and must not deliver data or
  // end() a torn-down writable.
  it('abort during the deferred-end wait: done RESOLVES benign, no onAllReady, no late/spurious onError even after data settles', async () => {
    const { writable, state } = driveServerSide();
    const onAllReady = vi.fn();
    const onError = vi.fn();
    let resolveData!: (d: Data) => void;
    const dataP = new Promise<Data>((r) => (resolveData = r));
    const AppNoConsumer = () => <div>no consumer</div>;

    const { done, abort } = createRenderer<Data>({ appComponent: () => <AppNoConsumer />, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {}, onAllReady, onError },
      () => dataP, // still pending when React ends the shell → the gate arms its timer
      '/abort-mid-wait',
      undefined,
      undefined,
      undefined,
      undefined,
      { dataTimeoutMs: 5_000 }, // long — the test aborts long before it could fire
    );

    await settle(40); // let React commit the shell and arm the deferred-end timer
    abort(); // benign abort mid-wait → controller destroys the writable
    await expect(done).resolves.toBeUndefined();
    expect(writable.destroyed).toBe(true);

    resolveData({ value: 7 }); // data settles AFTER the abort
    await settle(120);
    expect(onAllReady).not.toHaveBeenCalled(); // delivery suppressed post-abort
    expect(onError).not.toHaveBeenCalled(); // the leaked timer used to fire a spurious fatal here
    expect(state.finished).toBe(false); // no end() on the torn-down writable
  });

  // Review finding #4: a loader that resolves to `undefined` settles status:'success' with no data;
  // reading the snapshot at delivery throws — that must become a clean fatal, never a hung response.
  it('loader resolves to undefined → done REJECTS (clean fatal), not a hang', async () => {
    const { writable } = driveServerSide();
    const onError = vi.fn();

    const { done } = createRenderer<Data>({ appComponent: () => <div>x</div>, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {}, onError },
      () => Promise.resolve(undefined as unknown as Data),
      '/undefined-data',
      undefined,
      undefined,
      undefined,
      undefined,
      { dataTimeoutMs: 300 }, // small: if this were a hang, the test would only pass via the timeout
    );

    await expect(done).rejects.toThrow(/undefined/i);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // Review finding #7: prove React's backpressure actually flows THROUGH the delegating sink. With a
  // 1-byte highWaterMark and no consumer, write() returns false and React parks on a 'drain' listener
  // it attaches via the sink's on(). If that forwarding were dropped, React would stall forever and
  // done would never resolve; resuming the reader must let it complete with all bytes intact.
  it('backpressure: a paused tiny-highWaterMark sink stalls React, then completes on resume (drain forwarded through the sink)', async () => {
    const writable = new PassThrough({ highWaterMark: 1 });

    const { done } = createRenderer<Data>({ appComponent: () => <div>backpressure-body</div>, headContent: () => '<title>x</title>' }).renderStream(
      writable,
      { onHead: () => {} },
      { value: 1 },
      '/backpressure',
    );

    await settle(60); // React writes, the tiny hwm returns false, React parks on 'drain'
    const chunks: string[] = [];
    writable.on('data', (c) => chunks.push(c.toString())); // resume flow → 'drain' fires → React continues

    await expect(done).resolves.toBeUndefined();
    expect(chunks.join('')).toContain('backpressure-body');
  });
});

describe('R2-04 identifierPrefix (real react-dom/server)', () => {
  const IdApp = () => {
    const id = React.useId();
    return <span data-id={id}>{id}</span>;
  };

  it('renderSSR embeds identifierPrefix in useId output', async () => {
    const { appHtml } = await createRenderer<Data>({ appComponent: () => <IdApp />, headContent: () => '', identifierPrefix: 'app1-' }).renderSSR(
      { value: 1 },
      '/id',
    );
    expect(appHtml).toContain('app1-');
  });

  it('two roots with distinct prefixes produce disjoint useId sets', async () => {
    const render = (prefix: string) =>
      createRenderer<Data>({ appComponent: () => <IdApp />, headContent: () => '', identifierPrefix: prefix }).renderSSR({ value: 1 }, '/id');
    const [a, b] = await Promise.all([render('app1-'), render('app2-')]);
    expect(a.appHtml).toContain('app1-');
    expect(b.appHtml).toContain('app2-');
    expect(a.appHtml).not.toContain('app2-');
    expect(b.appHtml).not.toContain('app1-');
  });

  it('renderStream embeds identifierPrefix in the streamed output', async () => {
    const { writable, chunks } = driveServerSide();
    const { done } = createRenderer<Data>({
      appComponent: () => <IdApp />,
      headContent: () => '<title>x</title>',
      identifierPrefix: 'stream1-',
    }).renderStream(writable, { onHead: () => {} }, { value: 1 }, '/id');

    await done.catch(() => {});
    await settle();

    expect(chunks.join('')).toContain('stream1-');
  });
});
