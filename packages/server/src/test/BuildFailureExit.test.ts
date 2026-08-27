// @vitest-environment node
//
// Evidence for the build-failure-exit fix (docs/followups/build-failure-exit-truncates-output-and-
// skips-graph.md): both `process.exit(1)` sites in Build.ts become `process.exitCode = 1; return`,
// a failed per-app build names the apps not attempted, and a previously emitted graph is never
// deleted or rewritten by a failed build.
//
// The exit-code/stderr-bytes cells spawn a REAL child process (pattern copied from
// RuntimeLoggerFallthrough.test.ts: `spawnSync(process.execPath, ['--import', 'tsx', ...])`), so
// `process.exitCode` set on the real process object can never contaminate this vitest worker. The
// remaining cells run in-process against a mocked `vite`, guarded by resetting `process.exitCode`
// in `afterEach`.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { testRenderer } from './support/renderer';

import type { InlineConfig } from 'vite';

vi.mock('vite', () => ({ build: vi.fn(async () => ({})) }));

// Ancestor/descendant pair, reused by the graph-preservation cells - same shape as
// BuildFilteredOutput.test.ts.
const graphAppConfigs = [
  {
    appId: 'root',
    entryPoint: '',
    clientRoot: '',
    entryClient: 'entry-client',
    entryServer: 'entry-server',
    htmlTemplate: 'index.html',
    plugins: [],
    renderer: testRenderer(),
  },
  {
    appId: 'child',
    entryPoint: 'child',
    clientRoot: '',
    entryClient: 'entry-client',
    entryServer: 'entry-server',
    htmlTemplate: 'index.html',
    plugins: [],
    renderer: testRenderer(),
  },
];

vi.mock('../utils/AssetManager', () => ({ processConfigs: vi.fn(() => graphAppConfigs) }));

async function importBuild() {
  vi.resetModules();
  return await import('../Build');
}

const graphConfig = {
  apps: [
    { appId: 'root', entryPoint: '', routes: [{ path: '/' }] },
    { appId: 'child', entryPoint: 'child', routes: [{ path: '/child' }] },
  ],
};

let projectRoot: string;
let clientBaseDir: string;

const seedGraph = async () => {
  const dir = path.join(projectRoot, 'dist', '.taujs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'graph.json');
  await writeFile(file, '{"seed":"previous-successful-build"}', 'utf8');
  return file;
};

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'taujs-failure-exit-'));
  clientBaseDir = path.join(projectRoot, 'src/client');

  for (const [index, entryPoint] of ['', 'child'].entries()) {
    const clientRoot = entryPoint ? path.join(clientBaseDir, entryPoint) : clientBaseDir;
    graphAppConfigs[index]!.clientRoot = clientRoot;
    await mkdir(clientRoot, { recursive: true });
    await writeFile(path.join(clientRoot, 'entry-client.tsx'), 'export {};', 'utf8');
    await writeFile(path.join(clientRoot, 'entry-server.tsx'), 'export {};', 'utf8');
  }

  delete process.env.BUILD_MODE;
  delete process.env.TAUJS_APP;
  delete process.env.TAUJS_APPS;
  vi.clearAllMocks();
});

afterEach(() => {
  // The mocked-vite cells never call the real process.exit, but a rejected build under the OLD
  // code still runs the OLD `process.exit(1)` unless it is spied away below; either way,
  // exitCode is process-global and must never leak into the next test.
  process.exitCode = undefined;
});

