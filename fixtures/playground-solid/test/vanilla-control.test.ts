// @vitest-environment node
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { build, createServer as createViteServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The vanilla-Solid REPLAY CONTROL, tracked and run in CI (design 7.3, group C).
 *
 * This is the decisive experiment behind recording the pre-hydration replay gap as an UPSTREAM
 * limitation rather than a τjs defect. It stands up a minimal Solid app with NO τjs in the graph
 * at all - plain `vite-plugin-solid({ ssr: true })`, plain `generateHydrationScript()`, plain
 * `hydrate()` - and drives it through the identical delayed-entry sequence the playground uses.
 *
 * Why it lives here as a real test rather than as a throwaway script under the local docs area:
 * an attribution that survives only as prose is not evidence. Retained and executed, it also
 * becomes a TRIPWIRE. `replays a pre-hydration click` is marked `it.fails`: it asserts the desired
 * behaviour (the queued click replays after `hydrate()`), which solid-js 1.9.14 does NOT do, so it
 * fails-as-expected and stays green today. The day a Solid upgrade makes replay work, that test
 * passes unexpectedly and vitest turns it RED - the signal to delete the `.fails`, re-enable the
 * skipped replay assertion in `browser.test.ts`, and drop the upstream caveat.
 *
 * The `.fails` test alone could be masked by a harness or hydration flake (any throw reads as the
 * expected failure). The sibling `captures ... and hydrates` test is the guard: it asserts, as an
 * ordinary green test in the SAME served app, that capture and hydration both work. A real
 * breakage turns THAT red, so the pair cannot silently rot.
 */
const CONTROL_ROOT = fileURLToPath(new URL('./vanilla-control', import.meta.url));
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), '.cache', 'ms-playwright');
const PORT = 5399;
const BASE = `http://127.0.0.1:${PORT}`;

let browser: Browser | undefined;
let httpServer: ReturnType<typeof createServer> | undefined;
let outDir: string | undefined;
let servedHtml = '';
let entryCode = '';

const openPage = async (): Promise<Page> => {
  const context = await browser!.newContext();

  return context.newPage();
};

/** Poll (no `waitForFunction`, to keep parity with the CSP-constrained playground suite) until the
 *  entry sets `__controlHydrated`. Vanilla Solid leaves its `_$HY` queue populated after hydration,
 *  so unlike the playground there is no non-mutating internal state to watch; the entry flag is the
 *  signal, set on the line after `hydrate()` where the replay decision is already final. */
