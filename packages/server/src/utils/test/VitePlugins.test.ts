// @vitest-environment node

import { describe, it, expect } from 'vitest';

import { composePlugins, pluginCollisionMessage, reservedPluginMessage, RESERVED_PLUGIN_PREFIX } from '../VitePlugins';

import type { PluginCollision, ReservedPluginDrop } from '../VitePlugins';

describe('composePlugins (RFC 0005 §5)', () => {
  it('returns [] when no sources/internal are provided', () => {
    expect(composePlugins({ sources: [] })).toEqual([]);
    expect(composePlugins({ sources: [{ source: 'a', plugins: undefined }] })).toEqual([]);
    expect(composePlugins({ sources: [{ source: 'a', plugins: [] }], internal: [] })).toEqual([]);
  });

  it('concatenates sources in declared order, flattening preset arrays first', () => {
    const a1 = { name: 'a1' } as any;
    const a2 = { name: 'a2' } as any; // nested preset pack
    const b1 = { name: 'b1' } as any;

    const out = composePlugins({
      sources: [
        { source: 'appA', plugins: [a1, [a2]] as any },
        { source: 'appB', plugins: b1 },
      ],
    });

    expect(out.map((p) => p.name)).toEqual(['a1', 'a2', 'b1']);
  });

  it('dedupes by name across ALL sources, first occurrence wins, preserving the winning object', () => {
    const first = { name: 'dup', tag: 'first' } as any;
    const second = { name: 'dup', tag: 'second' } as any;
    const third = { name: 'dup', tag: 'third' } as any;

    const out = composePlugins({
      sources: [
        { source: 'appA', plugins: [first] },
        { source: 'appB', plugins: [second] },
        { source: 'config.vite', plugins: [third] },
      ],
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(first); // exact reference of the first occurrence
  });

  it('reports a collision once with the name, EVERY declaring source, and the winner (first)', () => {
    const collisions: PluginCollision[] = [];

    composePlugins({
      sources: [
        { source: 'main', plugins: [{ name: 'shared' } as any] },
        { source: 'admin', plugins: [{ name: 'shared' } as any, { name: 'only-admin' } as any] },
        { source: 'config.vite', plugins: [{ name: 'shared' } as any] },
      ],
      onCollision: (c) => collisions.push(c),
    });

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toEqual({ name: 'shared', sources: ['main', 'admin', 'config.vite'], winner: 'main' });
    // 'only-admin' declared once -> no collision reported.
  });

  it('app.plugins vs config.vite: app wins in the composed output and a collision is reported', () => {
    const appPlugin = { name: 'x', from: 'app' } as any;
    const configVitePlugin = { name: 'x', from: 'config.vite' } as any;
    const collisions: PluginCollision[] = [];

    const out = composePlugins({
      sources: [
        { source: 'main', plugins: [appPlugin] },
        { source: 'config.vite', plugins: [configVitePlugin] },
      ],
      onCollision: (c) => collisions.push(c),
    });

    expect(out).toEqual([appPlugin]);
    expect(collisions).toEqual([{ name: 'x', sources: ['main', 'config.vite'], winner: 'main' }]);
  });

  it('drops user plugins carrying the reserved τjs- prefix and reports each with its source', () => {
    const drops: ReservedPluginDrop[] = [];
    const kept = { name: 'legit' } as any;

    const out = composePlugins({
      sources: [
        { source: 'main', plugins: [{ name: 'τjs-impostor' } as any, kept] },
        { source: 'config.vite', plugins: [{ name: 'τjs-development-server-debug-logging' } as any] },
      ],
      onReservedPrefix: (d) => drops.push(d),
    });

    expect(out).toEqual([kept]);
    expect(drops).toEqual([
      { name: 'τjs-impostor', source: 'main' },
      { name: 'τjs-development-server-debug-logging', source: 'config.vite' },
    ]);
    expect(RESERVED_PLUGIN_PREFIX).toBe('τjs-');
  });

  it('a reserved-prefix user plugin cannot collide with or displace anything - it is simply gone', () => {
    const collisions: PluginCollision[] = [];
    const drops: ReservedPluginDrop[] = [];

    // Two apps both try to smuggle the SAME reserved name: neither is a "collision", both are drops.
    const out = composePlugins({
      sources: [
        { source: 'main', plugins: [{ name: 'τjs-x' } as any] },
        { source: 'admin', plugins: [{ name: 'τjs-x' } as any] },
      ],
      onCollision: (c) => collisions.push(c),
      onReservedPrefix: (d) => drops.push(d),
    });

    expect(out).toEqual([]);
    expect(collisions).toEqual([]);
    expect(drops).toHaveLength(2);
  });

  it('appends internal plugins LAST, exempt from user dedupe AND the prefix reservation', () => {
    const userX = { name: 'x', from: 'user' } as any;
    const internalX = { name: 'x', from: 'internal' } as any; // same name as a user plugin
    const internalReserved = { name: 'τjs-development-server-debug-logging' } as any;
    const collisions: PluginCollision[] = [];
    const drops: ReservedPluginDrop[] = [];

    const out = composePlugins({
      sources: [{ source: 'main', plugins: [userX] }],
      internal: [internalX, internalReserved],
      onCollision: (c) => collisions.push(c),
      onReservedPrefix: (d) => drops.push(d),
    });

    // user 'x' first, then BOTH internal plugins last (internal not deduped against user, τjs- kept).
    expect(out).toEqual([userX, internalX, internalReserved]);
    expect(collisions).toEqual([]); // internal exemption -> no user/internal collision reported
    expect(drops).toEqual([]); // internal τjs- plugin is exempt
  });

  it('passes nameless plugins through undeduped (identity cannot be invented)', () => {
    const anon1 = {} as any; // no name
    const anon2 = { name: '' } as any; // empty string
    const anon3 = { name: 123 } as any; // non-string -> treated as nameless

    const out = composePlugins({
      sources: [
        { source: 'main', plugins: [anon1, anon2] as any },
        { source: 'admin', plugins: [anon3, {} as any] as any },
      ],
    });

    expect(out).toHaveLength(4);
  });

  it('treats falsy PluginOption entries as empty during flattening', () => {
    const named = { name: 'ok' } as any;

    const out = composePlugins({
      sources: [
        { source: 'main', plugins: [false, null, undefined, named] as any },
        { source: 'admin', plugins: [undefined, false] as any },
      ],
    });

    expect(out.map((p) => (p as any).name)).toEqual(['ok']);
  });

  it('build semantics: a single app source composes without needing extra layers', () => {
    const p = { name: 'test-plugin' } as any;
    const out = composePlugins({ sources: [{ source: 'test-app', plugins: [p] }], internal: [] });
    expect(out).toEqual([p]);
  });
});

describe('shared reporter messages (one format for dev and build)', () => {
  it('pluginCollisionMessage names the plugin, all sources, and the winner', () => {
    const msg = pluginCollisionMessage({ name: 'vite:vue', sources: ['main', 'admin'], winner: 'main' });
    expect(msg).toContain('vite:vue');
    expect(msg).toContain('main, admin');
    expect(msg).toContain('main'); // winner
  });

  it('reservedPluginMessage names the plugin, its source, and the reserved prefix', () => {
    const msg = reservedPluginMessage({ name: 'τjs-impostor', source: 'config.vite' });
    expect(msg).toContain('τjs-impostor');
    expect(msg).toContain('config.vite');
    expect(msg).toContain(RESERVED_PLUGIN_PREFIX);
  });
});
