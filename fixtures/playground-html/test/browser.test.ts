// @vitest-environment node
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertWorkspacePackagesBuilt } from '../../test-support/BuiltPackages';

/**
 * The `@taujs/html` real-browser product cell for deferred route data: a production build served
 * by a real τjs server, driven in Chromium. It proves by EXECUTION what `test/routes.test.ts`'s
 * markup inspection cannot - the client's progressive enhancement actually running: the fast
 * deferred entry's value lands in the DOM, the never-resolving entry shows `aborted`, and the
 * private carrier is gone once `onDataReady` has read it.
 *
 * Modelled on `fixtures/playground-vue/test/browser.test.ts`. Pinned tuple: playwright-core
 * 1.44.1 <-> chromium-1117 (125.x).
 */
const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 5312;
const BASE = `http://127.0.0.1:${PORT}`;
const BROWSERS_PATH = path.join(homedir(), '.cache', 'ms-playwright');
// CI installs no Playwright browser, so this suite SKIPS VISIBLY there rather than hard-failing; a
// skip is not product evidence (see the implementation contract's handback requirement).
const HAS_PINNED_BROWSER = existsSync(path.join(BROWSERS_PATH, 'chromium-1117'));
if (!HAS_PINNED_BROWSER)
  console.warn(`[browser.test] chromium-1117 not under ${BROWSERS_PATH} - skipping the real-browser deferred cell (install the pinned browser to run it)`);

let browser: Browser | undefined;
let server: ChildProcess | undefined;
let serverOutput = '';

const isPortFree = async (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

const stopServer = async (timeoutMs = 20_000) => {
  if (!server) return;
  const child = server;
  server = undefined;

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
    if (await isPortFree(PORT)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${PORT} still bound after teardown`);
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

describe.skipIf(!HAS_PINNED_BROWSER)('@taujs/html real-browser product cell - deferred route data (production build)', () => {
  beforeAll(async () => {
    assertWorkspacePackagesBuilt(['server', 'html']);
    execFileSync('npm', ['run', 'build'], { cwd: PROJECT, stdio: 'pipe', env: { ...process.env, TAUJS_PORT: String(PORT) } });

    expect(await isPortFree(PORT), `port ${PORT} in use`).toBe(true);
    serverOutput = '';
    const child = spawn('npm', ['run', 'start'], {
      cwd: PROJECT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, TAUJS_PORT: String(PORT) },
    });
    server = child;
    child.stdout?.on('data', (c: Buffer) => (serverOutput += String(c)));
    child.stderr?.on('data', (c: Buffer) => (serverOutput += String(c)));

    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`server not ready\n${serverOutput}`);
      if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})\n${serverOutput}`);
      try {
        if ((await fetch(`${BASE}/`)).status < 500) break;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    browser = await chromium.launch({ args: ['--no-sandbox'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    browser = undefined;
    await stopServer();
  });

  it('delivers the fast deferred entry, shows the never-resolving one as aborted, and deletes the carrier once read', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e)));

    try {
      await page.goto(`${BASE}/deferred`, { waitUntil: 'networkidle' });

      await waitForText(page, '#reviews', 'a genuinely deferred review');
      await waitForText(page, '#neverResolves', 'aborted');

      expect(await page.evaluate(() => '__TAUJS_DEFERRED_STATE__' in window)).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { __INITIAL_DATA__?: unknown }).__INITIAL_DATA__ !== undefined)).toBe(true);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('on the SSR route (/) the enhancement runs with deferred undefined and no page errors', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e)));

    try {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await waitForText(page, '#message', 'Hello from τjs');

      expect(await page.$('#reviews')).toBeNull();
      expect(await page.evaluate(() => '__TAUJS_DEFERRED_STATE__' in window)).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
