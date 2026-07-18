// @vitest-environment node
//
// Integration: drive renderStream exactly as @taujs/server's HandleRender does
// (packages/server/src/utils/HandleRender.ts:355-460) against real @vue/server-renderer,
// real store, and real streaming utils. Proves the assembled streamed document has the head
// exactly once, the app HTML, the module bootstrap tag (so the route can hydrate), then the
// server-appended __INITIAL_DATA__ script — in that order.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, inject, resolveDirective, Teleport, withDirectives, type App, type InjectionKey } from 'vue';

import { createRenderer } from '../SSRRender';
import { useSSRData, useSSRDataAsync } from '../SSRDataStore';

/** Synchronous Writable stand-in (fires 'finish' synchronously on end()). */
class Collector extends EventEmitter {
  chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  write(chunk: unknown): boolean {
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk?: unknown): void {
    if (chunk != null) this.write(chunk);
    if (this.writableEnded) return;
    this.writableEnded = true;
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

const TEMPLATE = {
  beforeHead: '<!DOCTYPE html><html><head>',
  afterHead: '</head><body>',
  beforeBody: '<div id="root">',
  afterBody: '</div></body></html>',
};

/**
 * Runs renderStream through a faithful simulation of the server's streaming branch and
 * returns the fully assembled response document.
 */
async function driveLikeServer<T extends Record<string, unknown>>(
  renderStream: ReturnType<typeof createRenderer<T>>['renderStream'],
  initialData: T | Promise<T> | (() => Promise<T>),
  { bootstrapModule, cspNonce }: { bootstrapModule?: string; cspNonce?: string } = {},
): Promise<{ doc: string; onError: unknown[] }> {
  const collector = new Collector();
  const onErrorCalls: unknown[] = [];
  let finalData: unknown = undefined;

  const { done } = renderStream(
    collector as any,
    {
      // Server: writes the assembled head into <head> and pipes the renderer writable after
      // it. Our collector is that pipe target, so head bytes land ahead of the body bytes.
      onHead: (headContent: string) => {
        collector.chunks.push(`${TEMPLATE.beforeHead}${headContent}${TEMPLATE.afterHead}${TEMPLATE.beforeBody}`);
      },
      onAllReady: (data: unknown) => {
        finalData = data;
      },
      onError: (err: unknown) => {
        onErrorCalls.push(err);
      },
    },
    initialData,
    '/streaming',
    bootstrapModule,
    {},
    undefined,
    { cspNonce },
  );

  // Server: on writable finish, append the data script + template tail, then end.
  collector.once('finish', () => {
    const data = finalData ?? {};
    const dataScript = `<script${cspNonce ? ` nonce="${cspNonce}"` : ''}>window.__INITIAL_DATA__ = ${JSON.stringify(data).replace(
      /</g,
      '\\u003c',
    )}; window.dispatchEvent(new Event('taujs:data-ready'));</script>`;
    collector.chunks.push(`${dataScript}${TEMPLATE.afterBody}`);
  });

  await done;
  return { doc: collector.output(), onError: onErrorCalls };
}

const orderedIndexes = (doc: string, needles: string[]) => needles.map((n) => doc.indexOf(n));

describe('renderStream — server integration (byte order)', () => {
  it('sync data: single head, app HTML, nonce bootstrap, then data script — in order', async () => {
    const App = defineComponent({
      name: 'App',
      setup() {
        const data = useSSRData<{ msg: string }>();
        return () => h('div', { id: 'app' }, data.value?.msg ?? 'loading');
      },
    });

    const { renderStream } = createRenderer<{ msg: string }>({
      appComponent: () => h(App),
      headContent: ({ data }) => `<title>${(data as any)?.msg ?? 'no-data'}</title>`,
    });

    const { doc, onError } = await driveLikeServer(
      renderStream,
      { msg: 'hello' },
      {
        bootstrapModule: '/entry-client.js',
        cspNonce: 'test-nonce',
      },
    );

    expect(onError).toEqual([]);

    const head = '<title>hello</title>';
    const app = '<div id="app">hello</div>';
    const boot = '<script type="module" src="/entry-client.js" async nonce="test-nonce"></script>';
    const dataScript = 'window.__INITIAL_DATA__ = {"msg":"hello"}';

    // Head appears exactly once (F2: no double head).
    expect(doc.split(head).length - 1).toBe(1);
    // All fragments present.
    for (const frag of [head, app, boot, dataScript]) expect(doc).toContain(frag);
    // Strict order: head < app < bootstrap < data script.
    const idx = orderedIndexes(doc, [head, app, boot, dataScript]);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    // The renderer emitted the bootstrap; the server (not the renderer) emitted the data
    // script — the data script sits outside <div id="root">…the app…bootstrap.
    expect(doc.indexOf(boot)).toBeLessThan(doc.indexOf(dataScript));
  });

  it('async thunk data: head derives from meta only (snapshot pending), app blocks on data, bootstrap + data script still assembled', async () => {
    const AsyncApp = defineComponent({
      name: 'AsyncApp',
      async setup() {
        const data = await useSSRDataAsync<{ msg: string }>();
        return () => h('div', { id: 'app' }, data.msg);
      },
    });

    const { renderStream } = createRenderer<{ msg: string }>({
      appComponent: () => h(AsyncApp),
      headContent: ({ data }) => `<title>${(data as any)?.msg ?? 'no-data'}</title>`,
    });

    const { doc, onError } = await driveLikeServer(renderStream, () => Promise.resolve({ msg: 'streamed' }), {
      bootstrapModule: '/entry-client.js',
      cspNonce: 'abc',
    });

    expect(onError).toEqual([]);
    // Snapshot was pending at head time → head could not include the data.
    expect(doc).toContain('<title>no-data</title>');
    expect(doc.split('<title').length - 1).toBe(1);
    // The async component blocked until data resolved, then rendered it.
    expect(doc).toContain('<div id="app">streamed</div>');
    // Streamed-route hydration bootstrap + server data script both present, in order.
    const boot = '<script type="module" src="/entry-client.js" async nonce="abc"></script>';
    expect(doc).toContain(boot);
    expect(doc).toContain('window.__INITIAL_DATA__ = {"msg":"streamed"}');
    expect(doc.indexOf(boot)).toBeLessThan(doc.indexOf('__INITIAL_DATA__'));
  });

  it('renderSSR collects <Teleport> content into result.teleports, not appHtml (F12)', async () => {
    const App = defineComponent({
      name: 'App',
      setup() {
        const data = useSSRData<{ msg: string }>();
        return () => h('div', { id: 'app' }, [`main:${data.value?.msg ?? ''}`, h(Teleport, { to: '#modal' }, [h('span', { class: 'tp' }, 'teleported-body')])]);
      },
    });

    const { renderSSR } = createRenderer<{ msg: string }>({
      appComponent: () => h(App),
      headContent: () => '<title>t</title>',
    });

    const result = await renderSSR({ msg: 'hi' }, '/');

    expect(result.teleports).toBeDefined();
    expect(result.teleports!['#modal']).toContain('teleported-body');
    // The teleported content is buffered out of the app HTML, not left inline.
    expect(result.appHtml).toContain('main:hi');
    expect(result.appHtml).not.toContain('teleported-body');
  });

  it('renderSSR with no teleports yields an empty/absent teleports map (installed-version behaviour)', async () => {
    const { renderSSR } = createRenderer<{ msg: string }>({
      appComponent: () => h('div', { id: 'app' }, 'plain'),
      headContent: () => '<title>t</title>',
    });

    const result = await renderSSR({ msg: 'x' }, '/');

    expect(result.teleports == null || Object.keys(result.teleports).length === 0).toBe(true);
  });

  it('setupApp: a plugin installed on the app is usable by a rendered component (renderSSR)', async () => {
    const MSG: InjectionKey<string> = Symbol('msg');
    const Consumer = defineComponent({
      setup() {
        const m = inject(MSG, 'no-plugin');
        return () => h('div', { id: 'app' }, m);
      },
    });

    const { renderSSR } = createRenderer<Record<string, never>>({
      appComponent: () => h(Consumer),
      headContent: () => '<title>t</title>',
      setupApp: (app: App) => app.use({ install: (a: App) => a.provide(MSG, 'from-plugin') }),
    });

    const r = await renderSSR({}, '/');
    expect(r.appHtml).toContain('from-plugin');
    expect(r.appHtml).not.toContain('no-plugin');
  });

  it('setupApp: a plugin installed on the app is usable by a streamed component (renderStream)', async () => {
    const MSG: InjectionKey<string> = Symbol('msg');
    const Consumer = defineComponent({
      setup() {
        const m = inject(MSG, 'no-plugin');
        return () => h('div', { id: 'app' }, m);
      },
    });

    const { renderStream } = createRenderer<Record<string, never>>({
      appComponent: () => h(Consumer),
      headContent: () => '<title>t</title>',
      setupApp: (app: App) => app.provide(MSG, 'from-plugin'),
    });

    const { doc, onError } = await driveLikeServer(renderStream, {}, { bootstrapModule: '/entry-client.js' });
    expect(onError).toEqual([]);
    expect(doc).toContain('from-plugin');
  });

  it('setupApp: a directive registered on the app renders (getSSRProps) in renderSSR output', async () => {
    const Marked = defineComponent({
      render() {
        const dir = resolveDirective('mark');
        return withDirectives(h('div', { id: 'app' }, 'x'), dir ? [[dir]] : []);
      },
    });

    const { renderSSR } = createRenderer<Record<string, never>>({
      appComponent: () => h(Marked),
      headContent: () => '<title>t</title>',
      setupApp: (app: App) => app.directive('mark', { getSSRProps: () => ({ 'data-mark': 'on' }) }),
    });

    const r = await renderSSR({}, '/');
    expect(r.appHtml).toContain('data-mark="on"');
  });

  it('R1: streamed non-blocking idiom + async data still serializes real __INITIAL_DATA__', async () => {
    // The fallback idiom (useSSRData, no await) renders 'loading' immediately; without R1 the
    // stream would end before the macrotask thunk resolves and the server would serialize {}.
    const Fallback = defineComponent({
      name: 'Fallback',
      setup() {
        const data = useSSRData<{ msg: string }>();
        return () => h('div', { id: 'app' }, data.value?.msg ?? 'loading');
      },
    });

    const { renderStream } = createRenderer<{ msg: string }>({
      appComponent: () => h(Fallback),
      headContent: () => '<title>t</title>',
    });

    const { doc, onError } = await driveLikeServer(renderStream, () => new Promise<{ msg: string }>((r) => setTimeout(() => r({ msg: 'slow-data' }), 5)), {
      bootstrapModule: '/entry-client.js',
    });

    expect(onError).toEqual([]);
    // SSR rendered the fallback (data was pending)...
    expect(doc).toContain('<div id="app">loading</div>');
    // ...but the resolved data is still in the payload for the client (R1 gate on store.ready).
    expect(doc).toContain('window.__INITIAL_DATA__ = {"msg":"slow-data"}');
    expect(doc).not.toContain('__INITIAL_DATA__ = {}');
  });

  it('R3: a user errorHandler installed in setupApp still fires alongside τjs fatal routing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = defineComponent({
      name: 'Boom',
      setup() {
        throw new Error('render boom');
      },
    });
    const userHandler = vi.fn();

    const { renderStream } = createRenderer<{ x: number }>({
      appComponent: () => h(Boom),
      headContent: () => '<title>t</title>',
      setupApp: (app) => {
        app.config.errorHandler = userHandler;
      },
    });

    const { onError } = await driveLikeServer(renderStream, { x: 1 } as any).catch((e) => ({ onError: [e] }));

    expect(userHandler).toHaveBeenCalledTimes(1); // the user's handler still observes
    expect(onError.length).toBeGreaterThanOrEqual(1); // AND τjs's fatal routing still ran
  });

