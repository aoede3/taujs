// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vite', () => ({
  build: vi.fn(async () => ({})),
}));

const appConfig = {
  appId: 'web',
  entryPoint: 'web',
  clientRoot: '', // set per-test to a real temp dir with entry files
  entryClient: 'entry-client',
  entryServer: 'entry-server',
  htmlTemplate: 'index.html',
  plugins: [],
};

vi.mock('../utils/AssetManager', () => ({
  processConfigs: vi.fn(() => [appConfig]),
}));

async function importBuild() {
  vi.resetModules();
  return await import('../Build');
}

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'taujs-build-'));
  appConfig.clientRoot = path.join(projectRoot, 'src/client/web');
  await mkdir(appConfig.clientRoot, { recursive: true });
  await writeFile(path.join(appConfig.clientRoot, 'entry-client.tsx'), 'export {};', 'utf8');
  await writeFile(path.join(appConfig.clientRoot, 'entry-server.tsx'), 'export {};', 'utf8');
  delete process.env.BUILD_MODE;
});

describe('taujsBuild — graph emission', () => {
  it('writes dist/.taujs/graph.json with source: build and services: null after successful builds', async () => {
    const { taujsBuild } = await importBuild();
    const config = {
      apps: [
        {
          appId: 'web',
          entryPoint: 'web',
          routes: [{ path: '/', attr: { render: 'ssr' as const } }, { path: '/about' }],
        },
      ],
    };

    await taujsBuild({ config, projectRoot, clientBaseDir: path.join(projectRoot, 'src/client') });

    const graph = JSON.parse(await readFile(path.join(projectRoot, 'dist', '.taujs', 'graph.json'), 'utf8'));

    expect(graph.source).toBe('build');
    expect(graph.services).toBeNull();
    expect(graph.schemaVersion).toBe(1);
    expect(graph.routes.map((r: { id: string }) => r.id)).toEqual(['web:/about', 'web:/']);
    expect(graph.warnings.some((w: { code: string }) => w.code === 'render.defaulted')).toBe(true);
  });
});
