// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';

// Mock ONLY @vue/server-renderer: capture the SimpleReadable sink our renderer builds and
// hand it to the render, so tests drive push()/destroy() deterministically. Everything else
// (streaming utils, store) runs for real against a synchronous collector writable.
vi.mock('@vue/server-renderer', () => {
  let sink: unknown = null;
  return {
    renderToString: vi.fn(async () => '<div>html</div>'),
    renderToSimpleStream: vi.fn((_input: unknown, _ctx: unknown, stream: unknown) => {
      sink = stream;
      return stream;
    }),
    __getSink: () => sink,
    __resetSink: () => {
      sink = null;
    },
  };
});

import { createRenderer } from '../SSRRender';
import * as SR from '@vue/server-renderer';

type Sink = { push: (chunk: string | null) => void; destroy: (err: unknown) => void };
const getSink = () => (SR as unknown as { __getSink: () => Sink }).__getSink();

/**
 * Synchronous Writable stand-in: records every write, fires 'finish' synchronously on end()
 * so the real stream controller/guards settle deterministically within a test tick.
 */
class Collector extends EventEmitter {
  chunks: string[] = [];
  writeCalls: string[] = [];
  writableEnded = false;
  destroyed = false;
  ended = false;

  write(chunk: unknown): boolean {
    const s = String(chunk);
    this.chunks.push(s);
    this.writeCalls.push(s);
    return true;
  }
  end(chunk?: unknown): void {
    if (chunk != null) this.write(chunk);
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.ended = true;
    this.emit('finish');
  }
  destroy(err?: unknown): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (err) this.emit('error', err);
    this.emit('close');
  }
  output(): string {
    return this.chunks.join('');
  }
}

const makeRenderer = (over: Partial<Parameters<typeof createRenderer>[0]> = {}) =>
  createRenderer<any>({
    appComponent: () => h('div', 'app'),
    headContent: ({ data, meta }: any) => `<title>${(data as any)?.title ?? 'H'}-${(meta as any)?.x ?? ''}</title>`,
    enableDebug: true,
    logger: {},
    ...(over as any),
  });

beforeEach(() => {
  vi.clearAllMocks();
  (SR as unknown as { __resetSink: () => void }).__resetSink();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createRenderer.renderSSR', () => {
  it('renders head + html and logs around render', async () => {
    const log = vi.fn();
    const renderer = makeRenderer({ logger: { log } } as any);

    const out = await renderer.renderSSR({ title: 'T' } as any, '/home', { x: 1 });

    expect(SR.renderToString).toHaveBeenCalledTimes(1);
    expect(out.headContent).toBe('<title>T-1</title>');
    expect(out.appHtml).toBe('<div>html</div>');
    expect(out.aborted).toBe(false);
    expect(log).toHaveBeenNthCalledWith(1, 'Starting SSR:', '/home');
    expect(log).toHaveBeenNthCalledWith(2, 'Completed SSR:', '/home');
  });

  it('skips immediately when AbortSignal is already aborted', async () => {
    const warn = vi.fn();
    const ac = new AbortController();
    ac.abort();

    const out = await makeRenderer({ logger: { warn } } as any).renderSSR({ title: 'X' } as any, '/skip', {}, ac.signal);

    expect(SR.renderToString).not.toHaveBeenCalled();
    expect(out).toEqual({ headContent: '', appHtml: '', aborted: true });
    const [msg, meta] = warn.mock.calls[0]!;
    expect(msg).toContain('SSR skipped; already aborted');
    expect(meta).toEqual({ location: '/skip' });
  });

  it('aborts during SSR: warns and returns aborted=true', async () => {
    const warn = vi.fn();
    const ac = new AbortController();
    (SR.renderToString as any).mockImplementationOnce(async () => {
      ac.abort();
      return '<div>html</div>';
    });

    const out = await makeRenderer({ logger: { warn } } as any).renderSSR({ title: 'Y' } as any, '/mid', {}, ac.signal);

    expect(out).toEqual({ headContent: '', appHtml: '', aborted: true });
    const [msg] = warn.mock.calls[0]!;
    expect(msg).toContain('SSR completed after client abort');
  });

  it('prefers per-call opts.logger over renderer-level logger', async () => {
    const topLog = vi.fn();
    const callLog = vi.fn();

    await makeRenderer({ logger: { log: topLog } } as any).renderSSR({} as any, '/override', {}, undefined, { logger: { log: callLog } });

    expect(callLog).toHaveBeenCalledTimes(2);
    expect(topLog).not.toHaveBeenCalled();
  });
});

