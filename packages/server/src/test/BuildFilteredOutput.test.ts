// @vitest-environment node
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { testRenderer } from './support/renderer';

import type { InlineConfig } from 'vite';

vi.mock('vite', () => ({ build: vi.fn(async () => ({})) }));

// Two DECLARED apps in an ancestor/descendant outDir relationship: the root app owns
// `dist/client`, the child app owns `dist/client/child` inside it. This is the shape that makes a
// parent's blind `emptyOutDir` destructive, and no fixture in the repo has it.
const appConfigs = [
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

vi.mock('../utils/AssetManager', () => ({ processConfigs: vi.fn(() => appConfigs) }));

async function importBuild() {
  vi.resetModules();
  return await import('../Build');
}

const config = {
  apps: [
    { appId: 'root', entryPoint: '', routes: [{ path: '/' }] },
    { appId: 'child', entryPoint: 'child', routes: [{ path: '/child' }] },
  ],
};

let projectRoot: string;
let clientBaseDir: string;

/** Marker files standing in for a previous build's output. */
const seedBuiltOutput = async (kind: 'client' | 'ssr') => {
  const base = path.join(projectRoot, 'dist', kind);
  await mkdir(path.join(base, 'child'), { recursive: true });
  await writeFile(path.join(base, 'root-output.js'), '// root', 'utf8');
  await writeFile(path.join(base, 'child', 'child-output.js'), '// child', 'utf8');
};

const buildArgs = () => ({ config, projectRoot, clientBaseDir });

const viteConfigFor = async (entryPointDir: string): Promise<InlineConfig | undefined> => {
  const { build } = await import('vite');
  const calls = (build as unknown as { mock: { calls: [InlineConfig][] } }).mock.calls;

  return calls.map(([c]) => c).find((c) => c.build?.outDir?.endsWith(entryPointDir));
};

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'taujs-filtered-'));
  clientBaseDir = path.join(projectRoot, 'src/client');

  for (const [index, entryPoint] of ['', 'child'].entries()) {
    const clientRoot = entryPoint ? path.join(clientBaseDir, entryPoint) : clientBaseDir;
    appConfigs[index]!.clientRoot = clientRoot;
    await mkdir(clientRoot, { recursive: true });
    await writeFile(path.join(clientRoot, 'entry-client.tsx'), 'export {};', 'utf8');
    await writeFile(path.join(clientRoot, 'entry-server.tsx'), 'export {};', 'utf8');
  }

  delete process.env.BUILD_MODE;
  delete process.env.TAUJS_APP;
  delete process.env.TAUJS_APPS;
  vi.clearAllMocks();
});