describe('taujsBuild - failed builds set exitCode and return, never truncate or erase the graph', () => {
  describe('spawned (real Vite, real process exit)', () => {
    const fixtureRoot = fileURLToPath(new URL('../../../../fixtures/playground-react/', import.meta.url));
    const childScript = fileURLToPath(new URL('./support/BuildFailureExit.child.ts', import.meta.url));
    const SPAWN_TIMEOUT_MS = 30_000;

    const makeSpawnProject = async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'taujs-failure-exit-spawn-'));
      const client = path.join(root, 'src/client');
      await mkdir(client, { recursive: true });
      await writeFile(path.join(client, 'entry-client.tsx'), 'export {};', 'utf8');
      await writeFile(path.join(client, 'entry-server.tsx'), 'export {};', 'utf8');
      return { root, client };
    };

    it('a >64 KiB diagnostic on a piped stderr arrives in full, with the exit code still 1', { timeout: SPAWN_TIMEOUT_MS + 5_000 }, async () => {
      const { root, client } = await makeSpawnProject();
      const stderrFile = path.join(root, 'stderr.txt');

      // `spawnSync`'s own stdio-pipe capture does NOT reproduce the defect: Node drains that
      // pipe from the SAME process, fast and eagerly enough that the child's writes never hit
      // the 64 KiB pipe-full backpressure `process.exit()` then loses (measured: it never
      // truncated, even at 100_000 chars). The followup's own measurement used a REAL pipe into
      // a separate reading process (`node s.mjs 2>&1 | wc -c`) - reproduced here with the same
      // shape: an ordinary pipeline into `cat`, which bash waits for, with pipefail so the
      // child's exit code is the pipeline's. This DID reproduce the exact 65536-byte truncation.
      const result = spawnSync('bash', ['-c', 'set -o pipefail; "$TAUJS_NODE" --import tsx "$TAUJS_CHILD" 2>&1 1>/dev/null | cat > "$TAUJS_STDERR_FILE"'], {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          TAUJS_NODE: process.execPath,
          TAUJS_CHILD: childScript,
          TAUJS_STDERR_FILE: stderrFile,
          TAUJS_TEST_PROJECT_ROOT: root,
          TAUJS_TEST_CLIENT_BASE_DIR: client,
          TAUJS_TEST_THROW_LARGE: '1',
        },
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });

      expect(result.error, `child spawn failed: ${result.error?.message}`).toBeUndefined();
      const stderr = existsSync(stderrFile) ? await readFile(stderrFile, 'utf8') : '';
      expect(stderr, 'the full 100_000-char diagnostic, not a 64 KiB-truncated prefix').toContain('TAIL_MARKER_9f8e7d');
      expect(result.status).toBe(1);
    });

    it('exits 1 when no apps match the filter, and a pre-seeded graph is byte-identical after', { timeout: SPAWN_TIMEOUT_MS + 5_000 }, async () => {
      const { root, client } = await makeSpawnProject();
      const graphDir = path.join(root, 'dist', '.taujs');
      await mkdir(graphDir, { recursive: true });
      const graphFile = path.join(graphDir, 'graph.json');
      await writeFile(graphFile, '{"seed":"previous-successful-build"}', 'utf8');
      const before = await readFile(graphFile, 'utf8');

      const result = spawnSync(process.execPath, ['--import', 'tsx', childScript], {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          TAUJS_TEST_PROJECT_ROOT: root,
          TAUJS_TEST_CLIENT_BASE_DIR: client,
          TAUJS_APPS: 'nope',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SPAWN_TIMEOUT_MS,
      });

      expect(result.error, `child spawn failed: ${result.error?.message}`).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No apps match filter "nope"');

      const after = await readFile(graphFile, 'utf8');
      expect(after).toBe(before);
    });
  });

  it('names exactly the not-yet-built apps, by appId, in ACTUAL build order - never the failed one', async () => {
    const { taujsBuild } = await importBuild();

    // Declared [child(a/b), unrelated(baz), parent(a)] builds [parent, child, unrelated] - the
    // same ancestry-reorder fixture as Build.test.ts's interleaved-order cell. Failing the FIRST
    // app in BUILD order (parent) must name the remaining build-order apps (child, unrelated),
    // never parent, and never in declared order.
    const interleaved = [
      { appId: 'child', entryPoint: 'a/b' },
      { appId: 'unrelated', entryPoint: 'baz' },
      { appId: 'parent', entryPoint: 'a' },
    ].map(({ appId, entryPoint }) => ({
      appId,
      entryPoint,
      clientRoot: path.join(clientBaseDir, entryPoint),
      entryClient: 'entry-client',
      entryServer: 'entry-server',
      htmlTemplate: 'index.html',
      plugins: [],
      renderer: testRenderer(),
    }));
    const { processConfigs } = await import('../utils/AssetManager');
    // Once, not a standing mockReturnValue: this must not leak into the next test's calls once
    // `processConfigs` is invoked again (it mutated real module state, not per-call args).
    vi.mocked(processConfigs).mockReturnValueOnce(interleaved as any);

    for (const entryPoint of ['a', 'a/b', 'baz']) {
      const clientRoot = path.join(clientBaseDir, entryPoint);
      await mkdir(clientRoot, { recursive: true });
      await writeFile(path.join(clientRoot, 'entry-client.tsx'), 'export {};', 'utf8');
      await writeFile(path.join(clientRoot, 'entry-server.tsx'), 'export {};', 'utf8');
    }

    const { build } = await import('vite');
    vi.mocked(build).mockRejectedValueOnce(new Error('parent build exploded'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await taujsBuild({ config: { apps: [] }, projectRoot, clientBaseDir });

    const lines = consoleErrorSpy.mock.calls.map((call) => call.join(' '));
    const stopLine = lines.find((line) => line.includes('Stopping:'));

    expect(stopLine, `no "Stopping" line among: ${JSON.stringify(lines)}`).toBeDefined();
    expect(stopLine).toBe('[taujs:build] Stopping: 2 app(s) not attempted: child, unrelated');
    expect(process.exitCode).toBe(1);

    consoleErrorSpy.mockRestore();
  });

  it('a failed SSR build leaves a pre-seeded graph byte-identical, with its mtime unchanged', async () => {
    const { taujsBuild } = await importBuild();
    const graphFile = await seedGraph();
    const before = await readFile(graphFile, 'utf8');
    const statBefore = await stat(graphFile);

    const { build } = await import('vite');
    vi.mocked(build).mockRejectedValueOnce(new Error('ssr build exploded'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await taujsBuild({ config: graphConfig, projectRoot, clientBaseDir, isSSRBuild: true });

    expect(await readFile(graphFile, 'utf8')).toBe(before);
    expect((await stat(graphFile)).mtimeMs).toBe(statBefore.mtimeMs);
    expect(process.exitCode).toBe(1);

    consoleErrorSpy.mockRestore();
  });

  // Pin (ruling 3, filtered branch): a future change must not reintroduce graph deletion or
  // marking on a filtered failure.
  it('a failed FILTERED client build leaves a pre-seeded graph untouched', async () => {
    const { taujsBuild } = await importBuild();
    const graphFile = await seedGraph();
    const before = await readFile(graphFile, 'utf8');
    process.env.TAUJS_APP = 'child';

    const { build } = await import('vite');
    vi.mocked(build).mockRejectedValueOnce(new Error('child build exploded'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await taujsBuild({ config: graphConfig, projectRoot, clientBaseDir });

    expect(await readFile(graphFile, 'utf8')).toBe(before);
    expect(process.exitCode).toBe(1);

    consoleErrorSpy.mockRestore();
  });

  // Pin (ruling 3, unfiltered branch): emitGraphArtifact runs only after the loop completes, so a
  // partial unfiltered build must never start emitting a graph.
  it('a failed UNFILTERED client build leaves the graph absent, and none is emitted', async () => {
    const { taujsBuild } = await importBuild();
    await seedGraph();

    const { build } = await import('vite');
    vi.mocked(build).mockRejectedValueOnce(new Error('root build exploded'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await taujsBuild({ config: graphConfig, projectRoot, clientBaseDir });

    // The unfiltered pre-build `deleteDist` already removed the whole `dist` tree, including the
    // seeded graph, before the loop's first failure - and it is not recreated.
    expect(existsSync(path.join(projectRoot, 'dist', '.taujs', 'graph.json'))).toBe(false);
    expect(process.exitCode).toBe(1);

    consoleErrorSpy.mockRestore();
  });
});