  it('a throwing component routes through app.config.errorHandler to a fatal onError', async () => {
    const Boom = defineComponent({
      name: 'Boom',
      setup() {
        throw new Error('component exploded');
      },
    });

    const { renderStream } = createRenderer<{ x: number }>({
      appComponent: () => h(Boom),
      headContent: () => '<title>boom</title>',
    });

    // Vue dev-mode prints a setup-error warning (with the component's props) independently of
    // our errorHandler; silence it so the test output stays clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { onError } = await driveLikeServer(renderStream, { x: 1 } as any).catch((e) => ({ onError: [e] }));

    expect(onError.length).toBeGreaterThanOrEqual(1);
    expect((onError[0] as Error).message).toContain('component exploded');
  });
});

describe('RFC 0004 (H6): headData reaches the single pre-render head build', () => {
  it('renderSSR: opts.headData arrives typed as H; undefined when the host passes none', async () => {
    const seen: Array<{ ogTitle: string } | undefined> = [];
    const { renderSSR } = createRenderer<{ msg: string }, unknown, { ogTitle: string }>({
      appComponent: defineComponent({
        setup: () => () => h('div', 'x'),
      }),
      headContent: ({ data, headData }) => {
        seen.push(headData);
        return `<title>${headData?.ogTitle ?? data.msg}</title>`;
      },
    });

    const withHead = await renderSSR({ msg: 'fallback' }, '/h', {}, undefined, { headData: { ogTitle: 'OG' } });
    const withoutHead = await renderSSR({ msg: 'fallback' }, '/h', {});

    expect(withHead.headContent).toBe('<title>OG</title>');
    expect(withoutHead.headContent).toBe('<title>fallback</title>');
    expect(seen).toEqual([{ ogTitle: 'OG' }, undefined]);
  });

  it('renderStream: opts.headData is visible in the head bytes written BEFORE the app bytes', async () => {
    const { renderStream } = createRenderer<{ msg: string }, unknown, { ogTitle: string }>({
      appComponent: defineComponent({
        setup: () => () => h('div', 'app-bytes'),
      }),
      headContent: ({ headData }) => `<title>${headData?.ogTitle ?? 'fallback'}</title>`,
    });

    const collector = new Collector();
    const { done } = renderStream(
      collector as any,
      { onHead: (headContent: string) => collector.chunks.push(`${TEMPLATE.beforeHead}${headContent}${TEMPLATE.afterHead}${TEMPLATE.beforeBody}`) },
      { msg: 'x' },
      '/stream-head',
      undefined,
      {},
      undefined,
      { headData: { ogTitle: 'Dynamic OG' } },
    );
    await done;
    const doc = collector.chunks.join('');

    expect(doc.indexOf('<title>Dynamic OG</title>')).toBeGreaterThan(-1);
    expect(doc.indexOf('<title>Dynamic OG</title>')).toBeLessThan(doc.indexOf('app-bytes'));
  });
});

