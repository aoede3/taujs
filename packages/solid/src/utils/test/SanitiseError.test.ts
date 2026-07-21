// @vitest-environment node
import { PassThrough } from 'node:stream';
import { runInNewContext, createContext, runInContext } from 'node:vm';
import { createComponent, createResource, Suspense } from 'solid-js';
import { generateHydrationScript, renderToStream, renderToStringAsync, ssr } from 'solid-js/web';
import { describe, it, expect } from 'vitest';

import { createRenderer } from '../../SSRRender.js';
import { REDACTED_MESSAGE, REDACTED_NAME, SanitisedErrorPlugin } from '../SanitiseError.js';

import type { JSX } from 'solid-js';

type Data = Record<string, unknown>;

const html = (markup: string): JSX.Element => ssr(markup) as never;
const laterReject = (reason: unknown, ms = 10) => new Promise<never>((_, j) => setTimeout(() => j(reason), ms));
const later = <T>(value: T, ms = 10) => new Promise<T>((r) => setTimeout(() => r(value), ms));

const appRejectingWith = (reason: unknown): JSX.Element =>
  [
    html('<div id="shell">shell</div>'),
    createComponent(Suspense, {
      fallback: html('<p>f</p>'),
      get children() {
        const [d] = createResource(() => laterReject(reason));
        return html(`<p>${String(d() ?? '')}</p>`);
      },
    }),
  ] as never;

/** Render a streaming response through the REAL renderer and return head + body. */
async function renderStreaming(app: () => JSX.Element) {
  const sink = new PassThrough();
  const chunks: string[] = [];
  sink.on('data', (c: Buffer) => chunks.push(String(c)));
  sink.on('error', () => {});

  let head = '';
  const { renderStream } = createRenderer({ appComponent: app, headContent: () => '' });
  const handle = renderStream(sink, { onHead: (h: string) => (head = h) }, { a: 1 }, '/', undefined, {}, undefined, { shouldHydrate: true });

  const outcome = await handle.done.then(
    () => ({ settled: 'resolved' as const }),
    (e: unknown) => ({ settled: 'rejected' as const, error: e }),
  );

  return { head, body: chunks.join(''), outcome };
}