describe('createRenderer.renderStream — head contract (F2)', () => {
  it('delivers head exactly once via onHead and never writes it into the stream', () => {
    const writable = new Collector();
    const onHead = vi.fn();

    makeRenderer().renderStream(writable as any, { onHead }, { title: 'T' } as any, '/', undefined, { x: 9 });

    expect(onHead).toHaveBeenCalledTimes(1);
    expect(onHead).toHaveBeenCalledWith('<title>T-9</title>');

    const sink = getSink();
    sink.push('<main>body</main>');
    sink.push(null);

    expect(writable.output()).toContain('<main>body</main>');
    expect(writable.output()).not.toContain('<title>');
  });

  it('builds head from an empty snapshot when initial data is a pending thunk', () => {
    const writable = new Collector();
    const onHead = vi.fn();

    makeRenderer().renderStream(writable as any, { onHead }, () => Promise.resolve({ title: 'later' }) as any, '/', undefined, { x: 3 });

    // Snapshot is undefined at head time → data falls back to {}
    expect(onHead).toHaveBeenCalledWith('<title>H-3</title>');
  });

  it('a throwing onHead is FATAL: done rejects, nothing is rendered into the unconnected sink', async () => {
    // onHead is REQUIRED, not advisory: at the server boundary it commits the response prefix and
    // connects the renderer's PassThrough to the HTTP response. If it throws and we carried on, app
    // bytes would be written into an unconnected sink -> a malformed "successful" response.
    const writable = new Collector();
    const onError = vi.fn();
    const onHead = vi.fn(() => {
      throw new Error('head-cb boom');
    });

    const { done } = makeRenderer({ logger: { error: vi.fn() } } as any).renderStream(writable as any, { onHead, onError }, {} as any, '/onhead-throws');

    await expect(done).rejects.toThrow('head-cb boom');
    expect(SR.renderToSimpleStream).not.toHaveBeenCalled(); // stopped before rendering
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('head-cb boom');
  });
});

describe('createRenderer.renderStream — bootstrap & hydration (F3)', () => {
  it('emits the module bootstrap tag once, before end(), with nonce', async () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, {} as any, '/', '/entry-client.js', {}, undefined, { cspNonce: 'nonce-123' });

    const sink = getSink();
    sink.push('<div id="app"></div>');
    sink.push(null);
    await new Promise((r) => setTimeout(r, 0)); // R1: end-of-stream is gated on store.ready

    const boot = '<script type="module" src="/entry-client.js" async nonce="nonce-123"></script>';
    expect(writable.writeCalls.filter((c) => c.includes('type="module"'))).toEqual([boot]);
    // Bootstrap is written after the app chunk and the stream is ended afterwards.
    expect(writable.writeCalls.indexOf(boot)).toBeGreaterThan(writable.writeCalls.indexOf('<div id="app"></div>'));
    expect(writable.ended).toBe(true);
  });

  it('emits the bootstrap tag without a nonce attribute when cspNonce is absent', async () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, {} as any, '/', '/entry-client.js');

    const sink = getSink();
    sink.push('x');
    sink.push(null);
    await new Promise((r) => setTimeout(r, 0));

    expect(writable.output()).toContain('<script type="module" src="/entry-client.js" async></script>');
    expect(writable.output()).not.toContain('nonce=');
  });

  it('escapes the bootstrap src and nonce attributes (SEC2, R2-03)', async () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, {} as any, '/', '/x.js" onmouseover="alert(1)', {}, undefined, { cspNonce: 'n"once' });

    const sink = getSink();
    sink.push('<div id="app"></div>');
    sink.push(null);
    await new Promise((r) => setTimeout(r, 0));

    const boot = writable.writeCalls.filter((c) => c.includes('type="module"'))[0]!;
    expect(boot).toContain('src="/x.js&quot; onmouseover=&quot;alert(1)"'); // src encoded
    expect(boot).not.toContain('onmouseover="alert(1)"'); // no live attribute breakout
    expect(boot).toContain('nonce="n&quot;once"'); // nonce encoded
  });

  it('emits no bootstrap tag when bootstrapModules is undefined', async () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, {} as any, '/');

    const sink = getSink();
    sink.push('x');
    sink.push(null);
    await new Promise((r) => setTimeout(r, 0));

    expect(writable.output()).not.toContain('type="module"');
    expect(writable.ended).toBe(true);
  });

  it('never writes the __INITIAL_DATA__ script (the server owns that)', () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, { title: 'T' } as any, '/', '/entry-client.js', {}, undefined, { cspNonce: 'n' });

    const sink = getSink();
    sink.push('<div/>');
    sink.push(null);

    expect(writable.output()).not.toContain('__INITIAL_DATA__');
  });
});

