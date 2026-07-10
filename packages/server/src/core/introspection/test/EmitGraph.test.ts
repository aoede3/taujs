// @vitest-environment node
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CoreTaujsConfig } from '../../config/types';

const config: CoreTaujsConfig = {
  apps: [{ appId: 'web', entryPoint: 'web', routes: [{ path: '/', attr: { render: 'ssr' } }] }],
};

// Module state (warn-once) must reset per test.
async function importFresh() {
  vi.resetModules();
  return await import('../EmitGraph');
}

const mkWarnLogger = () => ({ warn: vi.fn() });

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'taujs-emit-'));
});

describe('writeTaujsArtifact', () => {
  it('creates the directory, writes atomically, and leaves no tmp files', async () => {
    const { writeTaujsArtifact } = await importFresh();
    const target = path.join(dir, '.taujs');

    const ok = await writeTaujsArtifact(target, 'graph.json', '{"a":1}');

    expect(ok).toBe(true);
    expect(await readFile(path.join(target, 'graph.json'), 'utf8')).toBe('{"a":1}');
    expect(await readdir(target)).toEqual(['graph.json']);
  });

  it('rewrites an existing artifact (per-boot lifecycle)', async () => {
    const { writeTaujsArtifact } = await importFresh();
    const target = path.join(dir, '.taujs');

    await writeTaujsArtifact(target, 'graph.json', 'first');
    const ok = await writeTaujsArtifact(target, 'graph.json', 'second');

    expect(ok).toBe(true);
    expect(await readFile(path.join(target, 'graph.json'), 'utf8')).toBe('second');
  });

  it('is non-fatal on an unwritable target and warns exactly once per boot', async () => {
    const { writeTaujsArtifact } = await importFresh();
    const logger = mkWarnLogger();
    // A path through a regular file fails mkdir deterministically on every platform/uid.
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const target = path.join(blocker, '.taujs');

    const first = await writeTaujsArtifact(target, 'graph.json', '{}', logger);
    const second = await writeTaujsArtifact(target, 'graph.json', '{}', logger);

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ component: 'introspection', dir: target }), expect.stringContaining('non-fatal'));
  });
});

describe('emitGraphArtifact', () => {
  it('writes graph.json with the requested source and services: null without a registry', async () => {
    const { emitGraphArtifact } = await importFresh();
    const target = path.join(dir, 'dist', '.taujs');

    const ok = await emitGraphArtifact(target, config, { source: 'build' });
    const graph = JSON.parse(await readFile(path.join(target, 'graph.json'), 'utf8'));

    expect(ok).toBe(true);
    expect(graph.source).toBe('build');
    expect(graph.services).toBeNull();
    expect(graph.schemaVersion).toBe(1);
    expect(new Date(graph.emittedAt).toISOString()).toBe(graph.emittedAt);
  });

  it('never throws when graph composition fails — warns once, returns false', async () => {
    const { emitGraphArtifact } = await importFresh();
    const logger = mkWarnLogger();

    const ok = await emitGraphArtifact(path.join(dir, '.taujs'), { apps: [] }, { source: 'build', logger });

    expect(ok).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('registerBootGraphEmission', () => {
  it('registers an onListen hook that writes node_modules/.taujs/graph.json (source: boot)', async () => {
    const { registerBootGraphEmission } = await importFresh();
    const addHook = vi.fn();
    const app = { addHook } as any;
    const logger = { ...mkWarnLogger(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(), isDebugEnabled: vi.fn() } as any;
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);

    try {
      registerBootGraphEmission(app, config, undefined, logger);

      expect(addHook).toHaveBeenCalledTimes(1);
      const [hookName, hookFn] = addHook.mock.calls[0]!;
      expect(hookName).toBe('onListen');

      await hookFn();

      const graph = JSON.parse(await readFile(path.join(dir, 'node_modules', '.taujs', 'graph.json'), 'utf8'));
      expect(graph.source).toBe('boot');

      // Committed shape check, modulo the only timestamp in the document.
      expect({ ...graph, emittedAt: '<emittedAt>' }).toMatchSnapshot();
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
