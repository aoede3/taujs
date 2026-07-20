// @vitest-environment node
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Slice-7 group C: the real-browser acceptance leg (design 7.3).
 *
 * Everything here is proved by EXECUTION in Chromium against a production build served by a real
 * τjs server under an ENFORCED Content-Security-Policy header - not by inspecting emitted markup.
 * Markup evidence is group B's job; this suite exists because a document can look perfect and
 * still fail to hydrate, be blocked by CSP, or deliver a broken payload.
 *
 * Pinned tuple: playwright-core 1.44.1 <-> chromium-1117 (125.x), the pairing the design names.
 */
const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 5373;
const BASE = `http://127.0.0.1:${PORT}`;
const BROWSERS_PATH = path.join(homedir(), '.cache', 'ms-playwright');

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
 * Poll the DOM without `page.waitForFunction`.
 *
 * The enforced CSP has no `'unsafe-eval'`, and `waitForFunction` falls back to string evaluation
 * when the page has not yet received Playwright's injected utility script - which is exactly the
 * state the pre-hydration test creates by holding the module script. The browser then BLOCKS the
 * wait itself. That block is the CSP doing its job, so the fix is a wait that needs no eval rather
 * than a weaker policy.
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

/** Everything a page did wrong, collected for assertion. */
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
      (window as unknown as { __CSP_VIOLATIONS__: string[] }).__CSP_VIOLATIONS__.push(
        `${ev.violatedDirective} blocked ${ev.blockedURI || '(inline)'}`,
      );
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

/**
 * For the deliberately-failing route. A page whose whole purpose is an application error cannot be
 * asserted free of errors - Solid's client ErrorBoundary renders the failure AND the rejected
 * resource promise also surfaces globally, which is Solid's behaviour and not a τjs defect.
 *
 * What MUST hold is that every surfaced error is already sanitised: no message, stack, cause or
 * custom property from the server reaches the client through the ERROR channel either. Asserting
 * "no page errors" here would have been the wrong shape of check; asserting "no secret in any
 * page error" is the security property that actually matters.
 */
const expectNoSecretsInFaults = (faults: PageFaults, secrets: string[]) => {
  expect(faults.cspViolations, 'CSP violations').toEqual([]);

  const surfaced = [...faults.pageErrors, ...faults.consoleErrors];
  for (const secret of secrets) {
    for (const text of surfaced) {
      expect(text, `a server secret reached the browser through an error: ${text}`).not.toContain(secret);
    }
  }
  // ...and every surfaced error carries the FIXED redacted identity rather than anything else.
  for (const text of faults.pageErrors) expect(text).toContain('[redacted]');
};