describe('createRenderer.renderStream — shell semantics (F5)', () => {
  it('fires onShellReady on the first chunk, exactly once, never before', () => {
    const writable = new Collector();
    const onShellReady = vi.fn();

    makeRenderer().renderStream(writable as any, { onShellReady }, {} as any, '/');

    expect(onShellReady).not.toHaveBeenCalled();

    const sink = getSink();
    sink.push('a');
    expect(onShellReady).toHaveBeenCalledTimes(1);
    sink.push('b');
    expect(onShellReady).toHaveBeenCalledTimes(1);
    sink.push(null);
  });

  it('onShellReady callback throwing is caught (warns) and does not abort', () => {
    const writable = new Collector();
    const warn = vi.fn();
    const onShellReady = vi.fn(() => {
      throw new Error('shell-cb boom');
    });

    const { done } = makeRenderer({ logger: { warn } } as any).renderStream(writable as any, { onShellReady }, {} as any, '/');

    const sink = getSink();
    expect(() => sink.push('a')).not.toThrow();
    const [msg, err] = warn.mock.calls.find(([m]) => String(m).includes('onShellReady callback threw'))!;
    expect(msg).toContain('onShellReady callback threw:');
    expect((err as Error).message).toBe('shell-cb boom');

    sink.push(null);
    return expect(done).resolves.toBeUndefined();
  });

  it('shell watchdog fires onError + rejects done when no chunk is ever produced', async () => {
    vi.useFakeTimers();
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer({ streamOptions: { shellTimeoutMs: 50 } } as any).renderStream(writable as any, { onError }, {} as any, '/timeout');

    vi.advanceTimersByTime(51);

    await expect(done).rejects.toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0]![0] as Error).message).toContain('no content within 50ms');
  });

  it('honours a per-call shellTimeoutMs override over the renderer default', async () => {
    vi.useFakeTimers();
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer({ streamOptions: { shellTimeoutMs: 10_000 } } as any).renderStream(
      writable as any,
      { onError },
      {} as any,
      '/override',
      undefined,
      {},
      undefined,
      { shellTimeoutMs: 25 },
    );

    vi.advanceTimersByTime(24);
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    await expect(done).rejects.toBeInstanceOf(Error);
  });
});

