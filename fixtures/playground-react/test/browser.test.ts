// @vitest-environment node
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * RFC 0007: the @taujs/react PRODUCT cell for deferred route data.
 *
 * One compact real-browser acceptance, deliberately not a port of the disposable proof matrix: a
 * production build served by a real τjs server under an ENFORCED Content-Security-Policy, driven
 * in Chromium. It proves by EXECUTION what markup inspection cannot - successful deferred
 * delivery, hydration seeded from the private envelope, no refetch, the carrier deleted, and no
 * CSP violation anywhere in the flow.
 *
 * Pinned tuple: playwright-core 1.44.1 <-> chromium-1117 (125.x).
 */
const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 5301;
const BASE = `http://127.0.0.1:${PORT}`;
const BROWSERS_PATH = path.join(homedir(), '.cache', 'ms-playwright');
// The real-browser leg needs the pinned chromium-1117 (playwright-core 1.44.1). It runs locally,
// where that browser is installed; CI installs no Playwright browser, so the suite SKIPS VISIBLY
// there rather than hard-failing.
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

/**
 * Poll the DOM without `page.waitForFunction`: the enforced CSP has no `'unsafe-eval'`, and
 * `waitForFunction` falls back to string evaluation, which the policy blocks. The fix is a wait
 * that needs no eval rather than a weaker policy.
 */
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

type PageFaults = { pageErrors: string[]; cspViolations: string[]; consoleErrors: string[] };

const openPage = async (): Promise<{ page: Page; faults: PageFaults }> => {
  const context = await browser!.newContext();
  const page = await context.newPage();
  const faults: PageFaults = { pageErrors: [], cspViolations: [], consoleErrors: [] };

  page.on('pageerror', (e) => faults.pageErrors.push(String(e.message ?? e)));
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') faults.consoleErrors.push(m.text());
  });
  // The CSP is ENFORCED, so a violation is a real block, not a report. Captured in-page because
  // `securitypolicyviolation` is a DOM event, not a CDP one.
  await page.addInitScript(() => {
    (window as unknown as { __CSP_VIOLATIONS__: string[] }).__CSP_VIOLATIONS__ = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      const ev = e as SecurityPolicyViolationEvent;
      (window as unknown as { __CSP_VIOLATIONS__: string[] }).__CSP_VIOLATIONS__.push(`${ev.violatedDirective} blocked ${ev.blockedURI || '(inline)'}`);
    });
  });

  return { page, faults };
};

const collectFaults = async (page: Page, faults: PageFaults): Promise<PageFaults> => {
  faults.cspViolations = await page.evaluate(() => (window as unknown as { __CSP_VIOLATIONS__?: string[] }).__CSP_VIOLATIONS__ ?? []);

  return faults;
};

const expectClean = (faults: PageFaults) => {
  expect(faults.cspViolations, 'CSP violations').toEqual([]);
  expect(faults.pageErrors, 'uncaught page errors').toEqual([]);
  expect(faults.consoleErrors, 'console errors').toEqual([]);
};

describe.skipIf(!HAS_PINNED_BROWSER)('RFC 0007 product cell - React deferred route data (production build, enforced CSP)', () => {
  beforeAll(async () => {
    // Freshness guard (docs/followups/fixture-stale-dist-evidence-trap.md): this fixture resolves
    // @taujs/server and @taujs/react through their gitignored dist, so a stale package build
    // silently falsifies everything proved here. Rebuild both before the fixture build.
    execFileSync('pnpm', ['--filter', '@taujs/server', '--filter', '@taujs/react', 'build'], { cwd: path.join(PROJECT, '..', '..'), stdio: 'pipe' });
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

  it('delivers a declared deferred entry in the browser, hydrates from the envelope and never refetches', async () => {
    // The policy must actually be enforced, or every violation assertion below is vacuous.
    const response = await fetch(`${BASE}/deferred`);
    const enforced = response.headers.get('content-security-policy');
    expect(enforced, 'no enforced CSP header').toBeTruthy();
    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
    expect(enforced).toMatch(/script-src[^;]*'nonce-/);
    expect(enforced, "'unsafe-inline' would make the nonce contract meaningless").not.toMatch(/script-src[^;]*'unsafe-inline'/);

    const { page, faults } = await openPage();
    const dataRequests: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'fetch' || r.resourceType() === 'xhr') dataRequests.push(r.url());
    });
    try {
      await page.goto(`${BASE}/deferred`, { waitUntil: 'networkidle' });

      // Delivery: the value React patched in after the shell, still present after hydration.
      await waitForText(page, '#reviews', 'reviews: 3');
      expect(await page.textContent('#reviews')).toContain('a genuinely deferred review');
      expect(await page.$('#reviews-pending')).toBeNull();

      // Hydration seeded the boundary from the private end-of-stream envelope: no client fetch, and
      // the carrier is read once and deleted, so it must be gone by the time we look.
      expect(dataRequests, 'hydration issued a data request - the envelope must make that unnecessary').toEqual([]);
      expect(await page.evaluate(() => '__TAUJS_DEFERRED_STATE__' in window)).toBe(false);

      // Interactivity proves the root really hydrated with the deferred boundary in the tree.
      await page.click('#counter');
      await waitForText(page, '#counter', 'count: 1');

      expectClean(await collectFaults(page, faults));
    } finally {
      await page.context().close();
    }
  });
});
