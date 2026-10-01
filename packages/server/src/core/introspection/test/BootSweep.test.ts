// @vitest-environment node
//
// Unit cells for sweepBootFolders (docs/followups/live/concurrent-boots-share-one-substrate.md,
// "Per-boot directories" rev 3.1, rule 4). Every filesystem call is injected so the logic is
// proven without touching disk.
//
// "Keep the newest of those [removable] so 'as of the last dev boot' reads survive" (rule 4)
// means exactly that: among the folders eligible for removal (closed, or dead-pid), the single
// newest one is always exempted, never just "usually". With one eligible folder, it IS the
// newest of that set, so it is kept, not removed - the sole historical record is never dropped
// to zero. Only once a NEWER eligible folder exists does the older one finally get swept. A
// closed folder is eligible even with a live pid (closed wins - two servers can share a
// process); a dead-pid folder is eligible even if never marked closed. Anything unknown -
// missing, unreadable, invalid dev.json - or simply live and not closed (including a stale
// heartbeat, which is the READER's call, never this sweep's) is left strictly alone, regardless
// of how many eligible folders exist alongside it.

import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultIsPidAlive, sweepBootFolders } from '../BootSweep';

type Dirent = { name: string; isDirectory(): boolean };

const dirent = (name: string): Dirent => ({ name, isDirectory: () => true });

const mkDeps = (files: Record<string, string | Error>, opts: { isPidAlive?: (pid: number) => boolean } = {}) => {
  const rm = vi.fn(async (_target: string, _opts: { recursive: true; force: true }) => undefined);
  const readdir = vi.fn(async (_dir: string, _opts: { withFileTypes: true }) => Object.keys(files).map((name) => dirent(name)));
  const readFile = vi.fn(async (file: string) => {
    const name = path.basename(path.dirname(file));
    const entry = files[name];
    if (entry instanceof Error) throw entry;
    if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return entry;
  });
  const logger = { warn: vi.fn() };

  return { rm, readdir, readFile, logger, isPidAlive: opts.isPidAlive ?? (() => true) };
};

const devJson = (fields: Record<string, unknown>) => JSON.stringify({ bootId: 'x', token: 't', pid: 111, startedAt: '2026-01-01T00:00:00.000Z', ...fields });

describe('sweepBootFolders', () => {
  it('a single removable folder is kept, not removed - it is the only "last dev boot" record and the newest of a set of one', async () => {
    const closed = mkDeps({ 'boot-closed': devJson({ state: 'closed', pid: 222 }) }, { isPidAlive: () => true });
    await sweepBootFolders('/boots', 'boot-own', closed);
    expect(closed.rm).not.toHaveBeenCalled();

    const dead = mkDeps({ 'boot-dead': devJson({ state: 'active', pid: 333 }) }, { isPidAlive: () => false });
    await sweepBootFolders('/boots', 'boot-own', dead);
    expect(dead.rm).not.toHaveBeenCalled();
  });

  it('a closed folder is swept once a newer removable sibling exists - closed wins over a live pid, it is not protected by it', async () => {
    const deps = mkDeps(
      {
        'boot-closed-live': devJson({ state: 'closed', pid: 222, startedAt: '2026-01-01T00:00:00.000Z' }),
        'boot-newer-dead': devJson({ state: 'active', pid: 333, startedAt: '2026-01-02T00:00:00.000Z' }),
      },
      { isPidAlive: (pid) => pid === 222 }, // the closed folder's pid is still alive; the newer one's is not
    );

    await sweepBootFolders('/boots', 'boot-own', deps);

    expect(deps.rm).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalledWith(path.join('/boots', 'boot-closed-live'), { recursive: true, force: true });
  });

  it('a dead-pid folder is swept once a newer removable (closed) sibling exists', async () => {
    const deps = mkDeps(
      {
        'boot-dead': devJson({ state: 'active', pid: 333, startedAt: '2026-01-01T00:00:00.000Z' }),
        'boot-newer-closed': devJson({ state: 'closed', pid: 444, startedAt: '2026-01-02T00:00:00.000Z' }),
      },
      { isPidAlive: (pid) => pid !== 333 }, // 333 is dead; 444 doesn't matter, it's closed either way
    );

    await sweepBootFolders('/boots', 'boot-own', deps);

    expect(deps.rm).toHaveBeenCalledTimes(1);
    expect(deps.rm).toHaveBeenCalledWith(path.join('/boots', 'boot-dead'), { recursive: true, force: true });
  });

  it('keeps the newest removable folder among several, removing only the rest', async () => {
    const deps = mkDeps({
      'boot-old': devJson({ state: 'closed', pid: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
      'boot-mid': devJson({ state: 'closed', pid: 2, startedAt: '2026-01-02T00:00:00.000Z' }),
      'boot-new': devJson({ state: 'closed', pid: 3, startedAt: '2026-01-03T00:00:00.000Z' }),
    });

    await sweepBootFolders('/boots', 'boot-own', deps);

    const removed = deps.rm.mock.calls.map((c) => c[0]);
    expect(removed.sort()).toEqual([path.join('/boots', 'boot-mid'), path.join('/boots', 'boot-old')].sort());
    expect(removed).not.toContain(path.join('/boots', 'boot-new'));
  });

  it('never touches a folder with no readable dev.json - missing is unknown, not closed', async () => {
    const deps = mkDeps({ 'boot-missing': Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });

    await sweepBootFolders('/boots', 'boot-own', deps);

    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('never touches a folder whose dev.json is unreadable for another reason (EACCES)', async () => {
    const deps = mkDeps({ 'boot-locked': Object.assign(new Error('EACCES'), { code: 'EACCES' }) });

    await sweepBootFolders('/boots', 'boot-own', deps);

    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('never touches a folder whose dev.json is invalid JSON', async () => {
    const deps = mkDeps({ 'boot-bad': '{not json' });

    await sweepBootFolders('/boots', 'boot-own', deps);

    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('never touches a live, not-closed folder - including one whose heartbeat would read as expired (that call belongs to the reader, not this sweep)', async () => {
    const deps = mkDeps({ 'boot-stale-heartbeat': devJson({ state: 'active', pid: 444, startedAt: '2020-01-01T00:00:00.000Z' }) }, { isPidAlive: () => true });

    await sweepBootFolders('/boots', 'boot-own', deps);

    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('never touches its own folder, even if it were somehow listed', async () => {
    const deps = mkDeps({ 'boot-own': devJson({ state: 'closed', pid: 555 }) });

    await sweepBootFolders('/boots', 'boot-own', deps);

    expect(deps.rm).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it('is a no-op, not an error, when the boots directory does not exist yet', async () => {
    const deps = mkDeps({});
    (deps.readdir as any).mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await expect(sweepBootFolders('/boots', 'boot-own', deps)).resolves.toBeUndefined();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('a sweep failure is non-fatal and warns at most once', async () => {
    const deps = mkDeps({});
    (deps.readdir as any).mockImplementation(async () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    await expect(sweepBootFolders('/boots', 'boot-own', deps)).resolves.toBeUndefined();
    await expect(sweepBootFolders('/boots', 'boot-own', deps)).resolves.toBeUndefined();

    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ component: 'introspection' }), expect.stringContaining('non-fatal'));
  });
});

describe('defaultIsPidAlive', () => {
  it('treats the current process as alive', () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });

  it('treats an unused pid (ESRCH) as dead', () => {
    // A pid far outside any plausible live range on a dev machine/CI runner.
    expect(defaultIsPidAlive(999_999)).toBe(false);
  });
});
