import path from 'node:path';

import { CONTENT } from '../constants';
import { createLogger } from '../logging/Logger';
import { overrideCSSHMRConsoleError } from './Templates';
import { layerAlias } from './ViteAlias';
import { normalisePlugins } from './ViteMergeEngine';
import { findFormerlyDiscoveredViteConfig, formerlyDiscoveredViteConfigWarning } from './ViteConfigDiscovery';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { InlineConfig, ViteDevServer } from 'vite';
import type { DebugConfig } from '../core/logging/types';

/**
 * RFC 0005 VS4 - `setupDevServer` options.
 *
 * Refactored OFF positional parameters (the surface kept growing: `alias`, `debug`, `devNet`,
 * `plugins`, then VS5's trailing `declarativeAlias`). One options object, so future dev-config
 * widening never reshuffles argument positions again.
 */
export type SetupDevServerOptions = {
  app: FastifyInstance;
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
  devNet?: { host: string; hmrPort: number };
  /**
   * The resolved, engine-merged dev Vite fragment (VS4), assembled ONCE in `SSRServer` via
   * `resolveDevViteConfig`: `plugins` (apps -> config.vite), `define`, `css` (scss `modern-compiler`
   * default merged with any user `css.preprocessorOptions`), `esbuild`, `logLevel`, `optimizeDeps`,
   * and non-`alias` `resolve` keys. Framework invariants (`root`, `server`, `appType`, `configFile`,
   * `mode`, `resolve.alias`) are applied HERE and NEVER read from this fragment.
   */
  viteConfig?: InlineConfig;
};

export const setupDevServer = async (options: SetupDevServerOptions): Promise<ViteDevServer> => {
  const { app, clientRoot: baseClientRoot, alias, declarativeAlias, projectRoot, debug, devNet, viteConfig } = options;

  const logger = createLogger({
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
  const { build: _ignoredBuild, plugins: mergedPlugins, resolve: mergedResolve, css: mergedCss, ...admittedDevFields } = viteConfig ?? {};

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
    server: {
      middlewareMode: true,
      hmr: {
        clientPort: hmrPort,
        host: host !== 'localhost' ? host : undefined,
        port: hmrPort,
        protocol: 'ws',
      },
    },
  });

  overrideCSSHMRConsoleError();

  app.addHook('onRequest', async (request, reply) => {
    await new Promise<void>((resolve) => {
      viteDevServer.middlewares(request.raw, reply.raw, () => {
        if (!reply.sent) resolve();
      });
    });
  });

  return viteDevServer;
};
