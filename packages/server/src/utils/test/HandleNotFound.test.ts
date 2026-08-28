// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SSRTAG } from '../../constants';
import * as System from '../../System';

import { handleNotFound } from '../HandleNotFound';

describe('handleNotFound', () => {
  let req: any;
  let reply: any;

  const makeTemplate = () => `<html><head>${SSRTAG.ssrHead}</head><body><div id="root">${SSRTAG.ssrHtml}</div></body></html>`;

  beforeEach(() => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

    req = {
      raw: { url: '/no-route' },
      url: '/no-route',
      headers: { host: 'example.test' },
    };

    reply = {
      callNotFound: vi.fn(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
  });

  it('short-circuits for asset-like URLs', async () => {
    req.raw.url = '/static/image.png';

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      {
        cssLinks: new Map([['/app', '<link rel="stylesheet" href="/app.css">']]),
        bootstrapModules: new Map([['/app', '/assets/entry-client.js']]),
        templates: new Map([['/app', makeTemplate()]]),
      },
    );

    expect(reply.callNotFound).toHaveBeenCalledTimes(1);
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('does not treat a query string ending in a filename as an asset (serves fallback)', async () => {
    req.raw.url = '/search?q=file.txt';
    req.url = '/search?q=file.txt';

    const debug = vi.fn();

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      {
        cssLinks: new Map([['/app', '<link rel="stylesheet" href="/app.css">']]),
        bootstrapModules: new Map([['/app', '/assets/entry-client.js']]),
        templates: new Map([['/app', makeTemplate()]]),
      },
      { logger: { debug, error: vi.fn(), warn: vi.fn() } as any },
    );

    expect(reply.callNotFound).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('ssr', { status: 200, appId: 'a' }, 'Sending not-found fallback HTML');
  });

  it('throws wrapped AppError when no default config exists', async () => {
    let caught: any;
    try {
      await handleNotFound(
        req,
        reply,
        [], // no configs
        {
          cssLinks: new Map(),
          bootstrapModules: new Map(),
          templates: new Map(),
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toBe('handleNotFound failed');
    expect(caught.cause?.message).toBe('No default configuration found');
    expect(caught.cause?.details).toEqual({ configCount: 0, url: '/no-route' });
    expect(caught.cause?.cause).toBeUndefined();
  });

  it('injects css in production and no scripts when no bootstrapModule', async () => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

    const cssLinks = new Map([['/app', '<link rel="stylesheet" href="/prod.css">']]);
    const bootstrapModules = new Map();
    const templates = new Map([['/app', makeTemplate()]]);

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      { cssLinks, bootstrapModules, templates },
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.type).toHaveBeenCalledWith('text/html');

    const html = reply.send.mock.calls[0][0] as string;
    expect(html).toContain('<link rel="stylesheet" href="/prod.css"></head>');
    expect(html).not.toMatch(/<script[^>]*src=/);
    expect(html).not.toContain('window.__INITIAL_DATA__');
  });

  it('does not inject css in development, but injects bootstrap with nonce when provided', async () => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

    (req as any).cspNonce = 'nonce-xyz';

    const cssLinks = new Map([['/app', '<link rel="stylesheet" href="/dev.css">']]);
    const bootstrapModules = new Map([['/app', '/assets/client.js']]);
    const templates = new Map([['/app', makeTemplate()]]);

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      { cssLinks, bootstrapModules, templates },
    );

    const html = reply.send.mock.calls[0][0] as string;

    expect(html).not.toContain('/dev.css');
    expect(html).not.toContain('window.__INITIAL_DATA__');
    expect(html).toContain('<script nonce="nonce-xyz" type="module" src="/assets/client.js" defer>');
  });

  it('omits nonce attribute when absent', async () => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

    const cssLinks = new Map();
    const bootstrapModules = new Map([['/app', '/assets/client.js']]);
    const templates = new Map([['/app', makeTemplate()]]);

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      { cssLinks, bootstrapModules, templates },
    );

    const html = reply.send.mock.calls[0][0] as string;
    const scriptTag = html.match(/<script[^>]*type="module"[^>]*>/)?.[0] ?? '';
    expect(scriptTag).toContain('src="/assets/client.js"');
    expect(scriptTag).not.toContain('nonce=');
  });

  it('wraps template lookup errors via AppError.internal', async () => {
    await expect(
      handleNotFound(
        req,
        reply,
        [
          {
            clientRoot: '/missing',
            appId: 'a',
            entryPoint: 'x',
            entryClient: 'e',
            entryServer: 's',
            htmlTemplate: 'index.html',
          } as any,
        ],
        {
          cssLinks: new Map(),
          bootstrapModules: new Map(),
          templates: new Map(), // no '/missing' key -> requireTemplate throws
        },
      ),
    ).rejects.toThrow(/handleNotFound failed/);
  });

  it('carries a retained template load failure as the nested AppError cause', async () => {
    const retained = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    let caught: any;
    try {
      await handleNotFound(
        req,
        reply,
        [
          {
            clientRoot: '/missing',
            appId: 'a',
            entryPoint: 'x',
            entryClient: 'e',
            entryServer: 's',
            htmlTemplate: 'index.html',
          } as any,
        ],
        {
          cssLinks: new Map(),
          bootstrapModules: new Map(),
          templates: new Map(),
          templateLoadFailures: new Map([['/missing', retained]]),
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // handleNotFound wraps every error unconditionally (unlike handleRender's AppError-preserving
    // catch), so the retained failure surfaces one layer down: the immediate cause is the
    // "Template not found" AppError requireTemplate raised, and ITS cause is the retained value.
    expect(caught.message).toBe('handleNotFound failed');
    expect(caught.cause?.message).toBe('Template not found for clientRoot: /missing');
    expect(caught.cause?.cause).toBe(retained);
  });

  it('leaves the cause undefined when nothing was retained for the missing template', async () => {
    let caught: any;
    try {
      await handleNotFound(
        req,
        reply,
        [
          {
            clientRoot: '/missing',
            appId: 'a',
            entryPoint: 'x',
            entryClient: 'e',
            entryServer: 's',
            htmlTemplate: 'index.html',
          } as any,
        ],
        {
          cssLinks: new Map(),
          bootstrapModules: new Map(),
          templates: new Map(),
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.cause?.message).toBe('Template not found for clientRoot: /missing');
    expect(caught.cause?.cause).toBeUndefined();
  });

  it('handles req.raw.url undefined (does not mistake as asset) and renders', async () => {
    req.raw.url = undefined;

    const cssLinks = new Map();
    const bootstrapModules = new Map();
    const templates = new Map([['/app', makeTemplate()]]);

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      { cssLinks, bootstrapModules, templates },
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalled();
  });

  it('dev: does NOT inject CSS and does NOT set __INITIAL_DATA__, but injects bootstrap with nonce', async () => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

    (req as any).cspNonce = 'nonce-xyz';

    const cssLinks = new Map([['/app', '<link rel="stylesheet" href="/dev.css">']]);
    const bootstrapModules = new Map([['/app', '/assets/client.js']]);
    const templates = new Map([['/app', makeTemplate()]]);

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      { cssLinks, bootstrapModules, templates },
    );

    const html = reply.send.mock.calls[0][0] as string;

    expect(html).not.toContain('/dev.css');
    expect(html).not.toContain('window.__INITIAL_DATA__');
    expect(html).toContain('<script nonce="nonce-xyz" type="module" src="/assets/client.js" defer>');

    expect(html).not.toContain('<!--ssr-head-->');
    expect(html).not.toContain('<!--ssr-html-->');
    expect(html).toMatch(/<div id="root"><\/div>/);
  });

  it('prod: injects CSS, does NOT set __INITIAL_DATA__, and injects bootstrap with nonce', async () => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

    (req as any).cspNonce = 'nonce-abc';

    const cssLinks = new Map([['/app', '<link rel="stylesheet" href="/prod.css">']]);
    const bootstrapModules = new Map([['/app', '/assets/client.js']]);
    const templates = new Map([['/app', makeTemplate()]]);

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      { cssLinks, bootstrapModules, templates },
    );

    const html = reply.send.mock.calls[0][0] as string;

    expect(html).toContain('<link rel="stylesheet" href="/prod.css">');
    expect(html).not.toContain('window.__INITIAL_DATA__');
    expect(html).toContain('<script nonce="nonce-abc" type="module" src="/assets/client.js" defer>');

    expect(html).not.toContain('<!--ssr-head-->');
    expect(html).not.toContain('<!--ssr-html-->');
    expect(html).toMatch(/<div id="root"><\/div>/);
  });

  it('dev: strips the vite client tag but keeps an author style tag BEFORE transformIndexHtml, and uses pathname url', async () => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

    // ensure url parsing hits the pathname branch
    req.url = '/some/path?x=1';
    req.headers = { host: 'example.test' };

    const templateWithAuthorStyle = `
      <html>
        <head>
          ${SSRTAG.ssrHead}
          <script type="module" src="/@vite/client"></script>
          <style type="text/css">.author{}</style>
        </head>
        <body>
          <div id="root">${SSRTAG.ssrHtml}</div>
        </body>
      </html>
    `;

    let seenByTransform = '';
    const transformIndexHtml = vi.fn(async (url: string, html: string) => {
      seenByTransform = html;

      // the vite client tag is still deduped ahead of transformIndexHtml's own injection
      expect(html).not.toContain('<script type="module" src="/@vite/client"></script>');

      // prove we passed pathname, not full url with query
      expect(url).toBe('/some/path');

      return html;
    });

    const viteDevServer = { transformIndexHtml } as any;

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      {
        cssLinks: new Map([['/app', '<link rel="stylesheet" href="/dev.css">']]),
        bootstrapModules: new Map(), // keep this empty so we isolate dev branch behaviour
        templates: new Map([['/app', templateWithAuthorStyle]]),
      },
      { viteDevServer },
    );

    expect(transformIndexHtml).toHaveBeenCalledTimes(1);
    expect(reply.send).toHaveBeenCalledTimes(1);
    expect(seenByTransform).toContain('.author{}');

    const finalHtml = reply.send.mock.calls[0][0] as string;
    expect(finalHtml).toContain('.author{}');
  });

  it('dev: injects nonce onto <script> tags lacking one after transformIndexHtml; does not double-inject; url "/" when req.url missing', async () => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

    (req as any).cspNonce = 'nonce-xyz';

    // cover: req.url ? ... : '/'
    req.url = undefined;
    req.headers = { host: 'example.test' };

    const transformIndexHtml = vi.fn(async (url: string, html: string) => {
      expect(url).toBe('/');

      // Return HTML containing scripts with/without nonce to exercise:
      // processedTemplate.replace(/<script(?!...nonce=)([^>]*)>/g, ...)
      return `
        ${html}
        <script type="module" src="/a.js"></script>
        <script nonce="keep-me" src="/b.js"></script>
        <script>console.log("inline")</script>
      `;
    });

    const viteDevServer = { transformIndexHtml } as any;

    await handleNotFound(
      req,
      reply,
      [
        {
          clientRoot: '/app',
          appId: 'a',
          entryPoint: 'x',
          entryClient: 'e',
          entryServer: 's',
          htmlTemplate: 'index.html',
        } as any,
      ],
      {
        cssLinks: new Map(),
        bootstrapModules: new Map(),
        templates: new Map([['/app', makeTemplate()]]),
      },
      { viteDevServer },
    );

    const out = reply.send.mock.calls[0][0] as string;

    // a.js script gets injected nonce
    expect(out).toContain('<script nonce="nonce-xyz" type="module" src="/a.js"></script>');

    // existing nonce preserved and not duplicated
    expect(out).toContain('<script nonce="keep-me" src="/b.js"></script>');
    expect(out).not.toContain('nonce="nonce-xyz" nonce="keep-me"');

    // inline script also gets nonce (your regex will add it)
    expect(out).toContain('<script nonce="nonce-xyz">console.log("inline")</script>');
  });
});
