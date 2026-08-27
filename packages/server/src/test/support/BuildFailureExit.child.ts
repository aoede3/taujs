// Spawned by BuildFailureExit.test.ts as a real child process (pattern copied from
// RuntimeLoggerFallthrough.child.ts: `spawnSync(process.execPath, ['--import', 'tsx', ...])`).
// Runs the REAL taujsBuild from source against real Vite - no `vi.mock`, so this is the only way
// to observe the actual stdio behaviour (piped-stderr truncation, process exit code) a mocked
// in-process test cannot see.
import { fileURLToPath } from 'node:url';

const buildModule = fileURLToPath(new URL('../../Build.ts', import.meta.url));
const { taujsBuild } = await import(buildModule);

const projectRoot = process.env.TAUJS_TEST_PROJECT_ROOT!;
const clientBaseDir = process.env.TAUJS_TEST_CLIENT_BASE_DIR!;
const throwLarge = process.env.TAUJS_TEST_THROW_LARGE === '1';

// Structurally-valid v2 renderer contribution with no managed compilation - inlined rather than
// imported from test/support/renderer.ts, so this child has no dependency on the vitest runner.
const testRenderer = () => ({
  brand: 'taujs.renderer-contribution/v2',
  key: 'test',
  contractVersion: 'v1',
  managedCompilation: false,
  loadEnvironmentPlugins: async () => [],
});

const config = {
  apps: [{ appId: 'a', entryPoint: '', renderer: testRenderer() }],
};

await taujsBuild({
  config,
  projectRoot,
  clientBaseDir,
  ...(throwLarge
    ? {
        // A plugin `config` hook, not the `vite` callback itself: the hook fires when the real
        // Vite `build()` resolves config, which is INSIDE taujsBuild's try/catch - the callback
        // that RETURNS this plugin runs outside the try, but returning a plugin does not throw.
        vite: () => ({
          plugins: [
            {
              name: 'boom',
              config() {
                throw new Error('x'.repeat(100_000) + 'TAIL_MARKER_9f8e7d');
              },
            },
          ],
        }),
      }
    : {}),
});
