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

  it('onHead callback throwing is caught (warns) and does not abort the stream', () => {
    const writable = new Collector();
    const warn = vi.fn();
    const onHead = vi.fn(() => {
      throw new Error('head-cb boom');
    });

    makeRenderer({ logger: { warn } } as any).renderStream(writable as any, { onHead }, {} as any, '/onhead-throws');

    expect(SR.renderToSimpleStream).toHaveBeenCalledTimes(1);
    const [msg, err] = warn.mock.calls.find(([m]) => String(m).includes('onHead callback threw'))!;
    expect(msg).toContain('onHead callback threw:');
    expect((err as Error).message).toBe('head-cb boom');
  });
});

describe('createRenderer.renderStream — bootstrap & hydration (F3)', () => {
  it('emits the module bootstrap tag once, before end(), with nonce', () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, {} as any, '/', '/entry-client.js', {}, 'nonce-123');

    const sink = getSink();
    sink.push('<div id="app"></div>');
    sink.push(null);

    const boot = '<script type="module" src="/entry-client.js" async nonce="nonce-123"></script>';
    expect(writable.writeCalls.filter((c) => c.includes('type="module"'))).toEqual([boot]);
    // Bootstrap is written after the app chunk and the stream is ended afterwards.
    expect(writable.writeCalls.indexOf(boot)).toBeGreaterThan(writable.writeCalls.indexOf('<div id="app"></div>'));
    expect(writable.ended).toBe(true);
  });

  it('emits the bootstrap tag without a nonce attribute when cspNonce is absent', () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, {} as any, '/', '/entry-client.js');

    const sink = getSink();
    sink.push('x');
    sink.push(null);

    expect(writable.output()).toContain('<script type="module" src="/entry-client.js" async></script>');
    expect(writable.output()).not.toContain('nonce=');
  });

  it('emits no bootstrap tag when bootstrapModules is undefined', () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, {} as any, '/');

    const sink = getSink();
    sink.push('x');
    sink.push(null);

    expect(writable.output()).not.toContain('type="module"');
    expect(writable.ended).toBe(true);
  });

  it('never writes the __INITIAL_DATA__ script (the server owns that)', () => {
    const writable = new Collector();

    makeRenderer().renderStream(writable as any, {}, { title: 'T' } as any, '/', '/entry-client.js', {}, 'n');

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

  it('sink.destroy with a benign disconnect → done resolves, no onError', async () => {
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onError }, {} as any, '/disconnect');

    getSink().destroy(new Error('ECONNRESET'));

    await expect(done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a benign writable error resolves done (client disconnect)', async () => {
    const writable = new Collector();
    const onError = vi.fn();

    const { done } = makeRenderer().renderStream(writable as any, { onError }, {} as any, '/writable-benign');

    writable.emit('error', new Error('EPIPE'));

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

    const r = makeRenderer().renderStream(writable as any, {}, {} as any, '/pre-abort', undefined, {}, undefined, ac.signal);

    expect(SR.renderToSimpleStream).not.toHaveBeenCalled();
    await expect(r.done).resolves.toBeUndefined();
    expect(() => r.abort()).not.toThrow();
  });

  it('an AbortSignal firing mid-stream benign-aborts (done resolves)', async () => {
    const writable = new Collector();
    const ac = new AbortController();

    const { done } = makeRenderer().renderStream(writable as any, {}, {} as any, '/mid-abort', undefined, {}, undefined, ac.signal);

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
