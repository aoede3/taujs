import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRAMEWORK_EXTRAS, planFiles, type Framework, type ProjectConfig } from '../index';

// Reads the WORKSPACE manifests directly - never a copy, never a value hand-transcribed here - so
// this test fails the moment a generated pin drifts from the peers it must satisfy, exactly the
// way solid's fastify pin drifted from @taujs/server's peerDependencies before this unit.
const here = path.dirname(fileURLToPath(import.meta.url));
const readJSON = (rel: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(here, rel), 'utf8'));

const serverPkg = readJSON('../../../server/package.json');
const rootPkg = readJSON('../../../../package.json');

const RENDERER_PKG: Record<Framework, Record<string, any>> = {
  react: readJSON('../../../react/package.json'),
  vue: readJSON('../../../vue/package.json'),
  solid: readJSON('../../../solid/package.json'),
};

const VITE_PLUGIN: Record<Framework, string> = {
  react: '@vitejs/plugin-react',
  vue: '@vitejs/plugin-vue',
  solid: 'vite-plugin-solid',
};

const FRAMEWORKS: Framework[] = ['react', 'vue', 'solid'];

const cfg = (framework: Framework): ProjectConfig => ({ projectName: 'demo-app', packageManager: 'npm', installDeps: false, framework });

const generatedPackageJson = (framework: Framework): Record<string, any> => {
  const entry = planFiles(cfg(framework)).find((e) => e.path === 'package.json')!;

  return ('json' in entry ? entry.json : {}) as Record<string, any>;
};

/** Parses a `^x.y.z`-shaped range's floor into a numeric tuple - no semver dependency needed. */
const floor = (range: string): [number, number, number] => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) throw new Error(`not an x.y.z-shaped range: ${range}`);

  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const isAtLeast = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

// A pin must satisfy EVERY peer simultaneously, so its floor must be at least the HIGHEST of the
// floors it needs to satisfy - not the lowest, which a pin could clear while still violating a
// stricter peer.
const higherFloor = (a: [number, number, number], b: [number, number, number]) => (isAtLeast(a, b) ? a : b);

describe('generated dependency pins never drift from the workspace they scaffold against', () => {
  for (const framework of FRAMEWORKS) {
    const pkg = generatedPackageJson(framework);
    const renderer = RENDERER_PKG[framework];

    it(`${framework}: the fastify pin equals @taujs/server's own peerDependencies.fastify`, () => {
      expect(pkg.dependencies.fastify).toBe(serverPkg.peerDependencies.fastify);
    });

    it(`${framework}: the vite pin equals @taujs/server's own peerDependencies.vite`, () => {
      expect(pkg.devDependencies.vite).toBe(serverPkg.peerDependencies.vite);
    });

    it(`${framework}: its Vite plugin pin equals @taujs/${framework}'s own peer for that plugin`, () => {
      const pluginName = VITE_PLUGIN[framework];

      expect(pkg.devDependencies[pluginName]).toBe(renderer.peerDependencies[pluginName]);
    });

    it(`${framework}: the typescript pin's floor satisfies every peer floor server and @taujs/${framework} require`, () => {
      const highestRequired = higherFloor(floor(serverPkg.peerDependencies.typescript), floor(renderer.peerDependencies.typescript));

      expect(isAtLeast(floor(pkg.devDependencies.typescript), highestRequired)).toBe(true);
    });

    for (const dep of Object.keys(FRAMEWORK_EXTRAS[framework].runtimeDeps)) {
      it(`${framework}: the ${dep} pin equals @taujs/${framework}'s own peerDependencies.${dep}`, () => {
        expect(pkg.dependencies[dep]).toBe(renderer.peerDependencies[dep]);
      });
    }

    for (const dep of Object.keys(FRAMEWORK_EXTRAS[framework].typeDeps ?? {})) {
      it(`${framework}: the ${dep} pin's floor satisfies @taujs/${framework}'s own peer floor for it`, () => {
        expect(isAtLeast(floor(pkg.devDependencies[dep]), floor(renderer.peerDependencies[dep]))).toBe(true);
      });
    }

    it(`${framework}: engines.node equals the workspace root's engines.node`, () => {
      expect(pkg.engines.node).toBe(rootPkg.engines.node);
    });
  }
});
