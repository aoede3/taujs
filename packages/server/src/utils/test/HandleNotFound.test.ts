// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleNotFound } from '../HandleNotFound';
import { SSRTAG } from '../../constants';
import * as System from '../../core/system/System';

describe('handleNotFound', () => {
  let req: any;
  let reply: any;

  const makeTemplate = () => `<html><head>${SSRTAG.ssrHead}</head><body><div id="root">${SSRTAG.ssrHtml}</div></body></html>`;

  beforeEach(() => {
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(false);

    req = {
      raw: { url: '/no-route' },
      url: '/no-route',
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

  it('throws wrapped AppError when no default config exists', async () => {
    await expect(
      handleNotFound(
        req,
        reply,
        [], // no configs
        {
          cssLinks: new Map(),
          bootstrapModules: new Map(),
          templates: new Map(),
        },
      ),
    ).rejects.toThrowError(/handleNotFound failed/);
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

  it('does not inject css in development, but injects initial data + bootstrap with nonce when provided', async () => {
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
    // Map lacks template -> ensureNonNull throws; catch wraps with AppError.internal
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
          templates: new Map(), // no '/missing' key -> ensureNonNull throws
        },
      ),
    ).rejects.toThrow(/handleNotFound failed/);
  });

  it('handles req.raw.url undefined (does not mistake as asset) and renders', async () => {
    req.raw.url = undefined; // exercises the `?? ''` path and skips asset guard
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
    // dev
    vi.spyOn(System, 'isDevelopment', 'get').mockReturnValue(true);

    // CSP nonce on request
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
});
