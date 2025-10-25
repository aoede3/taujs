import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance, FastifyPluginCallback, FastifyPluginAsync } from 'fastify';
import { normalizeStaticAssets, prefixWeight, registerStaticAssets, type StaticAssetsRegistration, type StaticMountEntry } from '../StaticAssets'; // <- adjust path if needed

function createFastifyMock() {
  const calls: Array<{ plugin: FastifyPluginCallback<any> | FastifyPluginAsync<any>; options: any }> = [];
  const app: Partial<FastifyInstance> & { _calls: typeof calls } = {
    _calls: calls,
    register: vi.fn(async function (this: FastifyInstance, plugin: any, options: any, ...rest: any[]) {
      calls.push({ plugin, options });
      return this;
    }) as unknown as FastifyInstance['register'],
  };

  return app as unknown as FastifyInstance & { _calls: typeof calls; register: FastifyInstance['register'] };
}

const pluginCb: FastifyPluginCallback<any> = (instance, opts, done) => done();
const pluginAsync: FastifyPluginAsync<any> = async () => {};

describe('normalizeStaticAssets', () => {
  it('returns empty array for undefined', () => {
    expect(normalizeStaticAssets(undefined)).toEqual([]);
  });

  it('returns empty array for false', () => {
    expect(normalizeStaticAssets(false as unknown as StaticAssetsRegistration)).toEqual([]);
  });

  it('wraps a single entry', () => {
    const single: StaticMountEntry = { plugin: pluginCb, options: { prefix: '/x' } };
    expect(normalizeStaticAssets(single)).toEqual([single]);
  });

  it('returns the same array for multiple entries', () => {
    const multi: StaticMountEntry[] = [
      { plugin: pluginCb, options: { prefix: '/a' } },
      { plugin: pluginAsync, options: { prefix: '/b' } },
    ];
    expect(normalizeStaticAssets(multi)).toBe(multi);
  });
});

describe('prefixWeight', () => {
  it('gives 0 for non-string, empty string, or "/"', () => {
    expect(prefixWeight(undefined)).toBe(0);
    expect(prefixWeight(123 as any)).toBe(0);
    expect(prefixWeight('')).toBe(0);
    expect(prefixWeight('/')).toBe(0);
  });

  it('counts path segments correctly', () => {
    expect(prefixWeight('/_admin')).toBe(1);
    expect(prefixWeight('/v123/assets')).toBe(2);
    expect(prefixWeight('/v123/assets/images')).toBe(3);
    // extra slashes shouldn’t inflate count
    expect(prefixWeight('//v123//assets///images')).toBe(3);
  });
});

describe('registerStaticAssets', () => {
  let app: ReturnType<typeof createFastifyMock>;
  const base = '/var/www/app';

  beforeEach(() => {
    app = createFastifyMock();
    vi.clearAllMocks();
  });

  it('does nothing when reg is undefined', async () => {
    await registerStaticAssets(app, base, undefined);
    expect(app.register).not.toHaveBeenCalled();
    expect(app._calls.length).toBe(0);
  });

  it('does nothing when reg is false', async () => {
    await registerStaticAssets(app, base, false);
    expect(app.register).not.toHaveBeenCalled();
    expect(app._calls.length).toBe(0);
  });

  it('registers a single mount with defaults applied', async () => {
    await registerStaticAssets(app, base, { plugin: pluginCb });
    expect(app.register).toHaveBeenCalledTimes(1);
    const call = app._calls[0]!;
    expect(call.plugin).toBe(pluginCb);
    // default option values
    expect(call.options.root).toBe(base);
    expect(call.options.prefix).toBe('/');
    expect(call.options.index).toBe(false);
    expect(call.options.wildcard).toBe(false);
  });

  it('merges defaults then user options (user wins)', async () => {
    await registerStaticAssets(
      app,
      base,
      {
        plugin: pluginCb,
        options: { prefix: '/public', maxAge: '1y' },
      },
      { immutable: true, prefix: '/SHOULD_BE_OVERRIDDEN' },
    );
    expect(app.register).toHaveBeenCalledTimes(1);
    const call = app._calls[0]!;
    const { options } = call;
    // base defaults
    expect(options.root).toBe(base);
    expect(options.index).toBe(false);
    expect(options.wildcard).toBe(false);
    // provided defaults applied
    expect(options.immutable).toBe(true);
    // user option overrides default
    expect(options.prefix).toBe('/public');
    // user option preserved
    expect(options.maxAge).toBe('1y');
  });

  it('registers multiple mounts in prefix-specificity order (deepest first)', async () => {
    const reg: StaticAssetsRegistration = [
      { plugin: pluginCb, options: { prefix: '/' } },
      { plugin: pluginAsync, options: { prefix: '/_admin' } },
      { plugin: pluginCb, options: { prefix: '/v123/assets/images' } },
      { plugin: pluginCb, options: { prefix: '/v123' } },
    ];
    await registerStaticAssets(app, base, reg);

    expect(app.register).toHaveBeenCalledTimes(4);

    const order = app._calls.map((c) => c.options.prefix);
    expect(order).toEqual(['/v123/assets/images', '/_admin', '/v123', '/']);

    for (const c of app._calls) {
      expect(c.options.root).toBe(base);
      expect(c.options.index).toBe(false);
      expect(c.options.wildcard).toBe(false);
    }
  });

  it('handles a mix of entries with/without explicit prefix', async () => {
    const reg: StaticAssetsRegistration = [
      { plugin: pluginCb, options: {} }, // no prefix -> '/'
      { plugin: pluginCb, options: { prefix: '/x' } },
    ];
    await registerStaticAssets(app, base, reg);

    expect(app.register).toHaveBeenCalledTimes(2);
    const order = app._calls.map((c) => c.options.prefix);
    // '/x' should come before '/'
    expect(order).toEqual(['/x', '/']);
  });

  it('passes through both callback and async plugin functions intact', async () => {
    const reg: StaticAssetsRegistration = [
      { plugin: pluginCb, options: { prefix: '/a' } },
      { plugin: pluginAsync, options: { prefix: '/b' } },
    ];
    await registerStaticAssets(app, base, reg);
    expect(app._calls.length).toBe(2);
    expect(app._calls[0]!.plugin).toBe(pluginCb);
    expect(app._calls[1]!.plugin).toBe(pluginAsync);
  });
});
