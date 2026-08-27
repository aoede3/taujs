import { rm, utimes } from 'node:fs/promises';
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
export const registerDevFiles = (app: FastifyInstance, introspection: DevIntrospection, logger: Logs, options?: { pollMs?: number }): void => {
  const dir = path.resolve(process.cwd(), 'node_modules', '.taujs');
  const filePath = (name: string) => path.join(dir, name);
  const pollMs = options?.pollMs ?? POLL_MS;

  let timer: NodeJS.Timeout | undefined;
  let last = { episodes: -1, episodesRevision: -1, logs: -1, observationsUpdatedAt: null as string | null };

  // Every flush - polled or final - joins ONE chain, and close awaits it. A polled tick was
  // previously fired unawaited: one still in flight when onClose ran could land its write
  // AFTER close resolved, and writeTaujsArtifact's mkdir(recursive) would recreate
  // node_modules/.taujs while a caller's teardown was removing it (the CI ENOTEMPTY flake).
  let inFlight: Promise<void> = Promise.resolve();

  // A reader cannot tell a running boot from a crashed one by its pid: pids are recycled, and a
  // crashed boot's dev.json survives because it is removed only on graceful close below. So the
  // boot proves it is alive by ADVANCING dev.json's mtime on this tick. Touching mtime is the whole
  // mechanism - no new field, no negotiation, and a reader with no dependency on this package can
  // observe it with one stat. Non-fatal like every other dev-file write; an unwritable dev.json
  // simply reads as expired, which is the honest answer.
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
      await writeTaujsArtifact(dir, 'episodes.ndjson', lines.length ? `${lines.join('\n')}\n` : '', logger);
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

  app.addHook('onListen', function emitDevJson() {
    const address = this.server.address() as AddressInfo | null;

    bootWork = (async () => {
      // SC-09 episode rename migration: a developer may still hold a legacy traces.ndjson written by
      // an earlier boot. A current boot exposes only episodes.ndjson through dev.json, and the
      // obsolete generated file is removed explicitly so a stale legacy artefact can never be
      // mistaken for current-boot evidence. Non-fatal like every other dev-file write.
      await rm(filePath('traces.ndjson'), { force: true }).catch(() => undefined);

      // Same principle for the mutable ring mirrors (spec 03 §5 amendment, decisions.md
      // 2026-08-20): the poller below only rewrites on change, so until the first current-boot
      // event each file on disk is still the PREVIOUS boot's - an early reader could serve old
      // edges as "seen this boot". Reset all three at listen: previous-boot content is
      // legitimately read only while no boot runs (stale mode, freshness-cited), and ceases to
      // be applicable exactly now (episode reads are bootId-filtered; runtime tools need this boot).
      await writeTaujsArtifact(dir, 'episodes.ndjson', '', logger);
      await writeTaujsArtifact(dir, 'logs.ndjson', '', logger);
      await writeTaujsArtifact(dir, 'observations.json', JSON.stringify(introspection.getObservations(), null, 2), logger);

      const devJson = {
        bootId: introspection.bootId,
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

      await writeTaujsArtifact(dir, 'dev.json', JSON.stringify(devJson, null, 2), logger);

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
    // Removing dev.json marks the boot dead; episode files stay (bootId detects staleness).
    await rm(filePath('dev.json'), { force: true }).catch(() => undefined);
  });
};
