// @vitest-environment node
//
// Integration cells for per-boot directories (docs/followups/live/concurrent-boots-share-one-
// substrate.md, "Per-boot directories" rev 3.1), driving real Fastify boots against a real
// filesystem. The rule in one sentence: write active first, write only inside your own folder,
// write closed last, delete only folders marked closed or belonging to a dead pid, never delete
// missing/broken/live/heartbeat-expired markers. These cells prove the emitter half of that.

import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createDevIntrospection } from '../DevIntrospection';
import { registerDevFiles } from '../DevFiles';
import { registerBootGraphEmission } from '../EmitGraph';

import type { FastifyInstance } from 'fastify';
import type { CoreTaujsConfig } from '../../config/types';
import type { DevIntrospection } from '../DevIntrospection';

const config: CoreTaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', routes: [{ path: '/', attr: { render: 'ssr' } }] }],
};

const mkLogger = (): any => {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), isDebugEnabled: vi.fn(() => false) };
  l.child = vi.fn(() => l);
  return l;
};

const bootDirFor = (root: string, bootId: string) => path.join(root, 'node_modules', '.taujs', 'boots', bootId);

// Boots a real server, with the composed wiring production uses (dev files, then boot graph),
// both pointed at the same per-boot folder, and waits for both of the first writes to land.
const bootApp = async (root: string): Promise<{ app: FastifyInstance; introspection: DevIntrospection; bootDir: string }> => {
  const introspection = createDevIntrospection();
  const bootDir = bootDirFor(root, introspection.bootId);
  const app = fastify();
  const logger = mkLogger();
  registerDevFiles(app, introspection, logger, bootDir);
  registerBootGraphEmission(app, config, undefined, logger, bootDir);
  await app.listen({ port: 0, host: '127.0.0.1' });
  await vi.waitFor(async () => {
    await stat(path.join(bootDir, 'dev.json'));
    await stat(path.join(bootDir, 'graph.json'));
  });
  return { app, introspection, bootDir };
};

