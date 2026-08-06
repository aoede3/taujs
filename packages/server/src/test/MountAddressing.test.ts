// @vitest-environment node
/**
 * RFC 0012 PR 1 acceptance - installation-level addressing: canonical validation,
 * the Fastify scope-prefix mount, emission composition and the ownership contracts.
 *
 * Cell numbering follows the RFC §6 suite. The strip/preserve DEVELOPMENT cells and the
 * Vite pathname projection are PR 2 (one coordinated release gate); everything here is
 * provable on the production path plus unit-level emission.
 *
 * Mutation standard: reverting the scope prefix fails the preserve cells; reverting
 * emission composition fails the strip-shape and entryPoint-composition cells; reverting
 * validation fails the canonical cells; reverting fp's `mounted` encapsulation switch
 * fails the created-host confinement cells (prefix would silently stop applying).
 */
import { afterAll, describe, expect, it } from 'vitest';

import fastify from 'fastify';

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../CreateServer';
import { TEMPLATE } from '../constants';
import { extractPathCoordinates, viteBaseFor } from '../core/config/Setup';
import { createMaps, loadAssets, processConfigs } from '../utils/AssetManager';
import { buildTaujsDevStamp } from '../utils/Templates';
import { testRenderer } from './support/renderer';
import { OWNER, PATHS, TAUJS_ASSET_PATH, closeAll, createCreatedHost, createEmbeddedHost, productionFixture, taujsConfig } from './support/hostOwnership';

import type { AppConfig, TaujsConfig } from '../Config';
import type { AppRoute } from '../core/config/types';

afterAll(closeAll);

/** The support config plus a server block and (optionally) extra first-app routes. */
const withAddressing = (server: NonNullable<TaujsConfig['server']>, extraRoutes: readonly AppRoute[] = [], base: TaujsConfig = taujsConfig()): TaujsConfig => {
  // `TaujsConfig['apps']` is an intersection whose first arm types `renderer` as `unknown`;
  // pin the AppConfig arm so the mapped copy keeps the refined element type.
  const apps: readonly AppConfig[] = base.apps;

  return {
    ...base,
    server,
    apps: apps.map((app, index): AppConfig => (index === 0 ? { ...app, routes: [...(app.routes ?? []), ...extraRoutes] } : app)),
  };
};

const ROOT_ROUTE: AppRoute = { path: '/', attr: { render: 'ssr' } };

