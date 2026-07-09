// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { defineService, getServiceMethodMetadata } from '../DataServices';

// A params/result schema in either NarrowSchema form (DataServices.ts:12) — a bare
// function or an object with `.parse`. These are the only two kinds we can honestly detect.
const fnSchema = (u: unknown) => u as { x: number };
const parseSchema = { parse: (u: unknown) => u as { ok: boolean } };

describe('defineService — retained method metadata', () => {
  it('bare-function entries record both fields as undeclared', () => {
    const ping = async (_p: {}) => ({ ok: true });

    const svc = defineService({ ping });

    expect(getServiceMethodMetadata(svc.ping)).toEqual({
      params: { declared: false },
      result: { declared: false },
    });
  });

  it('wrapped entries with no schemas record both fields as undeclared', () => {
    const echo = async (_p: {}) => ({ echoed: true });

    const svc = defineService({ echo: { handler: echo } });

    expect(getServiceMethodMetadata(svc.echo)).toEqual({
      params: { declared: false },
      result: { declared: false },
    });
  });

  it('detects kind: function (bare schema) and parse (object with .parse) per field', () => {
    const svc = defineService({
      onlyParams: { handler: async (_p: {}) => ({ ok: true }), params: fnSchema },
      onlyResult: { handler: async (_p: {}) => ({ ok: true }), result: parseSchema },
      both: { handler: async (_p: {}) => ({ ok: true }), params: parseSchema, result: fnSchema },
    });

    expect(getServiceMethodMetadata(svc.onlyParams)).toEqual({
      params: { declared: true, kind: 'function' },
      result: { declared: false },
    });
    expect(getServiceMethodMetadata(svc.onlyResult)).toEqual({
      params: { declared: false },
      result: { declared: true, kind: 'parse' },
    });
    expect(getServiceMethodMetadata(svc.both)).toEqual({
      params: { declared: true, kind: 'parse' },
      result: { declared: true, kind: 'function' },
    });
  });

  it('kind detection mirrors the schema runSchema actually applies (behaviour unchanged)', async () => {
    const handler = vi.fn(async (p: { x: number }) => ({ ok: true, p }));
    const params = (u: unknown) => ({ x: (u as { x: number }).x + 1 });
    const result = { parse: (u: unknown) => ({ ...(u as object), ok: !(u as { ok: boolean }).ok }) };

    const svc = defineService({ work: { handler, params, result } });

    // The wrapped runtime path is byte-for-byte the pre-P0A-02 behaviour.
    const out = await svc.work({ x: 9 } as any, {} as any);
    expect(out).toEqual({ ok: false, p: { x: 10 } });

    // ...and the recorded metadata names exactly those two schema kinds.
    expect(getServiceMethodMetadata(svc.work)).toEqual({
      params: { declared: true, kind: 'function' },
      result: { declared: true, kind: 'parse' },
    });
  });
});

describe('defineService metadata — stamping guarantees', () => {
  it('is non-enumerable: keys, spread, and JSON never leak it', () => {
    const svc = defineService({ m: { handler: async (_p: {}) => ({ ok: true }), params: fnSchema } });

    expect(Object.keys(svc.m)).toEqual([]);
    expect(Object.getOwnPropertySymbols({ ...svc.m })).toEqual([]);
    expect(JSON.stringify({ ...svc.m })).toBe('{}');

    // ...yet still readable through the accessor.
    expect(getServiceMethodMetadata(svc.m)).toBeDefined();
  });

  it('freezes the metadata object and its nested fields', () => {
    const svc = defineService({ m: { handler: async (_p: {}) => ({ ok: true }), params: fnSchema } });

    const meta = getServiceMethodMetadata(svc.m)!;
    expect(Object.isFrozen(meta)).toBe(true);
    expect(Object.isFrozen(meta.params)).toBe(true);
    expect(Object.isFrozen(meta.result)).toBe(true);
  });

  it('preserves bare-function identity (stamped in place, not wrapped)', async () => {
    const ping = vi.fn(async (p: { a: number }, ctx: { traceId?: string }) => ({ got: p, trace: ctx.traceId ?? 'none' }));

    const svc = defineService({ ping });
    const ctx = { traceId: 't' } as any;

    expect(svc.ping).toBe(ping);
    expect(await svc.ping({ a: 1 } as any, ctx)).toEqual({ got: { a: 1 }, trace: 't' });
    expect(ping).toHaveBeenCalledWith({ a: 1 }, ctx);
  });

  it('does not throw when a bare function is reused across defineService calls', () => {
    const shared = async (_p: {}) => ({ ok: true });

    const s1 = defineService({ a: shared });
    expect(() => defineService({ b: shared })).not.toThrow();
    const s2 = defineService({ b: shared });

    expect(s1.a).toBe(shared);
    expect(s2.b).toBe(shared);
    expect(getServiceMethodMetadata(s2.b)).toEqual({ params: { declared: false }, result: { declared: false } });
  });

  it('leaves a frozen user handler untouched — an honest gap, never a throw', () => {
    const frozen = Object.freeze(async (_p: {}) => ({ ok: true }));

    expect(() => defineService({ f: frozen })).not.toThrow();
    expect(getServiceMethodMetadata(defineService({ f: frozen }).f)).toBeUndefined();
  });
});

describe('getServiceMethodMetadata — accessor', () => {
  it('returns undefined for unstamped functions and non-functions', () => {
    expect(getServiceMethodMetadata(async () => ({}))).toBeUndefined();
    expect(getServiceMethodMetadata({ params: { declared: false } })).toBeUndefined();
    expect(getServiceMethodMetadata(undefined)).toBeUndefined();
    expect(getServiceMethodMetadata(null)).toBeUndefined();
  });
});
