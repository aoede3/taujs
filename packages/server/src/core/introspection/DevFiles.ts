import { rm, utimes } from 'node:fs/promises';
import path from 'node:path';

import { sweepBootFolders } from './BootSweep';
import { writeTaujsArtifact } from './EmitGraph';

import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { Logs } from '../logging/types';
import type { DevIntrospection } from './DevIntrospection';

const POLL_MS = 500;

// Emits the dev files under node_modules/.taujs/boots/<bootId>/ (per-boot directories,
// docs/followups/live/concurrent-boots-share-one-substrate.md rev 3.1): dev.json first with
// state 'active' on listen, rewritten last with state 'closed' on graceful close (never
// removed), and ring mirrors of the in-memory buffers - full atomic rewrite on change, debounced
// by a polling interval. Correctness over cleverness: the rings are already size-capped in
// memory, so a rewrite is bounded work. All writes are non-fatal (invariant 3) via
// writeTaujsArtifact, and this boot never reads or writes outside its own folder except the
// start-of-boot sweep, which only ever removes a SIBLING folder that is closed or dead-pid.
export const registerDevFiles = (app: FastifyInstance, introspection: DevIntrospection, logger: Logs, bootDir: string, options?: { pollMs?: number }): void => {
  const dir = bootDir;
  const bootId = introspection.bootId;
  const bootsDir = path.dirname(dir);
  const filePath = (name: string) => path.join(dir, name);
  const pollMs = options?.pollMs ?? POLL_MS;

  let timer: NodeJS.Timeout | undefined;
  let last = { episodes: -1, episodesRevision: -1, logs: -1, observationsUpdatedAt: null as string | null };

  // Every flush - polled or final - joins ONE chain, and close awaits it. A polled tick was
  // previously fired unawaited: one still in flight when onClose ran could land its write
  // AFTER close resolved, and writeTaujsArtifact's mkdir(recursive) would recreate this boot's
  // own folder while a caller's teardown was removing it (the CI ENOTEMPTY flake).
  let inFlight: Promise<void> = Promise.resolve();

  // A reader cannot tell a running boot from a crashed one by its pid: pids are recycled, and a
  // crashed boot's dev.json survives because it is rewritten, never removed, on graceful close
  // below (rule 3). So the boot proves it is alive by ADVANCING dev.json's mtime on this tick.
  // Touching mtime is the whole mechanism - no new field, no negotiation, and a reader with no
  // dependency on this package can observe it with one stat. Non-fatal like every other dev-file
  // write; an unwritable dev.json simply reads as expired, which is the honest answer.
  const heartbeat = async (): Promise<void> => {
    const now = new Date();
    await utimes(filePath('dev.json'), now, now).catch(() => undefined);
  };

  const flush = async (): Promise<void> => {
    // Unconditional, and BEFORE the change checks: liveness is not a change to report, it is the
    // fact that this process is still here. A boot serving no traffic is still a live boot.
    await heartbeat();

    const stats = introspection.stats();

    // `episodesRevision` advances for a NEW finalised episode and for an in-place amendment of one
    // (RFC 0007 R5: a deferred outcome arriving after the terminal), so a late outcome reaches the
    // on-disk artefact through this same bounded rewrite rather than lagging until the next request.
    if (stats.episodesRevision !== last.episodesRevision) {
      const lines = introspection.getEpisodes().map((t) => JSON.stringify(t));
      await writeTaujsArtifact(dir, 'episodes.ndjson', lines.length ? `${lines.join('\n')}\n` : '', logger, bootId);
    }
    if (stats.logs !== last.logs) {
      const lines = introspection.getLogs().map((l) => JSON.stringify(l));
      await writeTaujsArtifact(dir, 'logs.ndjson', lines.length ? `${lines.join('\n')}\n` : '', logger, bootId);
    }
    if (stats.observationsUpdatedAt !== last.observationsUpdatedAt) {
      await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(introspection.getObservations(), null, 2), logger, bootId);
    }
    last = stats;
  };

  const scheduleFlush = (): Promise<void> => (inFlight = inFlight.then(flush).catch(() => undefined));

  // listen() resolves before the async onListen hook runner completes (Fastify sequences the
  // hook promises, but the listen caller is not waiting on them - the lifecycle test pins
  // this), so a fast boot-then-close can reach onClose while the boot writes below are still
  // in flight - and, worse, before the poller exists, so clearInterval cleared nothing and the
  // timer then STARTED after close and kept writing into a directory the caller was removing
  // (the CI ENOTEMPTY flake). onClose therefore awaits the tracked boot work, and the timer
  // only starts if close has not already run.
  let closed = false;
  let bootWork: Promise<void> = Promise.resolve();

  // dev.json's body minus `state`, captured once at listen so the onClose rewrite (rule 3) is
  // the SAME document with only `state` flipped - never reconstructed from scratch.
  let devJsonBody: Record<string, unknown> | undefined;

  app.addHook('onListen', function emitDevJson() {
    const address = this.server.address() as AddressInfo | null;

    bootWork = (async () => {
      // Sweep before any write of our own (rule 4): remove sibling folders whose dev.json says
      // closed, or whose recorded pid is dead, keeping the newest of those; anything unknown
      // (no readable/parseable dev.json yet), live-and-not-closed, or heartbeat-expired is left
      // untouched. Non-fatal and warns at most once per process.
      await sweepBootFolders(bootsDir, bootId, { logger });

      // A developer may still hold a legacy traces.ndjson from an earlier boot that reused this
      // exact folder name - practically impossible now that each boot owns a freshly generated
      // bootId, but harmless to keep.
      // contract: server:request-identity#ruling-9-request-observations-use-episode-vocabulary
      await rm(filePath('traces.ndjson'), { force: true }).catch(() => undefined);

      devJsonBody = {
        bootId,
        token: introspection.token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: address?.address ?? null,
        port: address?.port ?? null,
        graph: filePath('graph.json'),
        episodes: filePath('episodes.ndjson'),
        logs: filePath('logs.ndjson'),
        observations: filePath('observations.json'),
      };

      // dev.json is the FIRST write in this boot's folder (rule 1), with state: 'active'. Only
      // after it do the ring mirrors reset below, and the graph (a separate onListen hook
      // registered after this one - Fastify sequences onListen hook promises in series).
      await writeTaujsArtifact(dir, 'dev.json', JSON.stringify({ ...devJsonBody, state: 'active' }, null, 2), logger, bootId);

      // Ring mirrors: the poller below only rewrites on change, so until the first current-boot
      // event each file on disk would otherwise be stale for an early reader. Reset all three at
      // listen (spec 03 §5 amendment, decisions.md 2026-08-20): episode reads are
      // bootId-filtered, and runtime tools need THIS boot's own evidence from the first tick.
      await writeTaujsArtifact(dir, 'episodes.ndjson', '', logger, bootId);
      await writeTaujsArtifact(dir, 'logs.ndjson', '', logger, bootId);
      await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(introspection.getObservations(), null, 2), logger, bootId);

      // Ring mirrors: poll-on-change; unref'd so the timer never holds the process open.
      if (!closed) {
        timer = setInterval(() => void scheduleFlush(), pollMs);
        timer.unref?.();
      }
    })();

    return bootWork;
  });

  app.addHook('onClose', async () => {
    closed = true;
    // Boot writes first (Fastify never awaited them), then any in-flight polled write via the
    // shared chain, then the final flush - so no write can land once close has resolved.
    await bootWork.catch(() => undefined);
    if (timer) clearInterval(timer);
    await scheduleFlush();

    // Closed LAST (rule 3): the same document, `state` flipped to 'closed', via the ordinary
    // tmp+rename path - never removed. A sweep by a later boot is the only thing that ever
    // deletes it.
    if (devJsonBody) {
      await writeTaujsArtifact(dir, 'dev.json', JSON.stringify({ ...devJsonBody, state: 'closed' }, null, 2), logger, bootId);
    }
  });
};