describe('renderStream — server-join regressions (gate review R2-03/R2-04)', () => {
  // Faithful reproduction of the server's streaming failure-path wiring (HandleRender.ts:419-602),
  // which driveLikeServer (happy-path byte order) deliberately omits: the head commit that connects
  // the renderer's stream to the response, the PRODUCTION onError teardown whose ac.abort()
  // re-enters the renderer through the very signal wired to benign-cancel, and the writable
  // 'finish' listener that appends the data script + tail and records the response as sent. The
  // gate-review HIGHs live in exactly this join, so the regressions must drive the real callback
  // sequence, not a simplified observer.
  const driveServerJoin = <T extends Record<string, unknown>>(
    renderStream: ReturnType<typeof createRenderer<T>>['renderStream'],
    initialData: T,
    { commitHead }: { commitHead?: () => void } = {},
  ) => {
    // reply.raw stand-in: enough state for the join's branching (headersSent gates 500-vs-destroy).
    const reply = {
      headersSent: false,
      statusCode: null as number | null,
      writableEnded: false,
      destroyed: false,
      body: [] as string[],
      sent200: false,
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
      },
      write(chunk: unknown) {
        this.headersSent = true;
        this.body.push(String(chunk));
      },
      end(chunk?: unknown) {
        if (chunk != null) this.write(chunk);
        this.writableEnded = true;
      },
      destroy() {
        this.destroyed = true;
      },
      output() {
        return this.body.join('');
      },
    };

    const writable = new Collector();
    const ac = new AbortController();
    let abortedState = false;
    let finalData: unknown = undefined;
    let pipedToReply = false;

    // writable.pipe(reply.raw, { end: false }) — the renderer's bytes reach the response only
    // once onHead has connected them (HandleRender.ts:450-453).
    const rendererWrite = writable.write.bind(writable);
    writable.write = (chunk: unknown): boolean => {
      const ok = rendererWrite(chunk);
      if (pipedToReply) reply.write(chunk);
      return ok;
    };

    // The production FATAL channel teardown (HandleRender.ts:480-534, minus telemetry). The
    // ac.abort() here is the re-entrancy under test: the same signal is wired to renderStream below.
    const onError = vi.fn((err: unknown) => {
      void err;
      if (abortedState) return;
      abortedState = true;
      try {
        ac.abort();
      } catch {}
      if (!reply.headersSent) {
        reply.writeHead(500);
        reply.end('Internal Server Error');
        return;
      }
      if (!reply.writableEnded && !reply.destroyed) reply.destroy();
    });

    const { done } = renderStream(
      writable as any,
      {
        // The head commit connects the renderer's stream to the HTTP response
        // (HandleRender.ts:434-454); commitHead is where the production write can throw.
        onHead: (headContent: string) => {
          commitHead?.();
          reply.write(`${TEMPLATE.beforeHead}${headContent}${TEMPLATE.afterHead}${TEMPLATE.beforeBody}`);
          pipedToReply = true;
        },
        onAllReady: (data: unknown) => {
          if (!abortedState) finalData = data;
        },
        onError,
      },
      initialData,
      '/server-join',
      '/entry-client.js',
      {},
      ac.signal, // HandleRender.ts:541 — the signal the production onError aborts re-entrantly
    );

    // On renderer finish, the server appends the data script + template tail and records the
    // response as SENT with a 200 (HandleRender.ts:552-602). After a failed head commit this
    // listener is what assembled the malformed "successful" response pre-fix.
    writable.once('finish', () => {
      if (abortedState || reply.writableEnded) return;
      reply.write(`<script>window.__INITIAL_DATA__ = ${JSON.stringify(finalData ?? {})};</script>${TEMPLATE.afterBody}`);
      reply.end();
      reply.sent200 = true; // recorder?.sent({ status: 200, mode: 'streaming' })
    });

    return { done, writable, reply, ac, onError };
  };

  it('gate finding 3: a throwing head commit cannot continue to a partial 200 — the join sends a real 500 and never records sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { renderStream } = createRenderer<{ msg: string }>({
      appComponent: () => h('div', { id: 'app' }, 'app-body'),
      headContent: () => '<title>x</title>',
    });

    const { done, reply, onError } = driveServerJoin(
      renderStream,
      { msg: 'hello' },
      {
        commitHead: () => {
          throw new Error('head commit failed');
        },
      },
    );

    await expect(done).rejects.toThrow('head commit failed');
    expect(onError).toHaveBeenCalledTimes(1);
    // Nothing was committed, so the join sent a REAL error response…
    expect(reply.statusCode).toBe(500);
    expect(reply.output()).toBe('Internal Server Error');
    // …and the finish listener could not assemble the pre-fix malformed "success": app bytes into
    // an unconnected sink, then data script + tail recorded as a 200 with no head/prefix/body.
    expect(reply.sent200).toBe(false);
    expect(reply.output()).not.toContain('app-body');
    expect(reply.output()).not.toContain('__INITIAL_DATA__');
  });

  it('gate finding 2: a fatal whose onError re-enters via the production ac.abort() still rejects done; writable and reply torn down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = defineComponent({
      name: 'Boom',
      setup() {
        throw new Error('server-join-fatal');
      },
    });
    const { renderStream } = createRenderer<{ x: number }>({
      appComponent: () => h(Boom),
      headContent: () => '<title>boom</title>',
    });

    const { done, writable, reply, ac, onError } = driveServerJoin(renderStream, { x: 1 });

    await expect(done).rejects.toThrow('server-join-fatal'); // NOT benign-resolved by the re-entry
    expect(onError).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(true); // the production re-entry really fired
    expect(writable.destroyed).toBe(true); // renderer-side teardown still ran
    // The head had already been committed, so the join destroys the response instead of 500ing —
    // and the fatal can never be recorded as a sent 200.
    expect(reply.headersSent).toBe(true);
    expect(reply.destroyed).toBe(true);
    expect(reply.sent200).toBe(false);
  });
});
