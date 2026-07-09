import { rm } from 'node:fs/promises';
import path from 'node:path';

import { writeTaujsArtifact } from './EmitGraph';

import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { Logs } from '../logging/types';
import type { DevIntrospection } from './DevIntrospection';

const POLL_MS = 500;

// Emits the dev files under node_modules/.taujs/ (spec 03 §5): dev.json on listen (actual
// bound socket, removed on graceful close) and ring mirrors of the in-memory buffers —
// full atomic rewrite on change, debounced by a polling interval. Correctness over
// cleverness: the rings are already size-capped in memory, so a rewrite is bounded work.
// All writes are non-fatal (invariant 3) via writeTaujsArtifact.
export const registerDevFiles = (app: FastifyInstance, introspection: DevIntrospection, logger: Logs): void => {
  const dir = path.resolve(process.cwd(), 'node_modules', '.taujs');
  const filePath = (name: string) => path.join(dir, name);

  let timer: NodeJS.Timeout | undefined;
  let last = { traces: -1, logs: -1, observationsUpdatedAt: null as string | null };

  const flush = async (): Promise<void> => {
    const stats = introspection.stats();

    if (stats.traces !== last.traces) {
      const lines = introspection.getTraces().map((t) => JSON.stringify(t));
      await writeTaujsArtifact(dir, 'traces.ndjson', lines.length ? `${lines.join('\n')}\n` : '', logger);
    }
    if (stats.logs !== last.logs) {
      const lines = introspection.getLogs().map((l) => JSON.stringify(l));
      await writeTaujsArtifact(dir, 'logs.ndjson', lines.length ? `${lines.join('\n')}\n` : '', logger);
    }
    if (stats.observationsUpdatedAt !== last.observationsUpdatedAt) {
      await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(introspection.getObservations(), null, 2), logger);
    }
    last = stats;
  };

  app.addHook('onListen', async function emitDevJson() {
    const address = this.server.address() as AddressInfo | null;

    const devJson = {
      bootId: introspection.bootId,
      token: introspection.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: address?.address ?? null,
      port: address?.port ?? null,
      graph: filePath('graph.json'),
      traces: filePath('traces.ndjson'),
      logs: filePath('logs.ndjson'),
      observations: filePath('observations.json'),
    };

    await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson, null, 2), logger);

    // Ring mirrors: poll-on-change; unref'd so the timer never holds the process open.
    timer = setInterval(() => void flush(), POLL_MS);
    timer.unref?.();
  });

  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await flush().catch(() => undefined);
    // Removing dev.json marks the boot dead; trace files stay (bootId detects staleness).
    await rm(filePath('dev.json'), { force: true }).catch(() => undefined);
  });
};