describe('RFC 0012 - canonical coordinate validation (cell 7)', () => {
  it('defaults to root addressing and inherits publicBasePath from mountPrefix', () => {
    expect(extractPathCoordinates({})).toEqual({ mountPrefix: '', publicBasePath: '' });
    expect(extractPathCoordinates({ server: {} })).toEqual({ mountPrefix: '', publicBasePath: '' });
    expect(extractPathCoordinates({ server: { mountPrefix: '/app' } })).toEqual({ mountPrefix: '/app', publicBasePath: '/app' });
    expect(extractPathCoordinates({ server: { mountPrefix: '', publicBasePath: '/pub' } })).toEqual({ mountPrefix: '', publicBasePath: '/pub' });
    expect(extractPathCoordinates({ server: { mountPrefix: '/a/b-2', publicBasePath: '/x_9' } })).toEqual({
      mountPrefix: '/a/b-2',
      publicBasePath: '/x_9',
    });
  });

  it.each([
    ['/', "'/' is not a value"],
    ['/app/', 'not canonical'],
    ['app', 'not canonical'],
    ['//app', 'not canonical'],
    ['/app//x', 'not canonical'],
    ['/a/../b', 'not canonical'],
    ['/.', "'/' is not a value|not canonical"],
    ['/a?b=c', 'not canonical'],
    ['/a#f', 'not canonical'],
    ['https://evil.example', 'not canonical'],
    ['/a b', 'not canonical'],
    ["/a'b", 'not canonical'],
  ])('rejects the non-canonical mountPrefix %j, never normalises it', (value, messagePattern) => {
    expect(() => extractPathCoordinates({ server: { mountPrefix: value } })).toThrow(new RegExp(messagePattern));
    expect(() => extractPathCoordinates({ server: { publicBasePath: value } })).toThrow(new RegExp(messagePattern));
  });

  it('rejects the inverse corner: explicit publicBasePath "" with a non-empty mountPrefix', () => {
    expect(() => extractPathCoordinates({ server: { mountPrefix: '/app', publicBasePath: '' } })).toThrow(/unsupported pending a real topology/);
    // The root spelling of the same shape is fine - both empty is simply the default.
    expect(extractPathCoordinates({ server: { mountPrefix: '', publicBasePath: '' } })).toEqual({ mountPrefix: '', publicBasePath: '' });
  });

  it('rejects non-string coordinates', () => {
    expect(() => extractPathCoordinates({ server: { mountPrefix: 5 as unknown as string } })).toThrow(/must be a string/);
    expect(() => extractPathCoordinates({ server: { publicBasePath: null as unknown as string } })).toThrow(/must be a string/);
  });

  it('enforces the FROZEN v1 charset: URI-unreserved segments only (PR-1 review ruling)', () => {
    // Sub-delimiters and percent-encoding are rejected in v1; widening is an RFC-level change.
    expect(() => extractPathCoordinates({ server: { mountPrefix: '/@team' } })).toThrow(/not canonical/);
    expect(() => extractPathCoordinates({ server: { mountPrefix: '/a%20b' } })).toThrow(/not canonical/);
    expect(() => extractPathCoordinates({ server: { mountPrefix: '/a+b' } })).toThrow(/not canonical/);
    expect(extractPathCoordinates({ server: { mountPrefix: '/A-z0.9_~' } })).toEqual({ mountPrefix: '/A-z0.9_~', publicBasePath: '/A-z0.9_~' });
  });

  it('fails at function entry: no host state exists when a coordinate is invalid (PR-1 review)', async () => {
    // A caller-owned host must be untouched by a failed boot - validation precedes both
    // Fastify construction and any caller-host registration.
    const app = fastify({ logger: false });
    app.decorate('authenticate', async () => undefined);
    const before = app.printRoutes();

    await expect(createServer({ config: withAddressing({ mountPrefix: '/bad/' }), fastify: app, clientRoot: '/nowhere' })).rejects.toThrow(/not canonical/);

    expect(app.printRoutes()).toBe(before);
    await app.close();
  });
});

describe('RFC 0012 - viteBaseFor (verdict-round ruling; root compatibility by construction)', () => {
  const legacyFormula = (entryPoint: string) => (entryPoint ? `/${entryPoint}/` : '/');

  it('reproduces the pre-RFC Build.ts formula byte-for-byte when publicBasePath is ""', () => {
    // Including tolerated non-canonical entryPoint spellings - preserved, not endorsed.
    for (const entryPoint of ['', 'app', 'admin', 'nested/dir', '.', './x', 'x/', '/x']) {
      expect(viteBaseFor('', entryPoint)).toBe(legacyFormula(entryPoint));
    }
  });

  it('composes the canonical publicBasePath AROUND the existing entryPoint spelling', () => {
    expect(viteBaseFor('/app', '')).toBe('/app/');
    expect(viteBaseFor('/app', 'admin')).toBe('/app/admin/');
    expect(viteBaseFor('/app', 'nested/dir')).toBe('/app/nested/dir/');
    // Tolerated odd spelling passes through unchanged inside the composition.
    expect(viteBaseFor('/app', 'x/')).toBe('/app/x//');
  });
});

describe('RFC 0012 - beacon URL composition', () => {
  it('prefixes the beacon fetch with the emission coordinate, byte-identical at ""', () => {
    expect(buildTaujsDevStamp('rid', 'tok')).toContain("fetch('/__taujs/beacon'");
    expect(buildTaujsDevStamp('rid', 'tok', undefined, '')).toContain("fetch('/__taujs/beacon'");
    expect(buildTaujsDevStamp('rid', 'tok', undefined, '/mnt')).toContain("fetch('/mnt/__taujs/beacon'");
  });
});