describe('slice 7 group C - real browser (production build, enforced CSP)', () => {
  beforeAll(async () => {
    if (!existsSync(path.join(BROWSERS_PATH, 'chromium-1117'))) {
      throw new Error(`chromium-1117 not found under ${BROWSERS_PATH} - the pinned browser is required for the D2 acceptance leg`);
    }
    execFileSync('npm', ['run', 'build'], { cwd: PROJECT, stdio: 'pipe' });

    expect(await isPortFree(PORT), `port ${PORT} in use`).toBe(true);
    serverOutput = '';
    const child = spawn('npm', ['run', 'start'], { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

  it('serves an ENFORCED CSP header (not report-only, no unsafe-inline for scripts)', async () => {
    const response = await fetch(`${BASE}/`);
    const enforced = response.headers.get('content-security-policy');

    expect(enforced, 'no enforced CSP header - every violation assertion below would be vacuous').toBeTruthy();
    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
    expect(enforced).toMatch(/script-src[^;]*'nonce-/);
    expect(enforced, "'unsafe-inline' would make the nonce contract meaningless").not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('hydrates: a click changes state that the server could not have rendered', async () => {
    const { page, faults } = await openPage();
    try {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

      // Server-rendered state. Proving hydration means proving this CHANGES on interaction.
      expect(await page.textContent('#counter')).toContain('count: 0');

      await page.click('#counter');
      await waitForText(page, '#counter', 'count: 1');

      expect(await page.textContent('#counter')).toContain('count: 1');
      expectClean(await collectFaults(page, faults));
    } finally {
      await page.context().close();
    }
  });

  it('CAPTURES a pre-hydration click into Solid\'s event queue', async () => {
    const { page, faults } = await openPage();
    try {
      // Deterministic delay: hold the client entry until the click has landed. Nothing about the
      // app changes - the delay lives entirely in the network layer, so this measures the real
      // capture path rather than a rearranged app.
      let releaseEntry: (() => void) | undefined;
      const entryHeld = new Promise<void>((resolve) => (releaseEntry = resolve));
      await page.route('**/assets/*.js', async (route) => {
        await entryHeld;
        await route.continue();
      });

      // `commit` rather than `domcontentloaded`: DOMContentLoaded WAITS for deferred module
      // scripts, and this test is deliberately holding one, so `goto` would never resolve.
      await page.goto(`${BASE}/`, { waitUntil: 'commit' });
      await page.waitForSelector('#counter');

      // The markup is present and the bootstrap has run, but the app is NOT interactive yet.
      expect(await page.textContent('#counter')).toContain('count: 0');
      await page.click('#counter');
      expect(await page.textContent('#counter'), 'the app was interactive before its entry loaded').toContain('count: 0');

      // The bootstrap's document-level listener queued the click, and the target carries the
      // hydration key the replay path keys off.
      const captured = await page.evaluate(() => ({
        queued: (window as unknown as { _$HY?: { events?: unknown[] } })._$HY?.events?.length ?? 0,
        targetHasKey: document.querySelector('#counter')?.hasAttribute('data-hk') ?? false,
      }));
      expect(captured.queued, 'the pre-hydration click was not captured at all').toBe(1);
      expect(captured.targetHasKey).toBe(true);

      releaseEntry!();
      await waitForText(page, '#deferred', 'app-owned resource resolved');
      expectClean(await collectFaults(page, faults));
    } finally {
      await page.context().close();
    }
  });

  /**
   * UPSTREAM LIMITATION at solid-js 1.9.14 - established by a vanilla control, not by inference.
   *
   * Capture works (asserted above) and hydration works (asserted before it), but the queued event
   * is never REPLAYED. Two earlier diagnoses of mine were wrong and are corrected here:
   *
   *   1. "runHydrationEvents is never called, so the framework must call it." FALSE. The Solid
   *      COMPILER injects `_$runHydrationEvents()` directly into any component with an event
   *      handler, immediately after `_$getNextElement` adopts the node and `$$click` is attached.
   *      I had only read the solid-js RUNTIME, never the compiled component output. A call added
   *      to `hydrateApp` on that basis was unjustified and has been REVERTED.
   *   2. "The node must have been replaced during hydration." FALSE. Retaining the original button
   *      across the delayed entry shows `sameNode: true`, `isConnected: true` and an unchanged
   *      `data-hk` - the server node is adopted, not replaced.
   *
   * The decisive evidence is a MINIMAL NON-τjs CONTROL: plain `vite-plugin-solid({ ssr: true })`,
   * plain `generateHydrationScript()`, plain `hydrate()`, the same delayed-entry sequence, and no
   * τjs in the graph at all. It behaves identically - `queued pre-hydration: 1`, after hydration
   * `count: 0`, fresh click `count: 1`. So replay is not a τjs integration defect. The control
   * script is retained at `docs/solid/vanilla-replay-control.mjs`.
   *
   * Skipped rather than deleted or asserted-as-correct, so the gap stays visible: if a Solid
   * upgrade closes it, un-skipping is the check.
   */
  it.skip('replays the captured click once hydration runs (UPSTREAM - see above)', async () => {
    const { page } = await openPage();
    try {
      let releaseEntry: (() => void) | undefined;
      const entryHeld = new Promise<void>((resolve) => (releaseEntry = resolve));
      await page.route('**/assets/*.js', async (route) => {
        await entryHeld;
        await route.continue();
      });

      await page.goto(`${BASE}/`, { waitUntil: 'commit' });
      await page.waitForSelector('#counter');
      await page.click('#counter');
      releaseEntry!();

      await waitForText(page, '#counter', 'count: 1');
    } finally {
      await page.context().close();
    }
  });

  it('under hydrate:false nothing hydrates, no beacon fires and no click is replayed', async () => {
    const { page, faults } = await openPage();
    try {
      await page.goto(`${BASE}/no-hydrate`, { waitUntil: 'networkidle' });

      expect(await page.textContent('#counter')).toContain('count: 0');
      await page.click('#counter');
      await page.waitForTimeout(750); // generous: a hydration that was going to happen would have

      // Still inert - the click neither took effect nor was queued for replay.
      expect(await page.textContent('#counter'), 'the page became interactive under hydrate:false').toContain('count: 0');

      const state = await page.evaluate(() => ({
        hydrationRuntime: typeof (window as unknown as { _$HY?: unknown })._$HY,
        beaconHook: typeof (window as unknown as { __TAUJS_DEVTOOLS_HOOK__?: unknown }).__TAUJS_DEVTOOLS_HOOK__,
        moduleScripts: [...document.querySelectorAll('script[type="module"]')].map((s) => s.getAttribute('src') ?? '(inline)'),
      }));

      // Cell 2: `noScripts` - no Solid runtime at all, so nothing could hydrate even in principle.
      expect(state.hydrationRuntime).toBe('undefined');
      // No beacon can fire because nothing defines or calls the hook in production.
      expect(state.beaconHook).toBe('undefined');
      expect(state.moduleScripts, 'a client entry was delivered under hydrate:false').toEqual([]);

      expectClean(await collectFaults(page, faults));
    } finally {
      await page.context().close();
    }
  });

  it('delivers the SANITISED rejection to the client, executed - no server detail crosses', async () => {
    const { page, faults } = await openPage();
    try {
      await page.goto(`${BASE}/reject`, { waitUntil: 'networkidle' });

      // The client ErrorBoundary receives a real Error, so the payload EXECUTED and settled -
      // not a broken `$R` slot leaving the boundary pending forever (the withdrawn C2 failure).
      await page.waitForSelector('#boundary', { timeout: 15_000 });
      const boundaryText = (await page.textContent('#boundary')) ?? '';

      expect(boundaryText).toContain('Error');
      expect(boundaryText).toContain('[redacted]');

      // Nothing from the server-side error crossed the boundary, in the DOM or anywhere on window.
      const html = await page.content();
      expect(html).not.toContain('PLAYGROUND-SECRET');
      expect(html).not.toContain('hunter2');
      expect(html).not.toContain('10.0.0.5');
      expect(boundaryText).not.toMatch(/\bat\b.*\.js:/); // no stack frames

      // Solid surfaces the rejected resource globally as well as into the boundary. That is Solid
      // behaviour, so the assertion is that nothing secret rides along - not that no error occurs.
      await expectNoSecretsInFaults(await collectFaults(page, faults), ['PLAYGROUND-SECRET', 'hunter2', '10.0.0.5']);
    } finally {
      await page.context().close();
    }
  });

  it('__proto__ arrives as an OWN property with the global prototype untouched (ESC-3)', async () => {
    const { page, faults } = await openPage();
    try {
      await page.goto(`${BASE}/proto`, { waitUntil: 'networkidle' });

      const result = await page.evaluate(() => {
        const data = (window as unknown as { __INITIAL_DATA__: Record<string, unknown> }).__INITIAL_DATA__;

        return {
          isOwnProperty: Object.prototype.hasOwnProperty.call(data, '__proto__'),
          prototypeIsObject: Object.getPrototypeOf(data) === Object.prototype,
          value: JSON.stringify((data as Record<string, unknown>)['__proto__']),
          globalPolluted: (Object.prototype as unknown as { polluted?: unknown }).polluted !== undefined,
          ownKeys: Object.keys(data),
        };
      });

      expect(result.isOwnProperty, '__proto__ landed on the prototype instead of round-tripping').toBe(true);
      expect(result.prototypeIsObject).toBe(true);
      expect(result.value).toContain('polluted');
      expect(result.globalPolluted, 'Object.prototype was polluted').toBe(false);
      expect(result.ownKeys).toContain('__proto__');

      expectClean(await collectFaults(page, faults));
    } finally {
      await page.context().close();
    }
  });

  it('the streaming route completes its deferred patch in the browser', async () => {
    const { page, faults } = await openPage();
    try {
      await page.goto(`${BASE}/streaming`, { waitUntil: 'networkidle' });

      // The `$df` patch replaced the placeholder with the resolved fragment - i.e. the streamed
      // payload executed, rather than merely being present in the bytes.
      await page.waitForSelector('#deferred', { timeout: 15_000 });
      expect(await page.textContent('#deferred')).toContain('app-owned resource resolved');
      expect(await page.$('#deferred-pending')).toBeNull();

      expectClean(await collectFaults(page, faults));
    } finally {
      await page.context().close();
    }
  });
});
