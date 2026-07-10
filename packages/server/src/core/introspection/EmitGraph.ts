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

export const writeTaujsArtifact = async (dir: string, name: string, data: string, logger?: ArtifactLogger): Promise<boolean> => {
  try {
    await mkdir(dir, { recursive: true });

    // tmp + rename: a crash mid-write can never leave a torn artifact for consumers
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
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
  options: { source: GraphSource; logger?: ArtifactLogger; serviceRegistry?: ServiceRegistry },
): Promise<boolean> => {
  try {
    const graph = createRequestGraph(config, {
      source: options.source,
      emittedAt: new Date().toISOString(),
      serviceRegistry: options.serviceRegistry,
    });

    return await writeTaujsArtifact(dir, 'graph.json', JSON.stringify(graph, null, 2), options.logger);
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
export const registerBootGraphEmission = (app: FastifyInstance, config: CoreTaujsConfig, serviceRegistry: ServiceRegistry | undefined, logger: Logs): void => {
  app.addHook('onListen', async function emitBootGraph() {
    await emitGraphArtifact(path.resolve(process.cwd(), 'node_modules', '.taujs'), config, {
      source: 'boot',
      logger,
      serviceRegistry,
    });
  });
};
