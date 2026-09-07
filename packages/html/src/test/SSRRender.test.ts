import { describe, expect, it, vi } from 'vitest';

import { createRenderer } from '../SSRRender';

describe('renderSSR', () => {
  it('returns empty fragments and aborted:false when no render callback is supplied (zero-config)', async () => {
    const { renderSSR } = createRenderer();
    await expect(renderSSR({}, '/')).resolves.toEqual({ headContent: '', appHtml: '', aborted: false });
  });

  it('never calls render when none was supplied', async () => {
    const { renderSSR } = createRenderer();
    // Nothing to spy on directly (there is no render), so this asserts indirectly: a zero-config
    // renderer must not throw for any input shape a render callback might have rejected.
    await expect(renderSSR({ a: 1 }, '/x', { title: 't' })).resolves.toEqual({ headContent: '', appHtml: '', aborted: false });
  });

  it('calls render exactly once per renderSSR call, after the data is available', async () => {
    const render = vi.fn().mockResolvedValue({ headContent: '<title>x</title>', appHtml: '<p>x</p>' });
    const { renderSSR } = createRenderer({ render });

    await renderSSR({ a: 1 }, '/x');

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('passes data, location, meta, routeContext, headData and signal through to the render context', async () => {
    let seen: unknown;
    const { renderSSR } = createRenderer({
      render: (ctx) => {
        seen = ctx;
        return {};
      },
    });
    const controller = new AbortController();

    await renderSSR({ a: 1 }, '/loc', { title: 'T' }, controller.signal, { routeContext: { r: 1 }, headData: { h: 1 } });

    expect(seen).toEqual({ data: { a: 1 }, location: '/loc', meta: { title: 'T' }, routeContext: { r: 1 }, headData: { h: 1 }, signal: controller.signal });
  });

  it('defaults meta to {} when the route declares none', async () => {
    let seenMeta: unknown;
    const { renderSSR } = createRenderer({
      render: (ctx) => {
        seenMeta = ctx.meta;
        return {};
      },
    });

    await renderSSR({}, '/');

    expect(seenMeta).toEqual({});
  });

  it('awaits render whether or not it returns a promise', async () => {
    const { renderSSR: asyncRenderSSR } = createRenderer({ render: async () => ({ headContent: 'h', appHtml: 'a' }) });
    await expect(asyncRenderSSR({}, '/')).resolves.toEqual({ headContent: 'h', appHtml: 'a', aborted: false });

    const { renderSSR: syncRenderSSR } = createRenderer({ render: () => ({ headContent: 'h2', appHtml: 'a2' }) });
    await expect(syncRenderSSR({}, '/')).resolves.toEqual({ headContent: 'h2', appHtml: 'a2', aborted: false });
  });

  it('normalises an omitted headContent or appHtml to an empty string', async () => {
    const { renderSSR: headOnly } = createRenderer({ render: () => ({ headContent: '<title>t</title>' }) });
    await expect(headOnly({}, '/')).resolves.toEqual({ headContent: '<title>t</title>', appHtml: '', aborted: false });

    const { renderSSR: bodyOnly } = createRenderer({ render: () => ({ appHtml: '<p>p</p>' }) });
    await expect(bodyOnly({}, '/')).resolves.toEqual({ headContent: '', appHtml: '<p>p</p>', aborted: false });

    const { renderSSR: neither } = createRenderer({ render: () => ({}) });
    await expect(neither({}, '/')).resolves.toEqual({ headContent: '', appHtml: '', aborted: false });
  });

  it('rejects with the pinned TypeError for a null render result', async () => {
    const { renderSSR } = createRenderer({ render: () => null as never });
    await expect(renderSSR({}, '/')).rejects.toThrow(TypeError);
    await expect(renderSSR({}, '/')).rejects.toThrow('createRenderer: render() must return { headContent?: string, appHtml?: string } (received null)');
  });

  it('rejects with the pinned TypeError for a non-object render result', async () => {
    const { renderSSR } = createRenderer({ render: () => 42 as never });
    await expect(renderSSR({}, '/')).rejects.toThrow('createRenderer: render() must return { headContent?: string, appHtml?: string } (received 42)');
  });

  it('rejects with the pinned TypeError when a fragment is present but not a string', async () => {
    const { renderSSR } = createRenderer({ render: () => ({ appHtml: 7 }) as never });
    await expect(renderSSR({}, '/')).rejects.toThrow(TypeError);
  });

  it('skips render and returns aborted:true when the signal is already aborted at entry', async () => {
    const render = vi.fn();
    const { renderSSR } = createRenderer({ render });
    const controller = new AbortController();
    controller.abort();

    await expect(renderSSR({}, '/', {}, controller.signal)).resolves.toEqual({ headContent: '', appHtml: '', aborted: true });
    expect(render).not.toHaveBeenCalled();
  });

  it('reports aborted:true when the signal aborts while render is pending, but still returns the resolved fragments', async () => {
    const controller = new AbortController();
    const { renderSSR } = createRenderer({
      render: async () => {
        controller.abort();
        return { headContent: 'h', appHtml: 'a' };
      },
    });

    await expect(renderSSR({}, '/', {}, controller.signal)).resolves.toEqual({ headContent: 'h', appHtml: 'a', aborted: true });
  });

  it('propagates a thrown render error as a rejection', async () => {
    const { renderSSR } = createRenderer({
      render: () => {
        throw new Error('boom');
      },
    });

    await expect(renderSSR({}, '/')).rejects.toThrow('boom');
  });

  it('propagates a rejected render promise as a rejection', async () => {
    const { renderSSR } = createRenderer({ render: () => Promise.reject(new Error('rejected')) });

    await expect(renderSSR({}, '/')).rejects.toThrow('rejected');
  });
});
