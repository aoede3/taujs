import path from 'node:path';

import { CONTENT } from '../constants';
import { selectedRouteFrom } from '../core/routes/FastifyRoutes';
import { createLogger } from '../logging/Logger';
import { overrideCSSHMRConsoleError } from './Templates';
import { layerAlias } from './ViteAlias';
import { normalisePlugins } from './ViteMergeEngine';
import { findFormerlyDiscoveredViteConfig, formerlyDiscoveredViteConfigWarning } from './ViteConfigDiscovery';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { InlineConfig, ViteDevServer } from 'vite';
import type { DebugConfig, Logs } from '../core/logging/types';
import type { MediatedHmrController } from './MediatedHmr';

/**
 * RFC 0005 VS4 - `setupDevServer` options.
 *
 * Refactored OFF positional parameters (the surface kept growing: `alias`, `debug`, `devNet`,
 * `plugins`, then VS5's trailing `declarativeAlias`). One options object, so future dev-config
 * widening never reshuffles argument positions again.
 */
export type SetupDevServerOptions = {
  app: FastifyInstance;
  /**
   * RFC 0010. Embedded development only. Owns the single caller-root `onRequest` hook which
   * delegates otherwise-unmatched requests to the τjs-owned Vite server, because root-level hooks
   * are the only ones Fastify runs for a URL it did not route. Omitted on every other path, where
   * the hook lands on `app` exactly as before. It must not be used for routing, policy, tracing,
   * errors or lifecycle. Narrowed to `addHook` so that restriction is enforced by the compiler.
   */
  viteRequestHookOwner?: Pick<FastifyInstance, 'addHook'>;
  /** The shared client base root (dev `root` invariant + framework alias base). */
  clientRoot: string;
  /** Programmatic escape-hatch alias (`createServer({ alias })`) - the TOP alias layer (VS5). */
  alias?: Record<string, string>;
  /** Declarative `config.alias` (VS5) - layered UNDER the programmatic alias. */
  declarativeAlias?: Record<string, string>;
  /**
   * Project root that relative declarative alias values resolve against (RFC 0005 §3). Must be the
   * SAME directory the caller passes to `taujsBuild({ projectRoot })`, or dev and build resolve a
   * relative `config.alias` to different absolute paths (monorepo shape: dev cwd `/repo`, build
   * projectRoot `/repo/apps/shop`). Defaults to `process.cwd()` for compatibility.
   */
  projectRoot?: string;
  debug?: DebugConfig;
  /** Internal runtime logger selected by createServer. */
  logger?: Logs;
  devNet?: { host: string; hmrPort: number };
  /**
   * The resolved, engine-merged dev Vite fragment (VS4), assembled ONCE in `SSRServer` via
   * `resolveDevViteConfig`: `plugins` (apps -> config.vite), `define`, `css` (scss `modern-compiler`
   * default merged with any user `css.preprocessorOptions`), `esbuild`, `logLevel`, `optimizeDeps`,
   * non-`alias` `resolve` keys, and the admitted `server.*` fields. Framework invariants (`root`,
   * `appType`, `configFile`, `mode`, `resolve.alias`) are applied HERE and NEVER read from this
   * fragment - as are `server.middlewareMode` and `server.hmr`, which are applied on top of whatever
   * `server.*` the fragment carries.
   */
  viteConfig?: InlineConfig;
  /**
   * RFC 0012 (PR 2): the installation's RECEPTION coordinate, single-sourced from Fastify
   * (`scope.prefix` of the one τjs registration). When non-empty, the delegator's domain is
   * CONFINED to the mounted subtree - outside the subtree is not τjs's to answer (the dev
   * face of the frozen ownership contract). No request rewriting happens: pinned Vite's
   * middleware mode natively accepts BOTH public-prefixed and proxy-stripped request paths
   * (base mismatch → plain `next()` into its own transform/static middlewares).
   */
  mountPrefix?: string;
  /**
   * RFC 0012 (PR 2): the installation's validated EMISSION coordinate. Derives the shared dev
   * Vite `base` (`publicBasePath + '/'`), which carries dev module URLs and the HMR socket
   * PATHNAME.
   */
  publicBasePath?: string;
  /**
   * RFC 0013/0014: the resolved development HMR transport. `'fixed-port'` (default) keeps the
   * dedicated `hmrPort` listener; `'attached'` carries the socket on the application's own
   * HTTP server via Vite's canonical `server.ws.server`, so it flows wherever that channel
   * flows; `'mediated'` hands Vite the internal source `mediatedHmr` owns instead. Resolved
   * and validated in `createServer` - by the time it arrives here the ownership check has
   * already passed.
   */
  hmrTransport?: 'fixed-port' | 'attached' | 'mediated';
  /**
   * RFC 0014: the mediated-HMR controller built once by `createServer`. Present (and active)
   * only when `hmrTransport` is `'mediated'`; its never-listened `source` becomes Vite's
   * `server.ws.server` and its `noteClientServed` is called on successful delivery of Vite's
   * client module, purely as an observation - it changes no request-ownership behaviour here.
   */
  mediatedHmr?: MediatedHmrController;
};

