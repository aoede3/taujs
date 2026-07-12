// @vitest-environment jsdom
import React, { Suspense, use } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { createSSRStore, SSRStoreProvider, useSSRStore } from '../SSRDataStore.js';
import { createRenderer } from '../SSRRender.js';

// R3-06 (Q3, Policy A - signed 2026-07-12) - real react-dom, no mocks. Pins:
// 1. the OUTPUT-EQUIVALENCE gate (decisions addendum): for non-suspending trees the prerender
//    prelude is byte-identical to renderToString - the no-regression proof for every route that
//    works today;
// 2. the degrade matrix (probes 04/05): deadline + boundary => serve fallback-state HTML
//    (<!--$?-->) + advisory warn; deadline + no boundary => throw (never a blank 200); caller
//    abort => the existing { aborted: true } contract;
// 3. the E2E degrade outcome: the served fallback-state page hydrates and the CLIENT completes
//    the boundary (exactly one recoverable error, zero uncaught).

const never = new Promise<string>(() => {});
const delayed = (ms: number, v: string) => new Promise<string>((r) => setTimeout(() => r(v), ms));

describe('R3-06 output equivalence with renderToString (non-suspending trees)', () => {
  const cases: Array<{
    name: string;
    app: (props: { location: string; routeContext?: unknown }) => React.ReactElement;
    identifierPrefix?: string;
  }> = [
    {
      name: 'plain tree',
      app: ({ location }) => (
        <div>
          <h1>Title</h1>
          <p>{location}</p>
        </div>
      ),
    },
    {
      name: 'Suspense boundary whose children never suspend (resolved store consumer)',
      app: () => {
        const Consumer = () => {
          const d = useSSRStore<{ k: string }>();
          return <em>{d.k}</em>;
        };
        return (
          <div>
            <Suspense fallback={<i>F</i>}>
              <Consumer />
            </Suspense>
          </div>
        );
      },
    },
    {
      name: 'useId tree with identifierPrefix',
      identifierPrefix: 'tau1',
      app: () => {
        const IdComp = () => {
          const id = React.useId();
          return <span id={id}>x</span>;
        };
        return (
          <form>
            <IdComp />
            <IdComp />
          </form>
        );
      },
    },
  ];

  for (const { name, app, identifierPrefix } of cases) {
    it(`byte-identical: ${name}`, async () => {
      const renderer = createRenderer<{ k: string }>({ appComponent: app, headContent: () => '<head/>', identifierPrefix });
      const out = await renderer.renderSSR({ k: 'v' }, '/route', {});

      const store = createSSRStore({ k: 'v' });
      const expected = renderToString(<SSRStoreProvider store={store}>{app({ location: '/route' })}</SSRStoreProvider>, { identifierPrefix });

      expect(out.aborted).toBe(false);
      expect(out.appHtml).toBe(expected);
    });
  }
});

