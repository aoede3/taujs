// @vitest-environment node

import { describe, it, expect } from 'vitest';

import { mergePlugins } from '../VitePlugins';

describe('mergePlugins', () => {
  it('returns [] when no internal/apps are provided', () => {
    expect(mergePlugins({})).toEqual([]);
    expect(mergePlugins({ internal: undefined, apps: undefined })).toEqual([]);
    expect(mergePlugins({ internal: undefined, apps: [] })).toEqual([]);
  });

  it('flattens internal plugins (single + nested arrays) and app plugins, preserving order', () => {
    const i1 = { name: 'i1' } as any;
    const i2 = { name: 'i2' } as any;

    const a1 = { name: 'a1' } as any;
    const a2 = { name: 'a2' } as any;

    const out = mergePlugins({
      internal: [i1, [i2]] as any, // nested
      apps: [{ plugins: a1 }, { plugins: [a2] as any }],
    });

    // internal first, then apps
    expect(out.map((p) => p.name)).toEqual(['i1', 'i2', 'a1', 'a2']);
  });

  it('dedupes by plugin.name keeping the first occurrence across internal + apps', () => {
    const first = { name: 'dup', tag: 'first' } as any;
    const second = { name: 'dup', tag: 'second' } as any;
    const third = { name: 'dup', tag: 'third' } as any;

    const out = mergePlugins({
      internal: [first, second] as any,
      apps: [{ plugins: [third] as any }],
    });

    // only the first "dup" survives
    expect(out).toHaveLength(1);
    expect((out[0] as any).tag).toBe('first');
  });

  it('keeps anonymous plugins (no name, empty name, or non-string name) and does not dedupe them', () => {
    const anon1 = {} as any; // no name -> keep
    const anon2 = { name: '' } as any; // empty string -> keep
    const anon3 = { name: 123 } as any; // non-string -> treated as '' -> keep

    // include two different anonymous objects to prove they are not deduped
    const out = mergePlugins({
      internal: [anon1, anon2] as any,
      apps: [{ plugins: [anon3, {} as any] as any }],
    });

    expect(out).toHaveLength(4);

    // all are "anonymous" by the function's definition
    for (const p of out) {
      const name = typeof (p as any)?.name === 'string' ? (p as any).name : '';
      expect(name).toBe(''); // either missing/empty/non-string
    }
  });

  it('treats falsy PluginOption entries as empty during flattening', () => {
    const named = { name: 'ok' } as any;

    const out = mergePlugins({
      internal: [false, null, undefined, named] as any,
      apps: [{ plugins: [undefined, false] as any }],
    });

    // only the real plugin should remain
    expect(out.map((p) => (p as any).name)).toEqual(['ok']);
  });

  it('handles apps with missing plugins fields', () => {
    const out = mergePlugins({
      internal: { name: 'i' } as any,
      apps: [{}, { plugins: undefined }, { plugins: [{ name: 'a' } as any] as any }],
    });

    expect(out.map((p) => (p as any).name)).toEqual(['i', 'a']);
  });

  it('dedupes named plugins but still keeps anonymous ones alongside them', () => {
    const anon = {} as any;

    const out = mergePlugins({
      internal: [{ name: 'x' } as any, anon] as any,
      apps: [{ plugins: [{ name: 'x' } as any, {} as any] as any }],
    });

    // 'x' deduped (keeps the internal one), both anonymous kept
    expect(out).toHaveLength(3);
    expect((out[0] as any).name).toBe('x');
  });
});