export const setupDevServer = async (options: SetupDevServerOptions): Promise<ViteDevServer> => {
  const { app, clientRoot: baseClientRoot, alias, declarativeAlias, projectRoot, debug, devNet, viteConfig } = options;
  const mountPrefix = options.mountPrefix ?? '';
  const hmrTransport = options.hmrTransport ?? 'fixed-port';
  const publicBasePath = options.publicBasePath ?? '';
  const mediatedHmr = options.mediatedHmr;

  // RFC 0014: internal invariant, not a caller-facing configuration error - `createServer`
  // (CreateServer.ts) only resolves `hmrTransport: 'mediated'` together with an ACTIVE
  // controller, so `mediatedHmr?.source` being absent here means that wiring broke, not that the
  // caller did anything wrong. Fail fast rather than handing Vite `{ server: undefined }`: in
  // middlewareMode Vite would silently fall back to binding its OWN WebSocket listener on 24678,
  // exactly the dedicated-port bind 'mediated' exists to avoid.
  if (hmrTransport === 'mediated' && !mediatedHmr?.source) {
    throw new Error(
      "τjs internal invariant violated: hmrTransport 'mediated' reached setupDevServer without an active MediatedHmr controller (missing `source`). " +
        'This is a τjs defect, not a configuration error - please report it.',
    );
  }

  const logger =
    options.logger ??
    createLogger({
      context: { service: 'setupDevServer' },
      debug,
      minLevel: 'debug',
    });

  const host = devNet?.host ?? process.env.HOST?.trim() ?? process.env.FASTIFY_ADDRESS?.trim() ?? 'localhost';
  const hmrPort = devNet?.hmrPort ?? (Number(process.env.HMR_PORT) || 5174);

  // Migration detection: with configFile: false pinned below, Vite no longer probes the client
  // base root that it used to search on τjs's behalf. Warn if a vite.config.* still sits there,
  // so its silent behaviour loss is visible. Project-root files were never read and are exempt.
  const discovered = findFormerlyDiscoveredViteConfig(baseClientRoot);
  if (discovered) logger.warn({ file: discovered }, formerlyDiscoveredViteConfigWarning(discovered));

  // RFC 0005 §3 (VS5): one shared alias layering - framework defaults, then declarative
  // `config.alias` (relative values normalised against the project root), then the programmatic
  // `createServer({ alias })` option on top. The project root is threaded from the caller
  // (createServer -> SSRServer -> here), falling back to `process.cwd()`; thread the same value
  // `taujsBuild({ projectRoot })` receives so dev and build resolve identically.
  const resolvedAlias = layerAlias({
    defaults: {
      '@client': path.resolve(baseClientRoot),
      '@server': path.resolve(baseClientRoot, '../server'),
      '@shared': path.resolve(baseClientRoot, '../shared'),
    },
    declarative: declarativeAlias,
    programmatic: alias,
    projectRoot: projectRoot ?? process.cwd(),
    onDeclarativeOverride: (key) => logger.debug('vite', { alias: key }, 'Programmatic alias overrides declarative config.alias'),
  });

  const { createServer } = await import('vite');

  // Split the engine-merged fragment (VS4) into its admitted dev fields. `build` (an empty `{}` the
  // engine spreads from the framework layer) and the invariant carriers are dropped; everything else
  // (`define`, `esbuild`, `logLevel`, `optimizeDeps`) rides through untouched in `...admittedDevFields`.
  const { build: _ignoredBuild, plugins: mergedPlugins, resolve: mergedResolve, css: mergedCss, server: mergedServer, ...admittedDevFields } = viteConfig ?? {};

  const viteDevServer = await createServer({
    ...admittedDevFields,
    appType: 'custom',
    configFile: false,
    // scss `modern-compiler` default. Normally the fragment already carries it (merged with any user
    // `css.preprocessorOptions` in the engine); the fallback covers a direct call with no fragment.
    css: mergedCss ?? {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    mode: 'development',
    plugins: [
      // The fragment's `plugins` arrive already composed + deduped by composePlugins (RFC 0005 §5,
      // SSRServer: apps -> config.vite sources) and engine-merged (VS4). The internal debug-logging
      // plugin below is appended LAST - the framework's pinned-last position by contract (§5),
      // exempt from user dedupe, and the reserved `τjs-` prefix it carries is why a user plugin can
      // never impersonate it (composePlugins drops user `τjs-` plugins upstream).
      ...normalisePlugins(mergedPlugins),
      ...(debug
        ? [
            {
              name: 'τjs-development-server-debug-logging',
              configureServer(server: ViteDevServer) {
                logger.debug('vite', `${CONTENT.TAG} Development server debug started`);

                server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
                  logger.debug(
                    'vite',
                    {
                      method: req.method,
                      url: req.url,
                      host: req.headers.host,
                      ua: req.headers['user-agent'],
                    },
                    '← rx',
                  );

                  res.on('finish', () => {
                    logger.debug(
                      'vite',
                      {
                        method: req.method,
                        url: req.url,
                        statusCode: res.statusCode,
                      },
                      '→ tx',
                    );
                  });

                  next();
                });
              },
            },
          ]
        : []),
    ],
    resolve: {
      ...(mergedResolve ?? {}),
      alias: resolvedAlias,
    },
    root: baseClientRoot,
    // RFC 0012 (PR 2): the shared dev base derives from the installation's emission coordinate,
    // carrying dev module URLs AND the HMR socket PATHNAME with it. `''` yields `'/'` - Vite's
    // own default, byte-compatible. A framework invariant like `root`: the engine already
    // protects `base` from user layers in both profiles, and that ruling is unchanged.
    base: `${publicBasePath}/`,
    // MERGE, never replace. Writing this object whole discarded every declared `server.*` field,
    // `allowedHosts` among them - so development behind a proxy presenting a non-localhost `Host`
    // was unreachable, with no supported way to allow it.
    //
    // The framework stays authoritative for exactly two fields, applied AFTER the spread so no
    // declared value can displace them. The WebSocket block is replaced WHOLE rather than
    // deep-merged: a half-user, half-framework socket configuration would pair a user port with a
    // framework host and fail in a way that looks like a τjs bug. The merge engine already warns
    // on both. Vite 8's canonical surface is `server.ws`; the deprecated `server.hmr` spelling is
    // not used on either arm.
    server: {
      ...mergedServer,
      middlewareMode: true,
      // RFC 0013/0014: one selection, and nothing else. `attached` hands Vite the application's
      // own server through the canonical Vite 8 `server.ws` surface and declares no port at all -
      // Vite then serves `hmrPort = null`, so the client derives its socket from the origin that
      // served it. `mediated` hands Vite the internal, never-listened source `mediatedHmr` owns,
      // for exactly the same reason - no port declared, same derived dial. `hmr` is OMITTED in
      // both arms rather than set false, which would disable HMR instead of attaching it. The
      // fixed-port arm is unchanged.
      ws:
        hmrTransport === 'mediated'
          ? { server: mediatedHmr?.source }
          : hmrTransport === 'attached'
            ? { server: app.server }
            : {
                clientPort: hmrPort,
                host: host !== 'localhost' ? host : undefined,
                port: hmrPort,
                protocol: 'ws',
              },
    },
  });

  overrideCSSHMRConsoleError();

  /**
   * Caller-owned host: Vite must not answer a request the CALLER's own route was selected for -
   * that is how a caller route ended up returning Vite's 403 block page behind a proxy.
   *
   * `request.is404` is Fastify's existing selection result, read rather than recomputed, so no
   * second lookup can disagree with it. Declared τjs pages deliberately STAY in the middleware
   * path: they are selected too, and skipping it would also skip Vite's host check for them.
   */
  const callerOwnedRootDelegator = options.viteRequestHookOwner !== undefined;

  (options.viteRequestHookOwner ?? app).addHook('onRequest', async (request, reply) => {
    // Classification is only meaningful on the caller-owned root delegator; the created-host path
    // stays exactly as it was, including never reading the request's route identity.
    if (callerOwnedRootDelegator && !request.is404 && selectedRouteFrom(request) === null) return;

    // RFC 0012 (PR 2): when mounted, the delegator's DOMAIN is the mounted subtree - an
    // out-of-mount URL is not τjs's to answer (frozen ownership contract), so it never
    // reaches Vite and falls straight through to the host's own handling. No request
    // rewriting: Vite's middleware mode accepts both public-prefixed and proxy-stripped
    // paths natively, so mount-space URLs are delegated AS RECEIVED.
    if (mountPrefix !== '') {
      const rawUrl = request.raw.url ?? '';
      const queryIndex = rawUrl.indexOf('?');
      const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
      if (!(pathname === mountPrefix || pathname.startsWith(`${mountPrefix}/`))) return;
    }

    // RFC 0014 §6: never-wired visibility. Purely observational - it reads nothing the delegator
    // does not already read, decides nothing about ownership, and is a no-op on every transport
    // other than an ACTIVE `mediated` one (`mediatedHmr?.source` is undefined otherwise). A
    // successful (2xx) delivery of Vite's client module starts the one-shot warning window.
    //
    // Two spellings are recognised, because a stripping proxy changes which one Fastify actually
    // receives (RFC 0012's two topologies): `${publicBasePath}/@vite/client` is the URL AS
    // EMITTED (preserve topology, where the proxy forwards the public prefix unchanged), while
    // `${mountPrefix}/@vite/client` is the URL AS RECEIVED at Fastify's own mount point (strip
    // topology, mountPrefix '' + publicBasePath non-empty: the proxy strips the public prefix
    // before forwarding, so Fastify sees the unprefixed path). The two are identical whenever
    // mountPrefix === publicBasePath, so this never double-fires in the common case.
    if (mediatedHmr?.source) {
      const rawUrl = request.raw.url ?? '';
      const queryIndex = rawUrl.indexOf('?');
      const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);

      if (pathname === `${publicBasePath}/@vite/client` || pathname === `${mountPrefix}/@vite/client`) {
        reply.raw.once('finish', () => {
          if (reply.raw.statusCode >= 200 && reply.raw.statusCode < 300) mediatedHmr.noteClientServed();
        });
      }
    }

    // Connect's `next()` is the ownership signal. Vite's middleware chain invokes this final
    // callback only when it ran out of middlewares without answering, so when Vite has served the
    // request the callback never runs and this promise is left pending on purpose: the hook chain
    // stops here and Fastify does not also route the request. Fastify's own `finish`/`error`
    // listeners on the raw response still run `onResponse` and cleanup independently of this hook.
    // The `reply.sent` guard is defensive only: if a middleware ended the response and still called
    // `next()`, it avoids settling the hook on an already-ended reply. Fastify itself skips the
    // remaining hooks and route dispatch once `reply.sent` is true. `reply.hijack()` cannot replace
    // this: ownership is unknown until Vite either calls `next()` or writes the raw response.
    await new Promise<void>((resolve) => {
      viteDevServer.middlewares(request.raw, reply.raw, () => {
        if (!reply.sent) resolve();
      });
    });
  });

  return viteDevServer;
};