const waitHydrated = async (page: Page, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => (window as unknown as { __controlHydrated?: boolean }).__controlHydrated === true)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the vanilla control never signalled hydration within ${timeoutMs}ms`);
};

const waitForText = async (page: Page, selector: string, needle: string, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await page.textContent(selector).catch(() => '')) ?? '';
    if (last.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`"${needle}" never appeared in ${selector} within ${timeoutMs}ms (last: "${last}")`);
};

/** Hold the client entry, load the shell, land a click while the app is still inert, then release.
 *  Returns once the entry is released and the control has signalled that hydration has run. */
const runDelayedEntry = async (page: Page): Promise<{ queued: number }> => {
  let releaseEntry: (() => void) | undefined;
  const entryHeld = new Promise<void>((resolve) => (releaseEntry = resolve));
  await page.route('**/entry.js', async (route) => {
    await entryHeld;
    await route.continue();
  });

  // `commit`, not `domcontentloaded`: DOMContentLoaded waits for the deferred module script we are
  // deliberately holding, so `goto` would never resolve.
  await page.goto(`${BASE}/`, { waitUntil: 'commit' });
  await page.waitForSelector('#counter');
  expect((await page.textContent('#counter'))?.trim()).toBe('count: 0');

  await page.click('#counter');
  const queued = await page.evaluate(() => (window as unknown as { _$HY?: { events?: unknown[] } })._$HY?.events?.length ?? 0);

  releaseEntry!();
  await waitHydrated(page);

  return { queued };
};

describe('vanilla Solid replay control (no τjs) - the upstream tripwire', () => {
  beforeAll(async () => {
    if (!existsSync(path.join(BROWSERS_PATH, 'chromium-1117'))) {
      throw new Error(`chromium-1117 not found under ${BROWSERS_PATH} - the pinned browser is required for the replay control`);
    }

    // 1. Build the CLIENT bundle with the control's own `ssr: true` compiler config. Self-contained
    //    (dependencies bundled), so it can be served as a bare module with no node_modules present.
    outDir = mkdtempSync(path.join(tmpdir(), 'solid-vanilla-control-'));
    await build({
      configFile: path.join(CONTROL_ROOT, 'vite.config.ts'),
      root: CONTROL_ROOT,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(CONTROL_ROOT, 'entry-client.tsx') } },
    });
    const assetsDir = path.join(outDir, 'assets');
    const entryName = readdirSync(assetsDir).find((f) => f.endsWith('.js'));
    if (!entryName) throw new Error(`no built entry chunk under ${assetsDir}`);
    entryCode = readFileSync(path.join(assetsDir, entryName), 'utf8');

    // 2. Render the SSR markup + bootstrap through the SAME plugin/transform (a middleware-mode
    //    Vite SSR server), exactly as a real Solid SSR host would.
    const vite = await createViteServer({
      configFile: path.join(CONTROL_ROOT, 'vite.config.ts'),
      root: CONTROL_ROOT,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true },
    });
    try {
      const { renderToString, generateHydrationScript, createComponent } = (await vite.ssrLoadModule('solid-js/web')) as {
        renderToString: (fn: () => unknown, options?: { renderId?: string }) => string;
        generateHydrationScript: () => string;
        createComponent: (comp: (props: object) => unknown, props: object) => unknown;
      };
      const { Counter } = (await vite.ssrLoadModule('/Counter.tsx')) as { Counter: (props: object) => unknown };
      // Render symmetrically with the client. The client's `hydrate(() => <Counter/>, ...)` compiles
      // to `createComponent(Counter, {})`, which adds one component-level hydration key; a direct
      // `Counter()` here would omit that level and desynchronise the key namespace (server `vc0` vs
      // client `vc00`). `renderId` is pinned to the client's value so the two sides also agree on the
      // key prefix regardless of Solid's environment-dependent default (see entry-client.tsx).
      const appHtml = renderToString(() => createComponent(Counter, {}), { renderId: 'vc' });
      const head = generateHydrationScript();
      servedHtml = `<!doctype html><html><head>${head}</head><body><div id="root">${appHtml}</div><script type="module" src="/entry.js"></script></body></html>`;
    } finally {
      await vite.close();
    }

    // 3. Serve the shell + the built entry over a plain HTTP server - no τjs anywhere.
    httpServer = createServer((req, res) => {
      if (req.url === '/entry.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(entryCode);

        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(servedHtml);
    });
    await new Promise<void>((resolve) => httpServer!.listen(PORT, '127.0.0.1', resolve));

    browser = await chromium.launch({ args: ['--no-sandbox'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    browser = undefined;
    await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
    httpServer = undefined;
    if (outDir) rmSync(outDir, { recursive: true, force: true });
    outDir = undefined;
  });

  it('captures a pre-hydration click and hydrates (the harness is sound)', async () => {
    const page = await openPage();
    try {
      const { queued } = await runDelayedEntry(page);

      // Capture works with NO τjs: the bootstrap's document-level listener queued the click.
      expect(queued, 'the pre-hydration click was not captured even in vanilla Solid').toBe(1);

      // Hydration works: a FRESH click is handled and moves the counter.
      await page.click('#counter');
      await waitForText(page, '#counter', 'count: 1');
    } finally {
      await page.context().close();
    }
  });

  // EXPECTED FAILURE. Asserts the DESIRED behaviour - the queued click replays after `hydrate()`,
  // so the counter reads `count: 1` with no fresh click. solid-js 1.9.14 does not replay it, so
  // this throws and `it.fails` keeps it green. When an upgrade fixes replay it passes, vitest
  // flags the unexpected pass RED, and that is the trigger to remove `.fails` and re-enable the
  // skipped `replays the captured click` assertion in browser.test.ts.
  it.fails('replays a pre-hydration click once hydration runs [expected-fail: upstream gap at solid-js 1.9.14]', async () => {
    const page = await openPage();
    try {
      await runDelayedEntry(page);

      // Read once hydration has signalled: the replay outcome is final at that point. Today this is
      // `count: 0` (no replay), so the assertion below throws - the expected failure.
      expect((await page.textContent('#counter'))?.trim()).toBe('count: 1');
    } finally {
      await page.context().close();
    }
  });
});
