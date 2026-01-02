// @vitest-environment node
import * as nodePath from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL_ENV = process.env.NODE_ENV;

async function importSystemWithEnv(env: string | undefined) {
  process.env.NODE_ENV = env as any;
  vi.resetModules();

  return await import('../System');
}

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV;
});

describe('System constants', () => {
  it('development: isDevelopment=true and __dirname goes one level up', async () => {
    const sys = await importSystemWithEnv('development');

    expect(sys.isDevelopment).toBe(true);

    // __filename should be absolute and end with the module file name
    expect(nodePath.isAbsolute(sys.__filename)).toBe(true);
    expect(nodePath.basename(sys.__filename)).toMatch(/System\.(ts|js|mjs|cjs)$/);

    // __dirname should be dirname(__filename) + '..' in dev
    const expectedDevDir = nodePath.join(nodePath.dirname(sys.__filename), '..');
    expect(nodePath.normalize(sys.__dirname)).toBe(nodePath.normalize(expectedDevDir));
  });

  it('production: isDevelopment=false and __dirname stays at current directory ("./")', async () => {
    const sys = await importSystemWithEnv('production');

    expect(sys.isDevelopment).toBe(false);

    // __dirname should be dirname(__filename) + './' in prod (i.e., effectively the same dir)
    const expectedProdDir = nodePath.join(nodePath.dirname(sys.__filename), './');
    expect(nodePath.normalize(sys.__dirname)).toBe(nodePath.normalize(expectedProdDir));
  });

  it('non-dev envs (e.g., "test") behave as production (isDevelopment=false)', async () => {
    const sys = await importSystemWithEnv('test');

    expect(sys.isDevelopment).toBe(false);

    const expectedDir = nodePath.join(nodePath.dirname(sys.__filename), './');
    expect(nodePath.normalize(sys.__dirname)).toBe(nodePath.normalize(expectedDir));
  });

  it('undefined NODE_ENV behaves as production (isDevelopment=false)', async () => {
    const sys = await importSystemWithEnv(undefined);

    expect(sys.isDevelopment).toBe(false);

    const expectedDir = nodePath.join(nodePath.dirname(sys.__filename), './');
    expect(nodePath.normalize(sys.__dirname)).toBe(nodePath.normalize(expectedDir));
  });
});