describe('createRenderer.renderStream — completion & data delivery', () => {
  it('completes (done resolves) when the render ends normally', async () => {
    const writable = new Collector();
    const { done } = makeRenderer().renderStream(writable as any, {}, {} as any, '/');

    const sink = getSink();
    sink.push('<div/>');
    sink.push(null); // → writable.end() → 'finish' → controller.complete

    await expect(done).resolves.toBeUndefined();
  });

  it('delivers resolved thunk data to onAllReady and onFinish', async () => {
    const writable = new Collector();
    const onAllReady = vi.fn();
    const onFinish = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onAllReady, onFinish }, () => Promise.resolve({ userId: 7 }) as any, '/data');

    const sink = getSink();
    sink.push('<div/>');
    // Real flow: the render awaits the data, so it resolves (and is delivered) before the
    // stream ends. Flush the store's microtasks, then finish the stream.
    await new Promise((r) => setTimeout(r, 0));
    expect(onAllReady).toHaveBeenCalledWith({ userId: 7 });
    expect(onFinish).toHaveBeenCalledWith({ userId: 7 });

    sink.push(null);
    await done;
  });

  it('a throwing onAllReady is ISOLATED: onFinish still fires, done follows the render outcome, no manufactured fatal', async () => {
    // An advisory observer must not turn successfully resolved data + a completed render into a fatal
    // stream failure (its throw previously reached the .catch and called fail), nor suppress onFinish.
    const writable = new Collector();
    const onAllReady = vi.fn(() => {
      throw new Error('onAllReady boom');
    });
    const onFinish = vi.fn();
    const onError = vi.fn();

    const { done } = makeRenderer({ logger: { error: vi.fn() } } as any).renderStream(
      writable as any,
      { onAllReady, onFinish, onError },
      () => Promise.resolve({ userId: 7 }) as any,
      '/data',
    );

    const sink = getSink();
    sink.push('<div/>');
    await new Promise((r) => setTimeout(r, 0));

    expect(onAllReady).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith({ userId: 7 }); // sibling not suppressed
    expect(onError).not.toHaveBeenCalled(); // no manufactured fatal

    sink.push(null);
    await expect(done).resolves.toBeUndefined();
  });

  it('a throwing onFinish is ISOLATED: done still resolves, single fire', async () => {
    const writable = new Collector();
    const onAllReady = vi.fn();
    const onFinish = vi.fn(() => {
      throw new Error('onFinish boom');
    });
    const onError = vi.fn();

    const { done } = makeRenderer({ logger: { error: vi.fn() } } as any).renderStream(
      writable as any,
      { onAllReady, onFinish, onError },
      () => Promise.resolve({ userId: 7 }) as any,
      '/data',
    );

    const sink = getSink();
    sink.push('<div/>');
    await new Promise((r) => setTimeout(r, 0));

    expect(onAllReady).toHaveBeenCalledWith({ userId: 7 });
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    sink.push(null);
    await expect(done).resolves.toBeUndefined();
  });

  it('re-entrant abort: a fatal whose onError aborts the passed signal still REJECTS done (no benign downgrade)', async () => {
    // The server's onError synchronously calls ac.abort() on the SAME signal wired here to
    // benign-cancel. If fail() ran the callback before claiming fatal, that re-entrant benignAbort
    // would win the one-shot controller and RESOLVE done - a fatal reported as a benign completion.
    const writable = new Collector();
    const ac = new AbortController();
    const original = new Error('vue-fatal-original');
    const onError = vi.fn(() => ac.abort());

    const { done } = makeRenderer({ logger: { error: vi.fn() } } as any).renderStream(
      writable as any,
      { onError },
      {} as any,
      '/reentrant',
      undefined,
      {},
      ac.signal,
    );

    const sink = getSink();
    sink.destroy(original); // render-origin fatal

    await expect(done).rejects.toThrow('vue-fatal-original');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(writable.destroyed).toBe(true); // fatal teardown still ran despite the re-entry
  });

  it('a rejected data thunk becomes a fatal error (onError + done rejects)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onError }, () => Promise.reject(new Error('load fail')) as any, '/bad-data');

    await expect(done).rejects.toThrow('load fail');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('createRenderer.renderStream — error & abort paths', () => {
  it('sink.destroy with a fatal error → onError + done rejects', async () => {
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onError }, {} as any, '/render-fail');

    getSink().destroy(new Error('render boom'));

    await expect(done).rejects.toThrow('render boom');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('recheck: a throwing onError does not veto fatal settlement — done rejects with the ORIGINAL error, writable destroyed', async () => {
    const writable = new Collector();
    const original = new Error('render boom');
    const onError = vi.fn(() => {
      throw new Error('onError boom');
    });

    const { done } = makeRenderer().renderStream(writable as any, { onError }, {} as any, '/fatal-throwing-cb');

    getSink().destroy(original);

    // fail() runs controller.fatalAbort in `finally`, so settlement + cleanup happen even though
    // cb.onError threw: `done` rejects with the ORIGINAL error and the writable is destroyed.
    await expect(done).rejects.toBe(original);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(writable.destroyed).toBe(true);
  });

  it('R0-02: sink.destroy with a disconnect-shaped error is still fatal (destroy is render-origin)', async () => {
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onError }, {} as any, '/disconnect');

    // `destroy` is fed by the render pipeline — a disconnect-shaped message must not be swallowed.
    getSink().destroy(new Error('ECONNRESET'));

    await expect(done).rejects.toThrow('ECONNRESET');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a benign writable error (socket disconnect by code) resolves done', async () => {
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onError }, {} as any, '/writable-benign');

    // real client disconnect surfaced on the writable ('socket'-origin), benign by code (R0-02)
    writable.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    await expect(done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a fatal writable error rejects done and calls onError exactly once', async () => {
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onError }, {} as any, '/writable-fatal');

    writable.emit('error', new Error('disk full'));

    await expect(done).rejects.toThrow('disk full');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a pre-aborted AbortSignal skips rendering and resolves done', async () => {
    const writable = new Collector();
    const ac = new AbortController();
    ac.abort();

    const r = makeRenderer().renderStream(writable as any, {}, {} as any, '/pre-abort', undefined, {}, ac.signal);

    expect(SR.renderToSimpleStream).not.toHaveBeenCalled();
    await expect(r.done).resolves.toBeUndefined();
    expect(() => r.abort()).not.toThrow();
  });

  it('an AbortSignal firing mid-stream benign-aborts (done resolves)', async () => {
    const writable = new Collector();
    const ac = new AbortController();

    const { done } = makeRenderer().renderStream(writable as any, {}, {} as any, '/mid-abort', undefined, {}, ac.signal);

    expect(SR.renderToSimpleStream).toHaveBeenCalledTimes(1);
    ac.abort();

    await expect(done).resolves.toBeUndefined();
  });

  it('manual abort() resolves done (benign)', async () => {
    const writable = new Collector();
    const { abort, done } = makeRenderer().renderStream(writable as any, {}, {} as any, '/manual');

    abort();
    await expect(done).resolves.toBeUndefined();
  });

  it('post-abort pushes are inert (no writes, no throw)', async () => {
    const writable = new Collector();
    const { abort, done } = makeRenderer().renderStream(writable as any, {}, {} as any, '/inert');
    const sink = getSink();

    abort();
    expect(() => sink.push('late')).not.toThrow();
    expect(() => sink.push(null)).not.toThrow();
    expect(writable.output()).toBe('');
    await expect(done).resolves.toBeUndefined();
  });
});

describe('createRenderer — setupApp (V1-06)', () => {
  it('setupApp receives the created app and runs before renderToSimpleStream', () => {
    const writable = new Collector();
    const seen: unknown[] = [];

    makeRenderer({ setupApp: (app: any) => seen.push(app) } as any).renderStream(writable as any, {}, {} as any, '/setup');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeTruthy();
    expect(SR.renderToSimpleStream).toHaveBeenCalledTimes(1);
  });

  it('renderSSR rejects when setupApp throws (renderSSR error channel)', async () => {
    const renderer = makeRenderer({
      setupApp: () => {
        throw new Error('setup boom');
      },
    } as any);

    await expect(renderer.renderSSR({} as any, '/setup-ssr')).rejects.toThrow('setup boom');
  });

  it('renderStream: a throwing setupApp aborts the stream (onError + done rejects) before render', async () => {
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer({
      setupApp: () => {
        throw new Error('setup boom');
      },
    } as any).renderStream(writable as any, { onError }, {} as any, '/setup-stream');

    await expect(done).rejects.toThrow('setup boom');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(SR.renderToSimpleStream).not.toHaveBeenCalled();
  });
});
