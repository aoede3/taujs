// @vitest-environment node
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Slice-7 group B: the dev + production Solid matrix, BLACK BOX.
 *
 * Everything here goes through public τjs entry points - a real server booted from
 * `taujs.config.ts`, driven over HTTP - and asserts on the delivered HTML. No renderer internals
 * are imported, so this cannot pass by agreeing with the implementation's own abstractions; it
 * only passes if a browser would actually receive the right document.
 *
 * The matrix is {ssr, streaming} x {hydrate, no-hydrate} x {development, production} = 8 cells,
 * and each cell asserts far more than a 200: route data, rendered Solid markup, the client entry's
 * presence or absence, the hydration bootstrap and patch machinery, and nonce propagation.
 *
 * COVERAGE BOUNDARY, established by tamper-testing rather than assumed - worth stating so this
 * suite is not credited with more than it can see:
 *
 * - It DOES catch: dropping `noScripts` from `ssr + hydrate:false` (Solid machinery leaks into a
 *   page that must be static), and dropping the bootstrap from a streaming cell (deferred patches
 *   would have nothing to attach to). Both fail here in development AND production.
 * - It CANNOT catch a renderer-side regression in the client-entry gate. The HOST already passes
 *   `shouldHydrate ? bootstrapModule : undefined` (HandleRender.ts:663), so removing the
 *   renderer's own `shouldHydrate &&` check changes nothing observable over HTTP - verified: that
 *   tamper reaches `dist` and this suite still passes 34/34. That check is defence in depth the
 *   host makes unreachable, and it is covered by a unit test in `@taujs/solid` that passes
 *   `bootstrapModules` explicitly under `hydrate:false`. Black-box HTTP cannot separate the two
 *   layers, and it should not be expected to.
 */
const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 5373;
const BASE = `http://127.0.0.1:${PORT}`;

type Mode = 'development' | 'production';