const scriptBodies = (markup: string) => [...markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');

/**
 * EXECUTE the emitted payload the way a browser would, and observe what the client actually
 * receives. This is the acceptance bar the withdrawn S0-C2 candidate failed: it produced
 * `secret=0` by DESTROYING the payload - emitting calls to `$R` slots that were never assigned -
 * so "the secret is gone" is not evidence of a working response.
 */
async function executePayload(head: string, body: string) {
  /**
   * A minimal DOM good enough for Solid's `$df` patch function, which is what actually replaces
   * the placeholder with the resolved fragment:
   *
   *   function $df(e,n,o,t){ if(n=document.getElementById(e), o=document.getElementById("pl-"+e)){
   *     for(;o&&8!==o.nodeType&&o.nodeValue!=="pl-"+e;) t=o.nextSibling,o.remove(),o=t;
   *     _$HY.done?o.remove():o.replaceWith(n.content) } n.remove(),_$HY.fe(e) }
   *
   * `n.remove()` runs UNCONDITIONALLY, so a `getElementById` returning null throws before the
   * settle call is ever reached - which is exactly what an earlier version of this harness did,
   * making it look as though the payload never settled. Returning shaped elements exercises the
   * real patch path instead of skipping it.
   */
  const makeElement = (id: string) => ({
    id,
    content: {},
    nodeType: id.startsWith('pl-') ? 8 : 1,
    nodeValue: id.startsWith('pl-') ? id : '',
    nextSibling: null,
    remove() {},
    replaceWith() {},
  });

  const context = createContext({
    document: { getElementById: (id: string) => makeElement(id), addEventListener: () => {} },
    WeakSet,
    Promise,
    Error,
    Object,
    setTimeout,
  });
  (context as Record<string, unknown>).self = context;
  (context as Record<string, unknown>).window = context;

  let executionError: string | undefined;
  scriptBodies(head + body).forEach((code, index) => {
    if (executionError) return;
    try {
      runInContext(code, context);
    } catch (e) {
      executionError = `script ${index}: ${(e as Error).message}`;
    }
  });

  const hy = (context as { _$HY?: { r: Record<string, unknown> } })._$HY;
  const settlements: Array<{ key: string; state: 'resolved' | 'rejected'; name?: string; message?: string; value?: unknown }> = [];

  for (const [key, entry] of Object.entries(hy?.r ?? {})) {
    if (entry && typeof (entry as PromiseLike<unknown>).then === 'function') {
      await (entry as Promise<unknown>).then(
        (value) => settlements.push({ key, state: 'resolved', value }),
        (e: unknown) => settlements.push({ key, state: 'rejected', name: (e as Error)?.name, message: (e as Error)?.message }),
      );
    }
  }

  return { executionError, hydrationRuntimeDefined: typeof hy === 'object', settlements };
}

describe('sanitiser - fixed identity (R2)', () => {
  const SECRETS = {
    message: 'SECRET-MESSAGE-db-password-hunter2',
    name: 'SECRET-NAME-user-alice@example.com',
    cause: 'SECRET-CAUSE-connection-string',
    custom: 'SECRET-CUSTOM-internal-detail',
  };

  const hostileError = () => {
    const error = new Error(SECRETS.message, { cause: { detail: SECRETS.cause } });
    error.name = SECRETS.name;

    return Object.assign(error, { internalDetail: SECRETS.custom });
  };

  it('replaces name AND message with the fixed constants, and strips stack, cause and custom properties', async () => {
    const { head, body } = await renderStreaming(() => appRejectingWith(hostileError()));
    const payload = head + body;

    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(payload, `${label} leaked`).not.toContain(secret);
    }
    expect(payload).not.toMatch(/"stack"|stack:/);
    expect(payload).not.toContain('internalDetail');

    // ...and what IS emitted is the fixed envelope
    expect(payload).toContain(`new Error("${REDACTED_MESSAGE}")`);
    expect(payload).toContain(`name:"${REDACTED_NAME}"`);
  });

  it('the ORIGINAL name never survives - it is writable and therefore an unbounded channel', async () => {
    // The V6-checks candidate preserved `name`; that policy is superseded precisely because of
    // this case. A syntactically innocuous name can still encode private data.
    const error = new Error('boom');
    error.name = 'ValidationError(user=alice@example.com tenant=acme)';

    const { head, body } = await renderStreaming(() => appRejectingWith(error));

    expect(head + body).not.toContain('alice@example.com');
    expect(head + body).toContain(`name:"${REDACTED_NAME}"`);
  });

  it('redacts a CROSS-REALM rejection reason and everything its cause retains', async () => {
    // Solid's castError wraps a cross-realm reason as `new Error('Unknown error', { cause })`, so
    // it matches `instanceof Error` here - and stripping `cause` is what prevents the leak.
    const makeCrossRealm = runInNewContext('(m) => new Error(m)') as (m: string) => Error;

    const { head, body } = await renderStreaming(() => appRejectingWith(makeCrossRealm('SECRET-CROSS-REALM')));

    expect(head + body).not.toContain('SECRET-CROSS-REALM');
    expect(head + body).not.toContain('Unknown error');
  });

  it('redacts a NON-Error thrown value through the same castError wrapper', async () => {
    const { head, body } = await renderStreaming(() => appRejectingWith({ code: 'E_X', message: 'SECRET-NON-ERROR' }));

    expect(head + body).not.toContain('SECRET-NON-ERROR');
    expect(head + body).toContain(`new Error("${REDACTED_MESSAGE}")`);
  });

  it('redacts an ordinary RESOLVED Error value identically (it is the same seam)', async () => {
    // The accepted cost of the ruling: this is a successful render, and the value is redacted too,
    // because the sanitiser cannot - and must not try to - tell why the value exists.
    const app = (): JSX.Element =>
      [
        html('<div>shell</div>'),
        createComponent(Suspense, {
          fallback: html('<p>f</p>'),
          get children() {
            const [d] = createResource(() => later({ lastError: new Error('SECRET-ORDINARY-VALUE') }));
            return html(`<p>${String(d() ? 'ok' : '')}</p>`);
          },
        }),
      ] as never;

    const { head, body, outcome } = await renderStreaming(app);

    expect(outcome.settled).toBe('resolved'); // a successful render
    expect(head + body).not.toContain('SECRET-ORDINARY-VALUE');
  });

  it('redacts on the ssr strategy too', async () => {
    const { renderSSR } = createRenderer({ appComponent: () => appRejectingWith(hostileError()), headContent: () => '' });
    const { headContent, appHtml } = await renderSSR({ a: 1 }, '/', {}, undefined, { shouldHydrate: true });

    for (const secret of Object.values(SECRETS)) expect(headContent + appHtml).not.toContain(secret);
    expect(headContent + appHtml).toContain(REDACTED_MESSAGE);
  });
});

