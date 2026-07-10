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
    cspNonce,
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

    const { doc, onError } = await driveLikeServer(renderStream, { msg: 'hello' }, {
      bootstrapModule: '/entry-client.js',
      cspNonce: 'test-nonce',
    });

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
        return () =>
          h('div', { id: 'app' }, [
            `main:${data.value?.msg ?? ''}`,
            h(Teleport, { to: '#modal' }, [h('span', { class: 'tp' }, 'teleported-body')]),
          ]);
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