describe('taujsBuild - a filtered build preserves the apps it was not asked to build', () => {
  it('UNFILTERED: still deletes the whole dist tree, so a removed app cannot survive', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('client');
    await writeFile(path.join(projectRoot, 'dist', 'client', 'removed-app-leftover.js'), '// stale', 'utf8');

    await taujsBuild(buildArgs());

    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'removed-app-leftover.js'))).toBe(false);
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'root-output.js'))).toBe(false);
  });

  it('UNFILTERED: leaves Vite to empty each outDir, exactly as before', async () => {
    const { taujsBuild } = await importBuild();

    await taujsBuild(buildArgs());

    expect((await viteConfigFor(path.join('dist', 'client')))?.build?.emptyOutDir).toBe(true);
    expect((await viteConfigFor(path.join('dist', 'client', 'child')))?.build?.emptyOutDir).toBe(true);
  });

  it('FILTERED to the child: the whole dist tree survives, including the root app output', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('client');
    process.env.TAUJS_APP = 'child';

    await taujsBuild(buildArgs());

    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'root-output.js'))).toBe(true);
    // The child owns no declared descendant, so Vite still empties its own directory.
    expect((await viteConfigFor(path.join('dist', 'client', 'child')))?.build?.emptyOutDir).toBe(true);
  });

  it('FILTERED to the PARENT: the child app output survives and Vite is told not to empty', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('client');
    process.env.TAUJS_APP = 'root';

    await taujsBuild(buildArgs());

    // The parent's own stale output is still cleared...
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'root-output.js'))).toBe(false);
    // ...while the unselected child app's output is untouched.
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'child', 'child-output.js'))).toBe(true);
    // And Vite must not empty it again behind us.
    expect((await viteConfigFor(path.join('dist', 'client')))?.build?.emptyOutDir).toBe(false);
  });

  it('FILTERED to the PARENT, SSR build: the child SSR output survives too', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('ssr');
    process.env.TAUJS_APP = 'root';

    await taujsBuild({ ...buildArgs(), isSSRBuild: true });

    expect(existsSync(path.join(projectRoot, 'dist', 'ssr', 'root-output.js'))).toBe(false);
    expect(existsSync(path.join(projectRoot, 'dist', 'ssr', 'child', 'child-output.js'))).toBe(true);
    expect((await viteConfigFor(path.join('dist', 'ssr')))?.build?.emptyOutDir).toBe(false);
  });

  it('FILTERED: the graph artefact is still re-emitted, and still describes EVERY declared app', async () => {
    const { taujsBuild } = await importBuild();
    process.env.TAUJS_APP = 'child';

    await taujsBuild(buildArgs());

    const graph = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(projectRoot, 'dist', '.taujs', 'graph.json'), 'utf8'));

    expect(graph.apps.map((a: { appId: string }) => a.appId).sort()).toEqual(['child', 'root']);
  });

  it('FILTERED: only the selected app is handed to Vite', async () => {
    const { taujsBuild } = await importBuild();
    process.env.TAUJS_APP = 'child';

    await taujsBuild(buildArgs());

    const { build } = await import('vite');
    const outDirs = (build as unknown as { mock: { calls: [InlineConfig][] } }).mock.calls.map(([c]) => c.build?.outDir);

    expect(outDirs).toHaveLength(1);
    expect(outDirs[0]).toBe(path.join(projectRoot, 'dist', 'client', 'child'));
  });

  it('FILTERED to the child, SSR build: the parent app SSR output survives', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('ssr');
    process.env.TAUJS_APP = 'child';

    await taujsBuild({ ...buildArgs(), isSSRBuild: true });

    expect(existsSync(path.join(projectRoot, 'dist', 'ssr', 'root-output.js'))).toBe(true);
    expect((await viteConfigFor(path.join('dist', 'ssr', 'child')))?.build?.emptyOutDir).toBe(true);
  });

  it('FILTERED to BOTH: the parent preserves the descendant directory, and the child then rebuilds it', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('client');
    process.env.TAUJS_APPS = 'root,child';

    await taujsBuild(buildArgs());

    // The ancestry reorder builds the parent first, so its preserving empty must not delete the
    // directory the child is about to rebuild into - the descendant may itself be SELECTED.
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'child', 'child-output.js'))).toBe(true);
    expect((await viteConfigFor(path.join('dist', 'client')))?.build?.emptyOutDir).toBe(false);
    // The child owns no descendant of its own, so Vite still empties and rebuilds it.
    expect((await viteConfigFor(path.join('dist', 'client', 'child')))?.build?.emptyOutDir).toBe(true);
  });

  it('a build that REJECTS still leaves the descendant intact - the cleanup has run, so the parent output is gone', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('client');
    process.env.TAUJS_APP = 'root';

    const { build } = await import('vite');
    (build as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(new Error('config exploded'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await taujsBuild(buildArgs());

    // build() itself failed, so the parent's own output IS gone - the cleanup ran immediately
    // before it. The descendant is still preserved, which is the invariant under test here.
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'root-output.js'))).toBe(false);
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'child', 'child-output.js'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
    err.mockRestore();
  });

  it('a failure BEFORE build() destroys NOTHING: a throwing config.vite leaves parent and descendant intact', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('client');
    process.env.TAUJS_APP = 'root';

    const exploding = {
      ...config,
      vite: () => {
        throw new Error('config.vite exploded');
      },
    };

    await expect(taujsBuild({ ...buildArgs(), config: exploding as never })).rejects.toThrow('config.vite exploded');

    // This is exactly what deferring the deletion to immediately before `build()` buys. The
    // callback throws while the plan is already computed but nothing has been emptied, so BOTH the
    // parent's previous output and the descendant's survive a build that never started.
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'root-output.js'))).toBe(true);
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'child', 'child-output.js'))).toBe(true);
  });

  it('the preserving empty does not disturb a sibling directory that is not a declared outDir', async () => {
    const { taujsBuild } = await importBuild();
    await seedBuiltOutput('client');
    await mkdir(path.join(projectRoot, 'dist', 'client', 'assets'), { recursive: true });
    await writeFile(path.join(projectRoot, 'dist', 'client', 'assets', 'a.css'), 'a{}', 'utf8');
    process.env.TAUJS_APP = 'root';

    await taujsBuild(buildArgs());

    // `assets` belongs to the app being rebuilt, so it is cleared like the rest of its output.
    expect(await readdir(path.join(projectRoot, 'dist', 'client'))).toEqual(['child']);
  });
});
