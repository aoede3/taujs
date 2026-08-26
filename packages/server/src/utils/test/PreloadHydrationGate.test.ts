// @vitest-environment node
// RULED 2026-08-26 (preload policy): module preloads accelerate the CLIENT execution graph, so a
// route that does not hydrate must not receive them. CSS is emitted either way - the
// server-rendered HTML still needs styling. Pinned here through the REAL `handleRender` path, on
// BOTH head-assembly arms, because the two arms assemble the head independently and a policy
// applied to only one of them is exactly the kind of sibling drift this codebase keeps producing.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, it, expect, vi } from 'vitest';

import { handleRender } from '../HandleRender';
import { collectPartialDocument } from '../../test/support/document';

const PRELOAD = '<link rel="modulepreload" href="/assets/shared-abc.js">';
const CSS = '<link rel="stylesheet" href="/assets/entry-abc.css">';

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: () => false };
  l.child = () => l;
  return l;
};

const mkReq = (logger: any): any => {
  const raw = new EventEmitter() as any;
  raw.url = '/product/42';
  return {
    url: '/product/42',
    method: 'GET',
    headers: { host: 'localhost' },
    raw,
    taujsRequestContext: { requestId: 'episode-hydrate-1', logger, headers: {} },
  };
};

const mkReply = () => {
  const chunks: string[] = [];
  const raw = new PassThrough() as any;
  raw.writeHead = vi.fn(() => {
    raw.headersSent = true;
  });
  raw.headersSent = false;
  const write = raw.write.bind(raw);
  raw.write = (chunk: any, ...rest: any[]) => {
    chunks.push(String(chunk));
    return write(chunk, ...rest);
  };
  const reply: any = {
    raw,
    chunks,
    header: vi.fn(() => reply),
    status: vi.fn(() => reply),
    type: vi.fn(() => reply),
    removeHeader: vi.fn(() => reply),
    getHeaders: vi.fn(() => ({})),
    getHeader: vi.fn(() => undefined),
    send: vi.fn(() => reply),
  };
  return reply;
};

const maps = (renderModule: any): any => ({
  bootstrapModules: new Map([['/root', '/bootstrap.js']]),
  cssLinks: new Map([['/root', CSS]]),
  manifests: new Map([['/root', { 'entry-client.tsx': { file: 'assets/entry-abc.js' } }]]),
  preloadLinks: new Map([['/root', PRELOAD]]),
  renderModules: new Map([['/root', renderModule]]),
  templates: new Map([['/root', '<html><head><!--ssr-head--></head><body><main><!--ssr-html--></main></body></html>']]),
});

const configs = [{ appId: 'storefront', clientRoot: '/root', entryServer: 'entry-server' }] as any;
const route = (attr: Record<string, unknown>) => ({ route: { path: '/product/:id', appId: 'storefront', attr }, params: { id: '42' } });

const streamingRenderer = () => ({
  renderStream: vi.fn((writable: PassThrough, cb: any, initialDataInput: any) => {
    const done = (async () => {
      cb.onHead('<title>p</title>');
      cb.onShellReady();
      writable.write('<div>app</div>');
      cb.onAllReady(await (typeof initialDataInput === 'function' ? initialDataInput() : initialDataInput));
      writable.end();
    })();
    return { abort: () => {}, done };
  }),
});

const ssrRenderer = () => ({
  renderSSR: vi.fn(async () => ({ headContent: '<title>p</title>', appHtml: '<div>app</div>' })),
});

const runStreaming = async (attr: Record<string, unknown>) => {
  const logger = mkLogger();
  const payload = await handleRender(mkReq(logger), mkReply(), route({ render: 'streaming', ...attr }) as any, configs, {} as any, maps(streamingRenderer()), {
    logger,
  });
  const { document } = await collectPartialDocument(payload);
  await new Promise((r) => setTimeout(r, 20));

  return document;
};

const runSSR = async (attr: Record<string, unknown>) => {
  const logger = mkLogger();
  const reply = mkReply();
  await handleRender(mkReq(logger), reply, route(attr) as any, configs, {} as any, maps(ssrRenderer()), { logger });
  await new Promise((r) => setTimeout(r, 20));

  return String(reply.send.mock.calls.at(-1)?.[0] ?? '');
};

describe('module preloads are gated on hydration, on both head-assembly arms', () => {
  it('SSR arm: a hydrating route gets module preloads AND stylesheets', async () => {
    const html = await runSSR({ hydrate: true });

    expect(html).toContain(PRELOAD);
    expect(html).toContain(CSS);
  });

  it('SSR arm: a NON-hydrating route gets stylesheets but NO module preloads', async () => {
    const html = await runSSR({ hydrate: false });

    // Nothing will execute on the client, so there is no execution graph to accelerate.
    expect(html).not.toContain(PRELOAD);
    // The server-rendered HTML still needs styling.
    expect(html).toContain(CSS);
  });

  it('streaming arm: a hydrating route gets module preloads AND stylesheets', async () => {
    const html = await runStreaming({ hydrate: true });

    expect(html).toContain(PRELOAD);
    expect(html).toContain(CSS);
  });

  it('streaming arm: a NON-hydrating route gets stylesheets but NO module preloads', async () => {
    const html = await runStreaming({ hydrate: false });

    expect(html).not.toContain(PRELOAD);
    expect(html).toContain(CSS);
  });

  it('the two arms agree - the same route attributes produce the same preload decision', async () => {
    const hydrating = { ssr: await runSSR({ hydrate: true }), streaming: await runStreaming({ hydrate: true }) };
    const inert = { ssr: await runSSR({ hydrate: false }), streaming: await runStreaming({ hydrate: false }) };

    expect(hydrating.ssr.includes(PRELOAD)).toBe(hydrating.streaming.includes(PRELOAD));
    expect(inert.ssr.includes(PRELOAD)).toBe(inert.streaming.includes(PRELOAD));
    expect(inert.ssr.includes(PRELOAD)).toBe(false);
  });
});
