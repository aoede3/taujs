// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

import { testRenderer } from './support/renderer';

// DELIBERATELY NOT MOCKED: `vite` runs for real here. The sibling suite proves the plan and the
// configuration VALUE; this one proves the claim the whole fix rests on - that a real Vite build
// given `emptyOutDir: false` does not go on to empty the directory itself and destroy the
// descendant output taujs just preserved. Only the app list is stubbed.
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

const config = {
  apps: [
    { appId: 'root', entryPoint: '', routes: [{ path: '/' }] },
    { appId: 'child', entryPoint: 'child', routes: [{ path: '/child' }] },
  ],
};

let projectRoot: string;
let clientBaseDir: string;

beforeEach(async () => {
  vi.resetModules();
  projectRoot = await mkdtemp(path.join(tmpdir(), 'taujs-realvite-'));
  clientBaseDir = path.join(projectRoot, 'src/client');

  for (const [index, entryPoint] of ['', 'child'].entries()) {
    const clientRoot = entryPoint ? path.join(clientBaseDir, entryPoint) : clientBaseDir;
    appConfigs[index]!.clientRoot = clientRoot;
    await mkdir(clientRoot, { recursive: true });
    await writeFile(path.join(clientRoot, 'entry-client.tsx'), `export const client = ${JSON.stringify(entryPoint || 'root')};\n`, 'utf8');
    await writeFile(path.join(clientRoot, 'entry-server.tsx'), `export const server = ${JSON.stringify(entryPoint || 'root')};\n`, 'utf8');
  }

  delete process.env.BUILD_MODE;
  delete process.env.TAUJS_APP;
  delete process.env.TAUJS_APPS;
});

/** Stands in for the descendant app's previous build, which this run must not touch. */
const seedDescendantOutput = async (kind: 'client' | 'ssr') => {
  const dir = path.join(projectRoot, 'dist', kind, 'child');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'previous-build.js'), 'export const previous = true;\n', 'utf8');
  await writeFile(path.join(projectRoot, 'dist', kind, 'parent-stale.js'), 'export const stale = true;\n', 'utf8');
};

describe('real Vite honours emptyOutDir: false on a filtered parent build', () => {
  it('CLIENT: the descendant output survives a real build of the parent alone', async () => {
    const { taujsBuild } = await import('../Build');
    await seedDescendantOutput('client');
    process.env.TAUJS_APP = 'root';

    await taujsBuild({ config, projectRoot, clientBaseDir });

    const clientDist = path.join(projectRoot, 'dist', 'client');

    // The descendant app's previous output is intact - Vite did not empty the directory.
    expect(existsSync(path.join(clientDist, 'child', 'previous-build.js'))).toBe(true);
    expect(await readFile(path.join(clientDist, 'child', 'previous-build.js'), 'utf8')).toContain('previous = true');

    // taujs's own cleanup still cleared the parent's stale output...
    expect(existsSync(path.join(clientDist, 'parent-stale.js'))).toBe(false);

    // ...and the parent really did build (a manifest plus emitted chunks).
    expect(existsSync(path.join(clientDist, '.vite', 'manifest.json'))).toBe(true);
  }, 60_000);

  it('SSR: the descendant output survives a real SSR build of the parent alone', async () => {
    const { taujsBuild } = await import('../Build');
    await seedDescendantOutput('ssr');
    process.env.TAUJS_APP = 'root';

    await taujsBuild({ config, projectRoot, clientBaseDir, isSSRBuild: true });

    const ssrDist = path.join(projectRoot, 'dist', 'ssr');

    expect(existsSync(path.join(ssrDist, 'child', 'previous-build.js'))).toBe(true);
    expect(existsSync(path.join(ssrDist, 'parent-stale.js'))).toBe(false);

    // Extension-agnostic ON PURPOSE. This temporary project declares no `"type": "module"`, so Vite
    // emits `entry-server.mjs` rather than `entry-server.js` - which is exactly the separate,
    // already-filed defect where `AssetManager` hard-codes `${entryServer}.js` for the render module
    // while the client entry is probed. Asserting `.js` here would couple this suite to that bug and
    // start failing when it is fixed, so this only checks that the parent's SSR entry was emitted.
    const emitted = await readdir(ssrDist);
    expect(emitted.some((f) => /^entry-server\.(js|mjs)$/.test(f))).toBe(true);
  }, 60_000);

  it('CONTROL: an unfiltered real build still lets Vite empty, so nothing stale survives', async () => {
    const { taujsBuild } = await import('../Build');
    await seedDescendantOutput('client');

    await taujsBuild({ config, projectRoot, clientBaseDir });

    // The full build deletes dist up front, so the seeded descendant output is correctly gone and
    // both apps are freshly built. This is the behaviour the fix must NOT have changed.
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'child', 'previous-build.js'))).toBe(false);
    expect(existsSync(path.join(projectRoot, 'dist', 'client', '.vite', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(projectRoot, 'dist', 'client', 'child', '.vite', 'manifest.json'))).toBe(true);
  }, 60_000);
});
