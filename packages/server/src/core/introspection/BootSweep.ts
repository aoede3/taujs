import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { Logs } from '../logging/types';

type ArtifactLogger = Pick<Logs, 'warn'>;

// Non-fatal by contract, same convention as EmitGraph's writeTaujsArtifact: a sweep failure
// warns once and never breaks boot.
let warned = false;

const warnOnce = (logger: ArtifactLogger | undefined, meta: Record<string, unknown>, message: string): void => {
  if (warned) return;
  warned = true;
  logger?.warn({ component: 'introspection', ...meta }, message);
};

export type IsPidAlive = (pid: number) => boolean;

// `process.kill(pid, 0)` semantics (docs/followups/live/concurrent-boots-share-one-substrate.md,
// "Per-boot directories"): no throw or EPERM means the process still exists (EPERM just means we
// cannot signal it - a different user's process is still alive); ESRCH means it is gone. Anything
// else is treated as "alive" deliberately - an ambiguous read must never license a deletion.
export const defaultIsPidAlive: IsPidAlive = (pid) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
};

// Narrow, non-overloaded shapes for the three fs calls this module makes - deliberately not
// `typeof readdir` etc: those are overloaded on their options argument, and a plain mock
// function (as tests inject) does not carry that overload set, so TypeScript cannot match it
// against the full signature. The real implementations are wrapped in lambdas below that DO
// carry a literal options argument, so the correct overload resolves there instead.
type SweepReaddir = (dir: string, opts: { withFileTypes: true }) => Promise<{ name: string; isDirectory(): boolean }[]>;
type SweepReadFile = (file: string, encoding: 'utf8') => Promise<string>;
type SweepRm = (target: string, opts: { recursive: true; force: true }) => Promise<void>;

export type SweepDeps = {
  readdir?: SweepReaddir;
  readFile?: SweepReadFile;
  rm?: SweepRm;
  isPidAlive?: IsPidAlive;
  logger?: ArtifactLogger;
};

type DevJsonProbe = { state?: unknown; pid?: unknown; startedAt?: unknown };

// Rev 3.1 (RULED GO 2026-10-01): remove sibling boot folders whose dev.json says `closed` -
// closed wins even over a live pid, because two servers can share one process - or whose
// recorded pid is dead. Keep the newest of those removable folders so an "as of the last dev
// boot" read survives. A folder with no readable/parseable dev.json is UNKNOWN, never closed,
// and is never touched; neither is a live, not-closed folder, including one whose heartbeat has
// expired (that call belongs to the reader, not this sweep). No lock, lease or takeover: nobody
// else writes dev.json after boot, so there is nothing to race.
export const sweepBootFolders = async (bootsDir: string, ownBootId: string, deps: SweepDeps = {}): Promise<void> => {
  const doReaddir: SweepReaddir = deps.readdir ?? ((dir, opts) => readdir(dir, opts));
  const doReadFile: SweepReadFile = deps.readFile ?? ((file, encoding) => readFile(file, encoding));
  const doRm: SweepRm = deps.rm ?? ((target, opts) => rm(target, opts));
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;

  try {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await doReaddir(bootsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return; // nothing to sweep yet
      throw err;
    }

    const removable: { name: string; startedAt: string }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ownBootId) continue;

      let raw: string;
      try {
        raw = await doReadFile(path.join(bootsDir, entry.name, 'dev.json'), 'utf8');
      } catch {
        continue; // missing or unreadable: unknown, never touched
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // invalid: unknown, never touched
      }
      if (!parsed || typeof parsed !== 'object') continue;

      const { state, pid, startedAt } = parsed as DevJsonProbe;
      const closed = state === 'closed';
      const deadPid = typeof pid === 'number' && !isPidAlive(pid);

      // Live and not closed - including a stale heartbeat - is never touched here.
      if (closed || deadPid) removable.push({ name: entry.name, startedAt: typeof startedAt === 'string' ? startedAt : '' });
    }

    if (removable.length === 0) return;

    // ISO 8601 timestamps sort lexicographically in chronological order; keep the newest.
    removable.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    const [, ...toRemove] = removable;

    for (const r of toRemove) {
      await doRm(path.join(bootsDir, r.name), { recursive: true, force: true });
    }
  } catch (err) {
    warnOnce(deps.logger, { bootsDir, error: err instanceof Error ? err.message : String(err) }, 'Boot substrate sweep failed (non-fatal)');
  }
};
