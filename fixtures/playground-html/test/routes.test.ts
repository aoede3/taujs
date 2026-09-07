// @vitest-environment node
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { assertWorkspacePackagesBuilt } from '../../test-support/BuiltPackages';

/**
 * The `@taujs/html` PRODUCT cell: a real τjs server, built and booted from the fixture's own
 * `npm run build`/`npm run start`/`npm run dev` scripts (never the vitest process importing the
 * renderer directly), driven over plain `fetch`. Modelled on
 * `fixtures/playground-vue/test/browser.test.ts`'s server-boot machinery, minus the browser: this
 * file proves emission (the bytes a real prod/dev boot actually sends); `test/browser.test.ts`
 * proves the client-side enhancement those bytes are for.
 */
const PROJECT = fileURLToPath(new URL('../', import.meta.url));

const isPortFree = async (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

/** Two distinct ephemeral 127.0.0.1 ports, bound SIMULTANEOUSLY so the OS cannot hand back the same one twice. */
const allocatePortPair = async (): Promise<[number, number]> => {
  const bind = () =>
    new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });

  const [a, b] = await Promise.all([bind(), bind()]);
  const [portA, portB] = [(a.address() as AddressInfo).port, (b.address() as AddressInfo).port];
  await Promise.all([new Promise((r) => a.close(r)), new Promise((r) => b.close(r))]);

  return [portA, portB];
};

const stopChild = async (child: ChildProcess | undefined, port: number, timeoutMs = 20_000): Promise<void> => {
  if (!child) return;

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, timeoutMs))]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${port} still bound after teardown`);
};

const waitForReady = async (base: string, child: ChildProcess, output: () => string, deadlineMs = 120_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server not ready within ${deadlineMs}ms\n${output()}`);
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})\n${output()}`);
    try {
      if ((await fetch(`${base}/`)).status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
};

const spawnServer = (script: 'start' | 'dev', env: Record<string, string>): { child: ChildProcess; output: () => string } => {
  let out = '';
  const child = spawn('npm', ['run', script], {
    cwd: PROJECT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ...env },
  });
  child.stdout?.on('data', (c: Buffer) => (out += String(c)));
  child.stderr?.on('data', (c: Buffer) => (out += String(c)));

  return { child, output: () => out };
};

describe('@taujs/html product cell - a real fixture server, built and booted for real', () => {
  let prodChild: ChildProcess | undefined;
  let prodPort: number;
  let devChild: ChildProcess | undefined;
  let devPort: number;

  afterAll(async () => {
    await stopChild(prodChild, prodPort);
    await stopChild(devChild, devPort);
  });

  it('boots the production build and serves / with the rendered section and __INITIAL_DATA__', async () => {
    assertWorkspacePackagesBuilt(['server', 'html']);

    const [appPort, hmrPort] = await allocatePortPair();
    prodPort = appPort;

    execFileSync('npm', ['run', 'build'], { cwd: PROJECT, stdio: 'pipe' });

    const { child, output } = spawnServer('start', { TAUJS_PORT: String(appPort), TAUJS_HMR_PORT: String(hmrPort), NODE_ENV: 'production' });
    prodChild = child;
    const base = `http://127.0.0.1:${appPort}`;
    await waitForReady(base, child, output);

    const res = await fetch(`${base}/`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('Hello from τjs - framework-free HTML SSR');
    expect(body).toContain('window.__INITIAL_DATA__');
  }, 180_000);

  it('/streaming returns the shell with the meta title, the section, then the data script, in that order', async () => {
    const base = `http://127.0.0.1:${prodPort}`;
    const body = await (await fetch(`${base}/streaming`)).text();

    const titleAt = body.indexOf('<title>τjs HTML playground - streaming</title>');
    const sectionAt = body.indexOf('<section>');
    const dataScriptAt = body.indexOf('window.__INITIAL_DATA__');

    expect(titleAt).toBeGreaterThan(-1);
    expect(sectionAt).toBeGreaterThan(titleAt);
    expect(dataScriptAt).toBeGreaterThan(sectionAt);
    expect(body).toContain('Hello, HTML - streamed once the server resolved this.');
  });

  it('/deferred completes within deferredTimeoutMs + 1000ms and its tail envelope reports the fast entry complete and the never-resolving entry aborted', async () => {
    const base = `http://127.0.0.1:${prodPort}`;
    const startedAt = Date.now();
    const body = await (await fetch(`${base}/deferred`)).text();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500 + 1000);
    expect(body).toContain('window.__TAUJS_DEFERRED_STATE__');
    expect(body).toContain('"reviews":{"status":"complete","value":{"count":3,"top":"a genuinely deferred review"}}');
    expect(body).toContain('"neverResolves":{"status":"aborted"}');
  }, 5_000);

  it('/deferred-no-hydrate completes well under the deferred deadline and contains no deferred carrier', async () => {
    const base = `http://127.0.0.1:${prodPort}`;
    const startedAt = Date.now();
    const body = await (await fetch(`${base}/deferred-no-hydrate`)).text();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(400);
    expect(body).not.toContain('__TAUJS_DEFERRED_STATE__');
  });

  it('/streaming and /deferred contain exactly one bootstrap <script type="module" ... async> tag, positioned before the data script; /deferred-no-hydrate contains none', async () => {
    const base = `http://127.0.0.1:${prodPort}`;
    const bootstrapTag = /<script type="module" src="[^"]+" async[^>]*><\/script>/g;

    for (const path of ['/streaming', '/deferred']) {
      const body = await (await fetch(`${base}${path}`)).text();
      const matches = body.match(bootstrapTag) ?? [];
      expect(matches, `${path} bootstrap tag count`).toHaveLength(1);

      const bootstrapAt = body.indexOf(matches[0]!);
      const dataScriptAt = body.indexOf('window.__INITIAL_DATA__');
      expect(bootstrapAt).toBeLessThan(dataScriptAt);
    }

    const noHydrateBody = await (await fetch(`${base}/deferred-no-hydrate`)).text();
    expect(noHydrateBody.match(bootstrapTag) ?? []).toHaveLength(0);
  });

  it('a dev-mode boot (NODE_ENV=development) serves / with the same rendered section', async () => {
    const [appPort, hmrPort] = await allocatePortPair();
    devPort = appPort;

    const { child, output } = spawnServer('dev', { TAUJS_PORT: String(appPort), TAUJS_HMR_PORT: String(hmrPort), NODE_ENV: 'development' });
    devChild = child;
    const base = `http://127.0.0.1:${appPort}`;
    await waitForReady(base, child, output);

    const body = await (await fetch(`${base}/`)).text();
    expect(body).toContain('Hello from τjs - framework-free HTML SSR');
  }, 180_000);
});
