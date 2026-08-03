// @vitest-environment node
import { describe, it, expect } from 'vitest';

// The runtime/build separation is a public-surface contract: `taujsBuild` must never return to
// the root entry, because the root export was the edge that executed the build module's static
// `import { build } from 'vite'` in every production process. `@taujs/server/build` is its only
// public home. An accidental re-export would reintroduce the graph edge without any behavioural
// test failing - this suite is the committed assertion.

describe('root entry public surface', () => {
  it('does not export taujsBuild', async () => {
    const root = await import('../index');

    expect('taujsBuild' in root).toBe(false);
  });

  it('exports exactly the runtime value surface', async () => {
    const root = await import('../index');

    expect(Object.keys(root).sort()).toEqual(['AppError', 'createRequestGraph', 'createServer', 'winstonAdapter']);
  });
});

describe('build entry public surface', () => {
  it('exports taujsBuild', async () => {
    const build = await import('../Build');

    expect(typeof build.taujsBuild).toBe('function');
  });
});