describe('RFC 0012 - preserve cell: caller-owned host, mounted installation (cells 2, 7)', () => {
  it('serves every τjs surface under the mount and leaves the rest of the host to the caller', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer as never, withAddressing({ mountPrefix: '/mnt' }, [ROOT_ROUTE]));

    // Declared routes of the installation serve under the prefix...
    const page = await host.app.inject({ method: 'GET', url: `/mnt${PATHS.taujsPage}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(OWNER.taujsPage);

    // ...and the mount root serves for BOTH direct spellings (frozen contract, RFC §2 rule 5).
    expect((await host.app.inject({ method: 'GET', url: '/mnt' })).statusCode).toBe(200);
    expect((await host.app.inject({ method: 'GET', url: '/mnt/' })).statusCode).toBe(200);

    // τjs static (entryPoint 'app') composes on reception: /mnt + /app/assets/...
    const asset = await host.app.inject({ method: 'GET', url: `/mnt${TAUJS_ASSET_PATH}` });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain(OWNER.taujsPage);

    // Emission composes the SAME coordinate (publicBasePath defaults to mountPrefix).
    expect(page.body).toContain(`/mnt${TAUJS_ASSET_PATH}`);

    // The unprefixed spellings belong to the CALLER: its not-found answers, not τjs.
    const outsidePage = await host.app.inject({ method: 'GET', url: PATHS.taujsPage });
    expect(outsidePage.statusCode).toBe(404);
    expect(outsidePage.body).toContain(OWNER.callerNotFound);
    const outsideAsset = await host.app.inject({ method: 'GET', url: TAUJS_ASSET_PATH });
    expect(outsideAsset.statusCode).toBe(404);

    // Caller routes at the host root are untouched by the mount.
    expect((await host.app.inject({ method: 'GET', url: PATHS.callerBefore })).statusCode).toBe(200);
    expect((await host.app.inject({ method: 'GET', url: PATHS.callerAfter })).statusCode).toBe(200);

    // Misses INSIDE the mount also stay the caller's (no τjs shell on a caller-owned host).
    const insideMiss = await host.app.inject({ method: 'GET', url: '/mnt/pw-0012-unmatched' });
    expect(insideMiss.statusCode).toBe(404);
    expect(insideMiss.body).toContain(OWNER.callerNotFound);

    await host.close();
  });

  it('mounts a declared terminal wildcard under the prefix like any route (cell 2)', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer as never, withAddressing({ mountPrefix: '/mnt' }, [], taujsConfig({ wildcard: true })));

    expect((await host.app.inject({ method: 'GET', url: '/mnt/anything/nested' })).statusCode).toBe(200);
    // Outside the mount the wildcard does NOT exist: the caller's not-found answers.
    const outside = await host.app.inject({ method: 'GET', url: '/anything/nested' });
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toContain(OWNER.callerNotFound);

    await host.close();
  });
});

describe('RFC 0012 - strip-shape cell: emission differs from reception (cell 1, server half)', () => {
  it('emits under publicBasePath while receiving at the root mount', async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer as never, withAddressing({ mountPrefix: '', publicBasePath: '/pub' }, [ROOT_ROUTE]));

    // Reception unchanged: routes and static answer at the root, exactly as an upstream
    // behind a stripping proxy receives them.
    const page = await host.app.inject({ method: 'GET', url: PATHS.taujsPage });
    expect(page.statusCode).toBe(200);
    expect((await host.app.inject({ method: 'GET', url: TAUJS_ASSET_PATH })).statusCode).toBe(200);

    // Emission carries the PUBLIC coordinate: what a browser must be told.
    expect(page.body).toContain(`/pub${TAUJS_ASSET_PATH}`);
    expect(page.body).not.toContain(`src="${TAUJS_ASSET_PATH}`);

    await host.close();
  });
});