describe('concurrent dev boots share one working directory', () => {
  it('the decisive cell: a folder that exists but has no dev.json yet is unknown, not closed - a sibling sweep never touches it, and it writes normally once resumed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taujs-decisive-'));

    // Boot A creates its own folder (as writeTaujsArtifact's mkdir would, mid in-flight write)
    // but has NOT yet written dev.json - the exact window rev 3 missed and rev 3.1 fixed.
    const aIntrospection = createDevIntrospection();
    const aDir = bootDirFor(root, aIntrospection.bootId);
    await mkdir(aDir, { recursive: true });

    // Boot B starts in the same working directory; its onListen hook sweeps boots/ first.
    const bIntrospection = createDevIntrospection();
    const bDir = bootDirFor(root, bIntrospection.bootId);
    const bApp = fastify();
    registerDevFiles(bApp, bIntrospection, mkLogger(), bDir);
    await bApp.listen({ port: 0, host: '127.0.0.1' });
    await vi.waitFor(async () => {
      await stat(path.join(bDir, 'dev.json'));
    });

    // A's folder is exactly as A left it: present, still no dev.json - B's sweep classified it
    // unknown and left it alone.
    await expect(stat(aDir)).resolves.toBeTruthy();
    await expect(stat(path.join(aDir, 'dev.json'))).rejects.toThrow();

    // A resumes (same introspection instance, same bootId as the folder it already made) and
    // writes normally - the folder was ignored, not damaged.
    const aApp = fastify();
    registerDevFiles(aApp, aIntrospection, mkLogger(), aDir);
    await aApp.listen({ port: 0, host: '127.0.0.1' });
    await vi.waitFor(async () => {
      await stat(path.join(aDir, 'dev.json'));
    });

    const aDevJson = JSON.parse(await readFile(path.join(aDir, 'dev.json'), 'utf8'));
    expect(aDevJson.bootId).toBe(aIntrospection.bootId);
    expect(aDevJson.state).toBe('active');

    // B is undisturbed by A's later boot too.
    const bDevJson = JSON.parse(await readFile(path.join(bDir, 'dev.json'), 'utf8'));
    expect(bDevJson.state).toBe('active');
    expect(bDevJson.bootId).toBe(bIntrospection.bootId);

    await aApp.close();
    await bApp.close();
  });

  const assertTwoIndependentBoots = async (root: string, a: Awaited<ReturnType<typeof bootApp>>, b: Awaited<ReturnType<typeof bootApp>>) => {
    expect(a.bootDir).not.toBe(b.bootDir);

    for (const { bootDir, introspection } of [a, b]) {
      const devJson = JSON.parse(await readFile(path.join(bootDir, 'dev.json'), 'utf8'));
      expect(devJson.bootId).toBe(introspection.bootId);
      expect(devJson.state).toBe('active');
      await expect(stat(path.join(bootDir, 'graph.json'))).resolves.toBeTruthy();
      await expect(stat(path.join(bootDir, 'episodes.ndjson'))).resolves.toBeTruthy();
      await expect(stat(path.join(bootDir, 'logs.ndjson'))).resolves.toBeTruthy();
      await expect(stat(path.join(bootDir, 'observations.json'))).resolves.toBeTruthy();
    }

    // Nothing at the shared root: node_modules/.taujs/ contains only boots/.
    const rootEntries = await readdir(path.join(root, 'node_modules', '.taujs'));
    expect(rootEntries).toEqual(['boots']);
    const bootsEntries = (await readdir(path.join(root, 'node_modules', '.taujs', 'boots'))).sort();
    expect(bootsEntries).toEqual([a.introspection.bootId, b.introspection.bootId].sort());
  };

  it('two boots, A then B: each writes only its own folder, nothing lands at the node_modules/.taujs root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taujs-two-boots-ab-'));
    const a = await bootApp(root);
    const b = await bootApp(root);

    await assertTwoIndependentBoots(root, a, b);

    await a.app.close();
    await b.app.close();
  });

  it('two boots, B then A (reverse start order): each writes only its own folder, nothing lands at the node_modules/.taujs root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taujs-two-boots-ba-'));
    const b = await bootApp(root);
    const a = await bootApp(root);

    await assertTwoIndependentBoots(root, a, b);

    await a.app.close();
    await b.app.close();
  });

  it('clean close: dev.json is present with state closed, every other field intact, mirrors intact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taujs-clean-close-'));
    const { app, introspection, bootDir } = await bootApp(root);

    introspection.recorder.requestStart({ requestId: 'clean-1', url: '/clean', method: 'GET' });
    introspection.recorder.sent({ requestId: 'clean-1', status: 200, mode: 'ssr' });
    await vi.waitFor(async () => {
      expect(await readFile(path.join(bootDir, 'episodes.ndjson'), 'utf8')).toContain('clean-1');
    });

    const beforeClose = JSON.parse(await readFile(path.join(bootDir, 'dev.json'), 'utf8'));
    expect(beforeClose.state).toBe('active');

    await app.close();

    const afterClose = JSON.parse(await readFile(path.join(bootDir, 'dev.json'), 'utf8'));
    expect(afterClose).toEqual({ ...beforeClose, state: 'closed' });

    // Rule 3: "closed", never removed. The mirrors it points at are untouched by close too.
    const episodes = await readFile(path.join(bootDir, 'episodes.ndjson'), 'utf8');
    expect(episodes).toContain('clean-1');
    await expect(stat(path.join(bootDir, 'graph.json'))).resolves.toBeTruthy();
    await expect(stat(path.join(bootDir, 'observations.json'))).resolves.toBeTruthy();
  });

  it('the reproduced order: A live; B and C boot and close cleanly - A is byte-identical before and after, and stays active throughout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'taujs-reproduced-order-'));
    const a = await bootApp(root);

    const aDevJsonBefore = await readFile(path.join(a.bootDir, 'dev.json'), 'utf8');
    const aGraphBefore = await readFile(path.join(a.bootDir, 'graph.json'), 'utf8');

    const b = await bootApp(root);
    // A small real delay so B and C's startedAt timestamps are distinguishable - the "keep the
    // newest removable" assertion below depends on that ordering, not on wall-clock luck.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const c = await bootApp(root);
    await b.app.close();
    await c.app.close();

    // A was never read by B or C's sweep in a way that changed it - still active, still itself.
    const aDevJsonAfter = await readFile(path.join(a.bootDir, 'dev.json'), 'utf8');
    const aGraphAfter = await readFile(path.join(a.bootDir, 'graph.json'), 'utf8');
    expect(aDevJsonAfter).toBe(aDevJsonBefore);
    expect(aGraphAfter).toBe(aGraphBefore);
    expect(JSON.parse(aDevJsonAfter).state).toBe('active');

    // B and C marked themselves closed and were never deleted by each other (closing concurrently,
    // neither the other's folder).
    const bDevJson = JSON.parse(await readFile(path.join(b.bootDir, 'dev.json'), 'utf8'));
    const cDevJson = JSON.parse(await readFile(path.join(c.bootDir, 'dev.json'), 'utf8'));
    expect(bDevJson.state).toBe('closed');
    expect(cDevJson.state).toBe('closed');

    // The next boot sweeps B and C (both closed), keeping the newest of the two (C), and never
    // touches A.
    const next = await bootApp(root);
    const bootsEntries = await readdir(path.join(root, 'node_modules', '.taujs', 'boots'));
    expect(bootsEntries.sort()).toEqual([a.introspection.bootId, c.introspection.bootId, next.introspection.bootId].sort());
    expect(bootsEntries).not.toContain(b.introspection.bootId);

    await a.app.close();
    await next.app.close();
  });
});