describe('R3-06 Policy A degrade matrix (real react-dom)', () => {
  it('deadline with a suspending child INSIDE a boundary: serves fallback-state HTML + advisory warn, no throw', async () => {
    const warn = vi.fn();
    const Reader = () => <section>{use(never)}</section>;
    const renderer = createRenderer<{ k: string }>({
      appComponent: () => (
        <div>
          <h1>SHELL</h1>
          <Suspense fallback={<i>FALLBACK</i>}>
            <Reader />
          </Suspense>
        </div>
      ),
      headContent: () => '<head/>',
      ssrOptions: { prerenderTimeoutMs: 100 },
      logger: { warn },
    });

    const out = await renderer.renderSSR({ k: 'v' }, '/degrade', {});

    expect(out.aborted).toBe(false);
    expect(out.appHtml).toContain('SHELL');
    expect(out.appHtml).toContain('FALLBACK');
    expect(out.appHtml).toContain('<!--$?-->'); // pending marker - the client completes it
    expect(out.headContent).toBe('<head/>');
    const degradeWarn = warn.mock.calls.find(([msg]) => String(msg).includes('prerenderTimeoutMs'));
    expect(degradeWarn?.[1]).toMatchObject({ location: '/degrade', prerenderTimeoutMs: 100 });
  });

  it('deadline with suspension OUTSIDE any boundary: throws (never a blank 200)', async () => {
    const Reader = () => <section>{use(never)}</section>;
    const renderer = createRenderer<{ k: string }>({
      appComponent: () => (
        <div>
          <Reader />
        </div>
      ),
      headContent: () => '<head/>',
      ssrOptions: { prerenderTimeoutMs: 100 },
      logger: { warn: vi.fn() },
    });

    await expect(renderer.renderSSR({ k: 'v' }, '/blank', {})).rejects.toThrow(/prerenderTimeoutMs \(100ms\) before the shell completed/);
  });

  it('caller abort mid-render preserves the existing { aborted: true } contract', async () => {
    const warn = vi.fn();
    const slow = delayed(300, 'CONTENT');
    const Reader = () => <section>{use(slow)}</section>;
    const renderer = createRenderer<{ k: string }>({
      appComponent: () => (
        <div>
          <Suspense fallback={<i>F</i>}>
            <Reader />
          </Suspense>
        </div>
      ),
      headContent: () => '<head/>',
      logger: { warn },
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('client disconnected')), 30);
    const out = await renderer.renderSSR({ k: 'v' }, '/gone', {}, ac.signal);

    expect(out).toEqual({ headContent: '', appHtml: '', aborted: true });
    expect(warn).toHaveBeenCalledWith('SSR completed after client abort', { location: '/gone' });
  });

  it('the deadline timer is cleared on completion (no spurious deadline warn after the render)', async () => {
    const warn = vi.fn();
    const renderer = createRenderer<{ k: string }>({
      appComponent: () => <div>fast</div>,
      headContent: () => '<head/>',
      ssrOptions: { prerenderTimeoutMs: 120 },
      logger: { warn },
    });

    const out = await renderer.renderSSR({ k: 'v' }, '/fast', {});
    expect(out.appHtml).toBe('<div>fast</div>');

    await new Promise((r) => setTimeout(r, 200)); // well past the deadline
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('R3-06 E2E: the degraded page completes on the client', () => {
  it('hydrateRoot on the served fallback-state HTML client-renders the boundary content', async () => {
    // Server: deadline degrade (the boundary's promise never settles server-side).
    const ServerReader = () => <section>{use(never)}</section>;
    const shell = (reader: React.ReactElement) => (
      <div>
        <h1>SHELL</h1>
        <Suspense fallback={<i>FALLBACK</i>}>{reader}</Suspense>
      </div>
    );
    const renderer = createRenderer<{ k: string }>({
      appComponent: () => shell(<ServerReader />),
      headContent: () => '<head/>',
      ssrOptions: { prerenderTimeoutMs: 100 },
      logger: { warn: vi.fn() },
    });
    const out = await renderer.renderSSR({ k: 'v' }, '/e2e', {});
    expect(out.appHtml).toContain('FALLBACK');

    // Client: same tree shape; the promise resolves client-side ("render the rest on the client").
    const clientPromise = delayed(30, 'CONTENT');
    const ClientReader = () => <section>{use(clientPromise)}</section>;
    const store = createSSRStore({ k: 'v' });

    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = out.appHtml;

    const recoverable: string[] = [];
    const uncaught: unknown[] = [];
    const root = hydrateRoot(container, <SSRStoreProvider store={store}>{shell(<ClientReader />)}</SSRStoreProvider>, {
      onRecoverableError: (e) => recoverable.push(String((e as Error)?.message ?? e)),
      onUncaughtError: (e) => uncaught.push(e),
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(container.textContent).toContain('CONTENT');
    expect(container.textContent).not.toContain('FALLBACK');
    expect(uncaught).toEqual([]);
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]).toMatch(/Suspense boundary.*Switched to client rendering/s);

    root.unmount();
    container.remove();
  });
});