const isPortFree = async (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

let server: ChildProcess | undefined;
let serverOutput = '';

const killTree = (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
};

/** Await exit, then poll until the port is genuinely released. Bounded; no fixed sleeps. */
const stopServer = async (timeoutMs = 20_000) => {
  if (!server) return;
  const child = server;
  server = undefined;

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
  killTree(child);
  await Promise.race([exited, new Promise((r) => setTimeout(r, timeoutMs))]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortFree(PORT)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${PORT} still bound ${timeoutMs}ms after teardown`);
};

const startServer = async (script: 'dev' | 'start') => {
  expect(await isPortFree(PORT), `port ${PORT} is already in use`).toBe(true);

  serverOutput = '';
  const child = spawn('npm', ['run', script], { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  server = child;
  child.stdout?.on('data', (c: Buffer) => (serverOutput += String(c)));
  child.stderr?.on('data', (c: Buffer) => (serverOutput += String(c)));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${serverOutput}`);
    try {
      const probe = await fetch(`${BASE}/`);
      if (probe.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become ready\n${serverOutput}`);
};

const get = async (route: string) => {
  const response = await fetch(`${BASE}${route}`);
  const html = await response.text();

  return { status: response.status, html, csp: response.headers.get('content-security-policy') };
};

const scriptTags = (html: string) => html.match(/<script\b[^>]*>/g) ?? [];
const inlineScripts = (html: string) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1] ?? ''));

/** The app's OWN client entry - never Vite's dev client, which is present in dev regardless. */
const hasAppClientEntry = (html: string) =>
  scriptTags(html).some((tag) => /type="module"/.test(tag) && /entry-client|assets\//.test(tag) && !/@vite\/client/.test(tag));

// `expect` is the route's message and `item` one of its list entries - both come from the SERVICE,
// so they differ per route and pin that the right loader ran for the right cell.
const CELLS = [
  { route: '/', label: 'ssr + hydrate', streaming: false, hydrate: true, expect: 'Hello from τjs', item: 'snapshot data bridge' },
  { route: '/streaming', label: 'streaming + hydrate', streaming: true, hydrate: true, expect: 'Streamed once', item: 'two-latch onAllReady' },
  { route: '/no-hydrate', label: 'ssr + no-hydrate', streaming: false, hydrate: false, expect: 'Hello from τjs', item: 'snapshot data bridge' },
  {
    route: '/streaming-no-hydrate',
    label: 'streaming + no-hydrate',
    streaming: true,
    hydrate: false,
    expect: 'Streamed once',
    item: 'two-latch onAllReady',
  },
] as const;

const runMatrix = (mode: Mode) => {
  describe(`${mode}`, () => {
    beforeAll(async () => {
      if (mode === 'production') {
        // Build through the project's own script - the user-facing path.
        execFileSync('npm', ['run', 'build'], { cwd: PROJECT, stdio: 'pipe' });
      }
      await startServer(mode === 'development' ? 'dev' : 'start');
    });

    afterAll(async () => {
      await stopServer();
    });

    for (const cell of CELLS) {
      describe(cell.label, () => {
        it('serves the rendered Solid app with its route data', async () => {
          const { status, html } = await get(cell.route);

          expect(status, serverOutput).toBe(200);

          // Solid markup actually rendered on the SERVER - not an empty shell the client filled
          // in. Matched by id rather than exact tag text: Solid stamps `data-hk` hydration keys on
          // hydratable elements, so `<p id="message">` is really `<p data-hk="..." id="message">`.
          expect(html).toContain('<h1>τjs + Solid</h1>');
          expect(html).toMatch(new RegExp(`<p[^>]*id="route"[^>]*>${cell.route.replace(/\//g, '\\/')}</p>`));

          // Route data reached the component AND the serialised payload - the snapshot bridge's
          // single authority, on both strategies.
          expect(html).toContain(cell.expect);
          expect(html).toContain('window.__INITIAL_DATA__');
          expect(html).toMatch(/window\.__INITIAL_DATA__ = [^;]*Solid playground/);

          // The store-driven list rendered too, so `useSSRStore().data()` is genuinely read.
          expect(html).toMatch(/<ul[^>]*id="items"/);
          expect(html).toContain(cell.item);
          expect(html).not.toContain('id="empty"');
        });

        it(`${cell.hydrate ? 'emits' : 'omits'} the host client entry`, async () => {
          const { html } = await get(cell.route);

          expect(hasAppClientEntry(html), cell.hydrate ? 'client entry missing' : 'client entry present under hydrate:false').toBe(cell.hydrate);
        });

        it('applies the ruled hydration-machinery policy', async () => {
          const { html } = await get(cell.route);
          const bootstrapCount = (html.match(/window\._\$HY\|\|/g) ?? []).length;

          if (cell.streaming) {
            // Cells 3 and 4: BOTH streaming cells retain the bootstrap and the patch machinery,
            // even under hydrate:false, because the deferred `$df` patches require `_$HY`.
            //
            // The patch machinery is only present because the app owns a `createResource`. Route
            // data alone would emit none: under the snapshot bridge it travels in
            // `__INITIAL_DATA__` and is never streamed (design 3). That is exactly why the
            // playground has an app-owned resource - without it these assertions would be vacuous.
            expect(bootstrapCount, 'streaming must carry exactly one bootstrap').toBe(1);
            expect(html, 'no deferred patch machinery - the app-owned resource did not stream').toMatch(/\$R|_\$HY\.r/);
            expect(html).toContain('app-owned resource resolved');
          } else if (cell.hydrate) {
            // Cell 1: exactly one bootstrap, through headContent.
            expect(bootstrapCount).toBe(1);
          } else {
            // Cell 2: `noScripts` - static markup, no Solid machinery at all. The host's
            // `__INITIAL_DATA__` script legitimately remains; it is the data authority, unrelated
            // to hydration policy.
            expect(bootstrapCount).toBe(0);
            expect(html).not.toContain('_$HY');
            expect(html).not.toContain('$df');
            expect(html).not.toMatch(/\$R\b/);
          }
        });

        it('propagates the nonce to every inline script when CSP is active', async () => {
          const { html, csp } = await get(cell.route);
          const inline = inlineScripts(html);

          if (!csp) {
            // Observed behaviour, recorded rather than assumed: this app declares no
            // `security.csp`, so PRODUCTION sends no CSP header - while the host still stamps a
            // nonce attribute on its inline scripts. A nonce without a header is inert rather than
            // wrong, and it is host behaviour, not the Solid renderer's. What must hold is that
            // development, which DOES send a header, is never silently dropped to this state.
            expect(mode, 'development sent no CSP header - the nonce contract would be unenforced').toBe('production');

            return;
          }

          const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
          expect(nonce, `CSP header present but no nonce in it: ${csp}`).toBeTruthy();

          // EVERY inline script must carry the header's nonce - one unnonced inline script is a
          // blocked script in an enforcing browser.
          expect(inline.length).toBeGreaterThan(0);
          for (const [, attrs] of inline) {
            expect(attrs, `inline script without the CSP nonce: ${attrs}`).toContain(`nonce="${nonce}"`);
          }
        });
      });
    }

    it('no application hydration can run under hydrate:false, so no beacon can fire', async () => {
      // The beacon fires only when application hydration actually runs, and hydration cannot run
      // without the app's client entry.
      //
      // NB the document is NOT free of the string `hydration:start` in development: the HOST
      // injects a dev introspection script that DEFINES `__TAUJS_DEVTOOLS_HOOK__.emit` and
      // switches on those event names. That script is present regardless of hydration policy and
      // is not the renderer claiming hydration ran - grepping for the string would assert the
      // wrong thing. What actually matters, and what is asserted, is that nothing can ever CALL
      // the hook, because the app entry is absent.
      for (const cell of CELLS.filter((c) => !c.hydrate)) {
        const { html } = await get(cell.route);
        expect(hasAppClientEntry(html), `${cell.route} emitted an app client entry under hydrate:false`).toBe(false);
        expect(html).not.toContain('/entry-client');
      }
    });
  });
};

describe('slice 7 group B - Solid dev + production matrix (black box over HTTP)', () => {
  afterAll(async () => {
    await stopServer();
  });

  runMatrix('development');
  runMatrix('production');
});
