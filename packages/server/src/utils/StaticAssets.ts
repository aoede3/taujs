import path from 'node:path';

import type { FastifyPluginAsync, FastifyPluginCallback, FastifyInstance } from 'fastify';

export type StaticMountEntry = {
  plugin: FastifyPluginCallback<any> | FastifyPluginAsync<any>;
  options?: Record<string, unknown>;
};

export type StaticAssetsRegistration = false | StaticMountEntry | StaticMountEntry[];

export function normaliseStaticAssets(reg: StaticAssetsRegistration | undefined): StaticMountEntry[] {
  if (!reg) return [];

  return Array.isArray(reg) ? reg : [reg];
}

export function prefixWeight(prefix?: unknown): number {
  if (typeof prefix !== 'string' || prefix === '/' || prefix.length === 0) return 0;

  return prefix.split('/').filter(Boolean).length;
}

export async function registerStaticAssets(
  app: FastifyInstance,
  baseClientRoot: string,
  reg: StaticAssetsRegistration | undefined,
  defaults?: Partial<StaticMountEntry['options']>,
  projectRoot?: string,
) {
  // In production, serve from dist/client; in development, serve from source
  const isDevelopment = process.env.NODE_ENV === 'development';
  const effectiveProjectRoot = projectRoot ?? path.resolve(process.cwd());
  const staticRoot = isDevelopment ? baseClientRoot : path.resolve(effectiveProjectRoot, 'client');

  const entries = normaliseStaticAssets(reg).map(({ plugin, options }) => ({
    plugin,
    options: {
      root: staticRoot,
      prefix: '/',
      index: false,
      wildcard: false,
      ...(defaults ?? {}),
      ...(options ?? {}),
    },
  }));

  entries.sort((a, b) => prefixWeight(b.options?.prefix) - prefixWeight(a.options?.prefix));

  for (const { plugin, options } of entries) {
    await app.register(plugin as FastifyPluginCallback<any>, options);
  }
}
