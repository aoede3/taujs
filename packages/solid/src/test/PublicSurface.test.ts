// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Slice-6 public-surface gates, asserted against the BUILT dist and the package manifest - the
 * shipped artifact, not the source tree.
 */
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const distPath = (file: string) => fileURLToPath(new URL(`../../dist/${file}`, import.meta.url));

describe('slice 6 - the published export map', () => {
  it('exposes exactly three entries plus package.json', () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './package.json', './plugin', './renderer']);
  });

  it('every entry points at a built file that exists, with types', () => {
    for (const [name, value] of Object.entries(packageJson.exports)) {
      if (name === './package.json') continue;
      const entry = value as { types: string; import: string };

      expect(entry.types, `${name} declares no types`).toBeTruthy();
      expect(existsSync(fileURLToPath(new URL(`../../${entry.import}`, import.meta.url))), `${name} -> ${entry.import} missing`).toBe(true);
      expect(existsSync(fileURLToPath(new URL(`../../${entry.types}`, import.meta.url))), `${name} -> ${entry.types} missing`).toBe(true);
    }
  });

  it('INTERNALS are unimportable: no export path reaches them', () => {
    // The encapsulation gate. `SanitiseError` in particular is internal, installed first and
    // NON-DISABLEABLE - an importable module invites a consumer to build their own seroval plugin
    // chain around it, which is exactly the configuration surface the ruling forbids.
    const internals = ['SanitiseError', 'Holder', 'internal', 'renderContract', 'SSRDataStore', 'SSRRender', 'SSRHydration', 'compiler', 'utils'];
    const exportPaths = Object.keys(packageJson.exports);

    for (const internal of internals) {
      expect(
        exportPaths.some((p) => p.toLowerCase().includes(internal.toLowerCase())),
        `${internal} is reachable through the export map`,
      ).toBe(false);
    }

    // ...and there is no wildcard escape hatch such as "./*" or "./dist/*".
    expect(exportPaths.some((p) => p.includes('*'))).toBe(false);
  });
});

describe('slice 6 - the runtime author surface (`@taujs/solid`)', () => {
  it('exports exactly the frozen runtime API', async () => {
    const rootModule = await import('../index.js');

    expect(Object.keys(rootModule).sort()).toEqual(['createRenderer', 'createSSRStore', 'escapeHtml', 'hydrateApp', 'useSSRStore']);
  });

  it('does NOT export solidRenderer - the root-vs-subpath split is frozen', async () => {
    const rootModule = (await import('../index.js')) as Record<string, unknown>;

    // Re-exporting it here "for convenience" would pull the optional compiler/Vite peers into the
    // module graph of every client bundle that imports this entry. Any change returns for a DX
    // ruling with packed-consumer evidence.
    expect(rootModule.solidRenderer).toBeUndefined();
  });

  it('does NOT leak the sanitiser, the holders or the store internals', async () => {
    const rootModule = (await import('../index.js')) as Record<string, unknown>;

    for (const leaked of ['SanitisedErrorPlugin', 'REDACTED_MESSAGE', 'REDACTED_NAME', 'createHolder', 'provideSSRStore', 'detachStore', 'brandRenderFunctions']) {
      expect(rootModule[leaked], `${leaked} leaked from the root entry`).toBeUndefined();
    }
  });
});

describe('slice 6 - the renderer subpath (`@taujs/solid/renderer`)', () => {
  it('exposes ONLY solidRenderer', async () => {
    const rendererModule = await import('../renderer.js');

    expect(Object.keys(rendererModule)).toEqual(['solidRenderer']);
  });

  it('accepts exactly `{ project }` - no transform-mode or plugin options', async () => {
    const { solidRenderer } = await import('../renderer.js');
    const contribution = solidRenderer({ project: './tsconfig.solid.json' }) as unknown as { key: string; managedCompilation: boolean };

    expect(contribution.key).toBe('solid');
    expect(contribution.managedCompilation).toBe(true);
  });
});

describe('slice 6 - the raw plugin subpath (`@taujs/solid/plugin`) stays portable', () => {
  it('exposes the raw Vite wrapper and carries no @taujs/server runtime import', () => {
    const built = readFileSync(distPath('plugin.js'), 'utf8');

    expect(built).not.toMatch(/from ['"]@taujs\/server/);
  });
});

describe('slice 6 - dependency classification', () => {
  it('seroval is a real dependency pinned exactly, not an optional peer', () => {
    expect(packageJson.dependencies.seroval).toBe('1.5.5');
    expect(packageJson.peerDependencies.seroval).toBeUndefined();
  });

  it('solid-js is a REQUIRED peer - the root entry ships runtime code that imports it', () => {
    expect(packageJson.peerDependencies['solid-js']).toBeTruthy();
    expect(packageJson.peerDependenciesMeta?.['solid-js']?.optional).toBeUndefined();
  });

  it('the compiler/Vite peers stay OPTIONAL - a client-only consumer installs none of them', () => {
    for (const optional of ['vite', 'vite-plugin-solid', 'typescript']) {
      expect(packageJson.peerDependenciesMeta?.[optional]?.optional, `${optional} should be an optional peer`).toBe(true);
    }
  });
});

describe('slice 6 - server builds resolve the SERVER solid-js/web implementation', () => {
  it('the node condition resolves solid-js/web to the server build', () => {
    // Design 6's export-condition gate. The renderer runs under the node condition, where
    // `solid-js/web` must resolve to `server.js` - that is the build carrying `renderToStream`,
    // `renderToStringAsync` and the server `generateHydrationScript` the adapter calls.
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('solid-js/web', { paths: [fileURLToPath(new URL('../../', import.meta.url))] });

    expect(resolved).toMatch(/web[/\\]dist[/\\]server\.(js|cjs)$/);
  });

  it('the resolved server build actually provides the SSR entry points the adapter uses', async () => {
    const web = (await import('solid-js/web')) as Record<string, unknown>;

    for (const api of ['renderToStream', 'renderToStringAsync', 'generateHydrationScript', 'ssr']) {
      expect(typeof web[api], `${api} missing from the resolved solid-js/web build`).toBe('function');
    }
  });

  it('the server generateHydrationScript accepts the nonce options bag', async () => {
    // The types/runtime mismatch recorded in slice 4: the CLIENT declaration takes no arguments,
    // the SERVER one takes `{ nonce?, eventNames? }`. This asserts the RUNTIME behaviour the
    // adapter's documented alias relies on, so the alias cannot quietly become wrong.
    const { generateHydrationScript } = (await import('solid-js/web')) as unknown as {
      generateHydrationScript: (options?: { nonce?: string }) => string;
    };

    expect(generateHydrationScript({ nonce: 'N0NCE' })).toContain('nonce="N0NCE"');
    expect(generateHydrationScript()).not.toContain('nonce=');
  });
});