describe('RFC 0012 - root byte-compatibility (cell 4, response level)', () => {
  it("emits today's root-absolute URLs exactly when both coordinates default", async () => {
    const host = await createEmbeddedHost();
    await host.activate(createServer as never, withAddressing({}, [ROOT_ROUTE]));

    const page = await host.app.inject({ method: 'GET', url: PATHS.taujsPage });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`src="${TAUJS_ASSET_PATH}"`);

    await host.close();
  });
});

describe('RFC 0012 - created-host confinement (cells 6, frozen ownership contract)', () => {
  it('confines the SPA fallback to the mounted subtree and answers an ordinary 404 outside', async () => {
    const host = await createCreatedHost();
    const { app } = await host.activate(createServer as never, withAddressing({ mountPrefix: '/mnt' }, [ROOT_ROUTE]));
    expect(app).toBeDefined();

    // Inside the subtree: pages serve, and an extensionless miss gets the confined shell -
    // whose emitted URLs carry the mount.
    expect((await app!.inject({ method: 'GET', url: `/mnt${PATHS.taujsPage}` })).statusCode).toBe(200);
    const shell = await app!.inject({ method: 'GET', url: '/mnt/pw-0012-unmatched' });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain(`/mnt${TAUJS_ASSET_PATH}`);

    // The extension heuristic is unchanged INSIDE the subtree.
    expect((await app!.inject({ method: 'GET', url: '/mnt/looks.like.file' })).statusCode).toBe(404);

    // OUTSIDE the subtree: an ordinary 404, never the shell - one mounted installation
    // does not claim unrelated host URLs.
    const outside = await app!.inject({ method: 'GET', url: '/pw-0012-unmatched' });
    expect(outside.statusCode).toBe(404);
    expect(outside.headers['content-type']).not.toContain('text/html');
    expect(outside.body).not.toContain('<main');

    await host.close();
  });

  it('keeps the unmounted created host byte-compatible: whole-server shell at the root', async () => {
    const host = await createCreatedHost();
    const { app } = await host.activate(createServer as never, withAddressing({}, [ROOT_ROUTE]));

    const shell = await app!.inject({ method: 'GET', url: '/pw-0012-unmatched' });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain(`src="${TAUJS_ASSET_PATH}"`);

    await host.close();
  });
});