describe('sanitiser - the payload stays EXECUTABLE and settles correctly', () => {
  it('runs without error, defines the hydration runtime, and settles the resource as the redacted error', async () => {
    const { head, body, outcome } = await renderStreaming(() => appRejectingWith(new Error('SECRET-EXEC')));

    expect(outcome.settled).toBe('resolved'); // a serialised rejection is degraded COMPLETION

    const executed = await executePayload(head, body);

    expect(executed.executionError).toBeUndefined(); // the patch path runs, it is not skipped
    expect(executed.hydrationRuntimeDefined).toBe(true);
    expect(executed.settlements.length).toBeGreaterThan(0);

    // Every serialised resource settles - and settles REJECTED, carrying the fixed identity, so
    // the client ErrorBoundary receives a real Error rather than a broken or pending slot.
    for (const settlement of executed.settlements) {
      expect(settlement.state).toBe('rejected');
      expect(settlement.name).toBe(REDACTED_NAME);
      expect(settlement.message).toBe(REDACTED_MESSAGE);
    }
  });

  it('emits no dangling $R slot (the failure mode that made "secret=0" meaningless)', async () => {
    const { head, body } = await renderStreaming(() => appRejectingWith(new Error('SECRET-DANGLE')));
    const payload = scriptBodies(head + body).join('\n');

    const assigned = new Set([...payload.matchAll(/\$R\[(\d+)\]\s*=/g)].map((m) => Number(m[1])));
    const read = new Set([
      ...[...payload.matchAll(/\$R\[(\d+)\]\s*\(/g)].map((m) => Number(m[1])),
      ...[...payload.matchAll(/[(,]\s*\$R\[(\d+)\]/g)].map((m) => Number(m[1])),
    ]);

    expect([...read].filter((slot) => !assigned.has(slot))).toEqual([]);
  });
});

describe('sanitiser - a serialised rejection is NEVER conflated with a serialisation FAILURE', () => {
  it('a redacted rejection COMPLETES the response (degraded completion)', async () => {
    const { outcome } = await renderStreaming(() => appRejectingWith(new Error('ordinary')));

    expect(outcome.settled).toBe('resolved');
  });

  it('an actual serialisation failure is FATAL, and the sanitiser does not mask it', async () => {
    // An unserialisable value is not an Error, so the sanitiser never matches it - seroval's
    // failure channel fires and R3 applies. Installing the sanitiser must not turn a fatal into a
    // silent success.
    const app = (): JSX.Element =>
      [
        html('<div>shell</div>'),
        createComponent(Suspense, {
          fallback: html('<p>f</p>'),
          get children() {
            const [d] = createResource(() => later({ fn: () => {} }));
            return html(`<p>${String(d() ? 'ok' : '')}</p>`);
          },
        }),
      ] as never;

    const { outcome } = await renderStreaming(app);

    expect(outcome.settled).toBe('rejected');
    expect(String((outcome as { error: unknown }).error)).toMatch(/seroval|serializ/i);
  });
});

describe('sanitiser - REVISE tripwire: the pinned plugin passthrough must remain available', () => {
  /**
   * Design 5: "upstream removal of the undeclared `plugins` passthrough fires REVISE - do not
   * monkey-patch around it." This test IS that tripwire. If Solid stops honouring `plugins`, the
   * sanitiser silently stops running and every disclosure guarantee in this file becomes vacuous,
   * so the failure must be loud and must be attributable to the passthrough specifically rather
   * than looking like an ordinary redaction regression.
   */
  it('Solid honours the `plugins` option on renderToStream', async () => {
    const sink = new PassThrough();
    const chunks: string[] = [];
    sink.on('data', (c: Buffer) => chunks.push(String(c)));
    sink.on('error', () => {});
    const done = new Promise<void>((r) => sink.on('end', () => r()));

    let invoked = 0;
    const probe = {
      ...SanitisedErrorPlugin,
      tag: 'taujs/solid/TripwireProbe',
      test: (value: unknown) => {
        if (value instanceof Error) invoked += 1;

        return value instanceof Error;
      },
    };

    (
      renderToStream(() => appRejectingWith(new Error('tripwire')), { plugins: [probe], onError: () => {} } as never) as never as {
        pipe: (w: unknown) => void;
      }
    ).pipe(sink);
    await done;

    expect(invoked, 'Solid no longer honours the `plugins` passthrough - design 5 says FIRE REVISE, do not monkey-patch').toBeGreaterThan(0);
  });

  it('Solid honours the `plugins` option on renderToStringAsync', async () => {
    let invoked = 0;
    const probe = {
      ...SanitisedErrorPlugin,
      tag: 'taujs/solid/TripwireProbeSSR',
      test: (value: unknown) => {
        if (value instanceof Error) invoked += 1;

        return value instanceof Error;
      },
    };

    await renderToStringAsync(() => appRejectingWith(new Error('tripwire')), { plugins: [probe] } as never);

    expect(invoked, 'Solid no longer honours the `plugins` passthrough on the ssr path - design 5 says FIRE REVISE').toBeGreaterThan(0);
  });

  it("custom plugins are PREPENDED, so the sanitiser pre-empts seroval's built-in Error node", async () => {
    // web/dist/server.js:151 - `[...customPlugins, ...defaultPlugins]`. Being first is what makes
    // the sanitiser authoritative; if that order inverted, the built-in node would win and emit
    // the raw error.
    const { head, body } = await renderStreaming(() => appRejectingWith(new Error('SECRET-ORDERING')));

    expect(head + body).not.toContain('SECRET-ORDERING');
  });
});

describe('sanitiser - no configuration surface (design 5: non-disableable)', () => {
  it('exposes only the fixed constants and the plugin itself', async () => {
    const module = await import('../SanitiseError.js');

    expect(Object.keys(module).sort()).toEqual(['REDACTED_MESSAGE', 'REDACTED_NAME', 'SanitisedErrorPlugin']);
    expect(REDACTED_NAME).toBe('Error');
    expect(REDACTED_MESSAGE).toBe('[redacted]');
  });

  /**
   * A COMPILE-TIME assertion against the real `createRenderer` signature, not a hand-written list.
   * The previous version of this test filtered a manually maintained array of key names, so adding
   * `sanitiser: false` to the actual API would have left it green - it asserted a property of the
   * test file, not of the renderer. These are enforced by `pnpm typecheck` - the package
   * tsconfig includes the whole src tree - so a new option cannot land without failing the build.
   */
  it('exposes EXACTLY the six documented factory options and nothing else', () => {
    type RendererOptions = Parameters<typeof createRenderer>[0];
    type ExpectedKeys = 'appComponent' | 'headContent' | 'renderId' | 'streamOptions' | 'ssrOptions' | 'logger';

    type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
    type AssertTrue<T extends true> = T;

    // Fails to compile if a key is ADDED or REMOVED - exact set equality, both directions.
    type _KeysAreExactlyTheSix = AssertTrue<Equal<keyof RendererOptions, ExpectedKeys>>;

    // Keep the alias referenced so `noUnusedLocals` cannot hide a broken assertion.
    const proof: _KeysAreExactlyTheSix = true;
    expect(proof).toBe(true);
  });

  it('rejects sanitiser / plugin / seroval configuration at compile time', () => {
    type RendererOptions = Parameters<typeof createRenderer>[0];
    const base = { appComponent: () => html('<div />'), headContent: () => '' };

    // Each of these must be an excess property on the real options type. If any of these
    // `@ts-expect-error` directives ever becomes unused, TypeScript reports THAT as an error -
    // so a configuration escape hatch cannot be added silently.
    // @ts-expect-error the sanitiser is non-disableable: there is no `sanitiser` option
    const _noSanitiser: RendererOptions = { ...base, sanitiser: false };
    // @ts-expect-error user seroval plugins are not exposed in v1
    const _noPlugins: RendererOptions = { ...base, plugins: [] };
    // @ts-expect-error no seroval configuration surface is exposed
    const _noSeroval: RendererOptions = { ...base, seroval: {} };

    expect([_noSanitiser, _noPlugins, _noSeroval]).toHaveLength(3);
  });
});
