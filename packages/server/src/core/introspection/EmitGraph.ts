import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createRequestGraph } from './RequestGraph';

import type { FastifyInstance } from 'fastify';
import type { CoreTaujsConfig } from '../config/types';
import type { Logs } from '../logging/types';
import type { ServiceRegistry } from '../services/DataServices';
import type { GraphSource } from './RequestGraph';

type ArtifactLogger = Pick<Logs, 'warn'>;

// Non-fatal by contract (spec 03 invariant 3): introspection artifacts must never break
// boot or build. First failure warns; subsequent failures this process stay silent.
let warned = false;

const warnOnce = (logger: ArtifactLogger | undefined, meta: Record<string, unknown>, message: string): void => {
  if (warned) return;
  warned = true;
  logger?.warn({ component: 'introspection', ...meta }, message);
};

export const writeTaujsArtifact = async (dir: string, name: string, data: string, logger?: ArtifactLogger, bootId?: string): Promise<boolean> => {
  try {
    await mkdir(dir, { recursive: true });

    // tmp + rename: a crash mid-write can never leave a torn artifact for consumers. A known
    // bootId (per-boot directories, rev 3.1) rides the temp name alongside the pid; a build
    // writer, which has no bootId, keeps today's pid-only form.
    const tmp = path.join(dir, bootId ? `.${name}.${process.pid}.${bootId}.tmp` : `.${name}.${process.pid}.tmp`);
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path.join(dir, name));

    return true;
  } catch (err) {
    warnOnce(
      logger,
      { dir, name, error: err instanceof Error ? err.message : String(err) },
      'Failed to write introspection artifact (non-fatal; suppressing further warnings)',
    );

    return false;
  }
};

export const emitGraphArtifact = async (
  dir: string,
  config: CoreTaujsConfig,
  options: { source: GraphSource; logger?: ArtifactLogger; serviceRegistry?: ServiceRegistry; projectRoot?: string; bootId?: string },
): Promise<boolean> => {
  try {
    const graph = createRequestGraph(config, {
      source: options.source,
      emittedAt: new Date().toISOString(),
      serviceRegistry: options.serviceRegistry,
      projectRoot: options.projectRoot,
      bootId: options.bootId,
    });

    return await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(graph, null, 2), options.logger, options.bootId);
  } catch (err) {
    // Graph composition failed — same non-fatal contract as the write path.
    warnOnce(
      options.logger,
      { dir, error: err instanceof Error ? err.message : String(err) },
      'Failed to compose request graph (non-fatal; suppressing further warnings)',
    );

    return false;
  }
};

// Registered only from inside the structural dev gate (CreateServer's isDevelopment branch,
// reached via lazy dynamic import) — in production this module is never even loaded.
// onListen so emission reflects a server that actually bound, never a boot that failed.
//
// Per-boot directories (docs/followups/live/concurrent-boots-share-one-substrate.md, rev 3.1):
// `bootDir` is this boot's own folder under node_modules/.taujs/boots/, supplied by the caller
// (SSRServer.ts) rather than resolved here, and the emitted graph's `bootId` is simply that
// folder's basename - so the graph can never disagree with the folder it lives in.
export const registerBootGraphEmission = (
  app: FastifyInstance,
  config: CoreTaujsConfig,
  serviceRegistry: ServiceRegistry | undefined,
  logger: Logs,
  bootDir: string,
  projectRoot = process.cwd(),
): void => {
  // Same close barrier as registerDevFiles: listen() resolves before the async onListen hook
  // runner completes (Fastify sequences the hook promises, but the listen caller is not waiting
  // on them), so close can run while this write is in flight — or before the hook has even
  // started. onClose awaits the tracked work, and a boot that close has overtaken never starts
  // the write at all; otherwise a slow graph.json write could recreate the boot's own folder
  // during a caller's teardown removal.
  let closed = false;
  let work: Promise<unknown> = Promise.resolve();

  app.addHook('onListen', function emitBootGraph() {
    if (closed) return;

    work = emitGraphArtifact(bootDir, config, {
      source: 'boot',
      logger,
      serviceRegistry,
      projectRoot,
      bootId: path.basename(bootDir),
    });

    return work.then(() => undefined);
  });

  app.addHook('onClose', async () => {
    closed = true;
    await work.catch(() => undefined);
  });
};