describe('RFC 0012 - loadAssets emission regression (PR-1 review, finding 4)', () => {
  // The runtime cells above primarily prove the bootstrap URL; this proves ALL THREE emission
  // maps - bootstrap, CSS links and preload links - receive the coordinate at the seam.
  const emissionFixture = async (): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'taujs-rfc0012-emission-'));
    const clientRoot = path.join(root, 'client');
    const appRoot = path.join(clientRoot, 'app');
    const ssrRoot = path.join(root, 'ssr', 'app');

    await mkdir(path.join(appRoot, '.vite'), { recursive: true });
    await mkdir(path.join(ssrRoot, '.vite'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      path.join(appRoot, 'index.html'),
      '<!doctype html><html><head><!--ssr-head--></head><body><div id="app"><!--ssr-html--></div></body></html>',
    );
    await writeFile(
      path.join(appRoot, '.vite', 'manifest.json'),
      JSON.stringify({ 'entry-client.ts': { file: 'assets/rfc0012-client.js', css: ['assets/rfc0012.css'] } }),
    );
    await writeFile(path.join(ssrRoot, '.vite', 'ssr-manifest.json'), JSON.stringify({ 'some-module': ['assets/rfc0012-preload.js', 'assets/rfc0012.css'] }));
    await writeFile(
      path.join(ssrRoot, 'entry-server.js'),
      [
        "const tag = Symbol.for('taujs.render-contract/v1');",
        "const brand = (fn) => Object.defineProperty(fn, tag, { value: { key: 'test', contractVersion: 'v1' } });",
        "export const renderSSR = brand(async () => ({ headContent: '', appHtml: '' }));",
        'export const renderStream = brand(() => ({ abort() {}, done: Promise.resolve() }));',
      ].join('\n'),
    );

    return clientRoot;
  };

  const runLoadAssets = async (clientRoot: string, publicBasePath: string) => {
    const processed = processConfigs([{ appId: 'emission', entryPoint: 'app', renderer: testRenderer() }], clientRoot, TEMPLATE);
    const maps = createMaps();

    await loadAssets(
      processed,
      clientRoot,
      maps.bootstrapModules,
      maps.cssLinks,
      maps.manifests,
      maps.preloadLinks,
      maps.renderModules,
      maps.ssrManifests,
      maps.templates,
      { publicBasePath },
    );

    const key = processed[0]!.clientRoot;
    return { bootstrap: maps.bootstrapModules.get(key), css: maps.cssLinks.get(key), preload: maps.preloadLinks.get(key) };
  };

  it('composes publicBasePath into bootstrap, CSS and preload maps alike', async () => {
    const clientRoot = await emissionFixture();
    const { bootstrap, css, preload } = await runLoadAssets(clientRoot, '/pub');

    expect(bootstrap).toBe('/pub/app/assets/rfc0012-client.js');
    expect(css).toContain('href="/pub/app/assets/rfc0012.css"');
    expect(preload).toContain('href="/pub/app/assets/rfc0012-preload.js"');
    expect(preload).toContain('href="/pub/app/assets/rfc0012.css"');
  });

  it('keeps all three maps byte-compatible with today at the default coordinate', async () => {
    const clientRoot = await emissionFixture();
    const { bootstrap, css, preload } = await runLoadAssets(clientRoot, '');

    expect(bootstrap).toBe('/app/assets/rfc0012-client.js');
    expect(css).toContain('href="/app/assets/rfc0012.css"');
    expect(preload).toContain('href="/app/assets/rfc0012-preload.js"');
    expect(preload).toContain('href="/app/assets/rfc0012.css"');
  });
});

describe('RFC 0012 - static composition (cell 8, semantic preservation)', () => {
  it('composes a caller-supplied static prefix with the mount and keeps a meaningful option working', async () => {
    const assetRoot = await mkdtemp(path.join(os.tmpdir(), 'taujs-rfc0012-static-'));
    await writeFile(path.join(assetRoot, 'cell8.txt'), 'RFC0012_STATIC_CELL8\n');

    const app = fastify({ logger: false });
    app.decorate('authenticate', async () => undefined);
    app.setNotFoundHandler(async (_req, reply) => reply.status(404).send({ owner: OWNER.callerNotFound }));

    const clientRoot = await productionFixture();
    const fastifyStatic = await import('@fastify/static');
    await createServer({
      config: withAddressing({ mountPrefix: '/mnt' }),
      fastify: app,
      clientRoot,
      staticAssets: {
        plugin: fastifyStatic.default,
        options: {
          root: assetRoot,
          prefix: '/cdn/',
          index: false,
          setHeaders: (res: { setHeader: (k: string, v: string) => void }) => res.setHeader('x-rfc0012-static', 'cell8'),
        },
      },
    });

    // The registration's effective route COMPOSES with the installation mount (Fastify used
    // normally), and the caller's own option still takes effect there.
    const composed = await app.inject({ method: 'GET', url: '/mnt/cdn/cell8.txt' });
    expect(composed.statusCode).toBe(200);
    expect(composed.body).toContain('RFC0012_STATIC_CELL8');
    expect(composed.headers['x-rfc0012-static']).toBe('cell8');

    // The host-root spelling is NOT claimed by τjs; the documented escape is
    // staticAssets:false plus a caller registration on the host they own.
    const hostRoot = await app.inject({ method: 'GET', url: '/cdn/cell8.txt' });
    expect(hostRoot.statusCode).toBe(404);
    expect(hostRoot.body).toContain(OWNER.callerNotFound);

    await app.close();
  });
});
