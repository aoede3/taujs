// @vitest-environment node
import * as nodePath from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL_ENV = process.env.NODE_ENV;

async function importSystemWithEnv(env: string | undefined) {
  // `process.env.NODE_ENV = undefined` stores the STRING "undefined", which is a different class
  // from a genuinely unset variable - the state real supervisors produce. Delete it instead.
  if (env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;

  vi.resetModules();

  return await import('../System');
}

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV;
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

  it('unset NODE_ENV behaves as production (isDevelopment=false)', async () => {
    const sys = await importSystemWithEnv(undefined);

    expect(sys.isDevelopment).toBe(false);

    const expectedDir = nodePath.join(nodePath.dirname(sys.__filename), './');
    expect(nodePath.normalize(sys.__dirname)).toBe(nodePath.normalize(expectedDir));
  });
});

// The frozen mapping. Development must be requested explicitly; production, test, unset and ANY
// other value (staging, ci, a typo) are one production mode. The fifth class is the point: the two
// derivations this replaced partitioned on different literals, so everything outside them produced
// a development client root with production asset loading.
const MODE_CLASSES: ReadonlyArray<readonly [label: string, nodeEnv: string | undefined, mode: 'development' | 'production']> = [
  ['development', 'development', 'development'],
  ['production', 'production', 'production'],
  ['test', 'test', 'production'],
  ['unset', undefined, 'production'],
  ['an arbitrary value', 'staging', 'production'],
];

describe('resolveRuntimeMode (pure)', () => {
  // Direct resolver coverage ADDS to the consuming-site tests; it never stands in for them.
  it.each(MODE_CLASSES)('%s resolves to %s', async (_label, nodeEnv, mode) => {
    const { resolveRuntimeMode } = await import('../System');

    expect(resolveRuntimeMode(nodeEnv)).toBe(mode);
  });

  it('is pure: the argument decides, not the ambient environment', async () => {
    const { resolveRuntimeMode } = await importSystemWithEnv('production');

    expect(resolveRuntimeMode('development')).toBe('development');
    expect(resolveRuntimeMode(undefined)).toBe('production');
  });
});

describe('runtimeMode snapshot', () => {
  it.each(MODE_CLASSES)('%s snapshots runtimeMode=%s with isDevelopment agreeing', async (_label, nodeEnv, mode) => {
    const sys = await importSystemWithEnv(nodeEnv);

    expect(sys.runtimeMode).toBe(mode);
    expect(sys.isDevelopment).toBe(mode === 'development');
  });

  it('is taken once at module evaluation: a later NODE_ENV change does not move it', async () => {
    const sys = await importSystemWithEnv('development');

    expect(sys.runtimeMode).toBe('development');

    process.env.NODE_ENV = 'production';
    expect(sys.runtimeMode).toBe('development');
    expect(sys.isDevelopment).toBe(true);

    delete process.env.NODE_ENV;
    expect(sys.runtimeMode).toBe('development');
    expect(sys.isDevelopment).toBe(true);
  });
});
