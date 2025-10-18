// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { defineService, defineServiceRegistry, callServiceMethod, isServiceDescriptor, type ServiceRegistry, type ServiceContext } from '../DataServices';
import { AppError } from '../../logging/AppError';

describe('defineService', () => {
  it('maps bare handler functions to descriptors', () => {
    const spec = defineService({
      ping: async (_: { x: number }) => ({ ok: true }) as const,
    });
    expect(typeof spec.ping.handler).toBe('function');
    expect(spec.ping.parsers).toBeUndefined();
  });

  it('maps object with handler only', () => {
    const spec = defineService({
      hello: { handler: async () => ({ hi: 1 }) },
    });
    expect(typeof spec.hello.handler).toBe('function');
    expect(spec.hello.parsers).toBeUndefined();
  });

  it('maps legacy params/result into parsers when provided', async () => {
    const params = vi.fn((input: any) => ({ n: Number(input.n) }));
    const result = vi.fn((out: any) => ({ doubled: out.doubled }));
    const spec = defineService({
      math: {
        handler: async (p: { n: number }) => ({ doubled: p.n * 2 }),
        params,
        result,
      },
    });

    const reg = defineServiceRegistry({ svc: spec }) as ServiceRegistry;
    const ctx: ServiceContext = {};
    const out = await callServiceMethod(reg, 'svc', 'math', { n: '21' }, ctx);

    expect(params).toHaveBeenCalled();
    expect(result).toHaveBeenCalled();
    expect(out).toEqual({ doubled: 42 });
  });

  it('keeps explicit parsers object when provided', async () => {
    const spec = defineService({
      box: {
        handler: async (p: { s: string }) => ({ s: p.s.toUpperCase() }),
        parsers: {
          params: (i: any) => ({ s: String(i.s) }),
          result: (o: any) => ({ s: o.s }),
        },
      },
    });

    const reg = defineServiceRegistry({ svc: spec }) as ServiceRegistry;
    const out = await callServiceMethod(reg, 'svc', 'box', { s: 1 }, {});
    expect(out).toEqual({ s: '1'.toUpperCase() });
  });
});

describe('defineServiceRegistry', () => {
  it('returns the registry as-is (identity)', () => {
    const regIn = { foo: {} } as any;
    const regOut = defineServiceRegistry(regIn);
    expect(regOut).toBe(regIn);
  });
});

describe('callServiceMethod', () => {
  it('throws timeout when ctx.signal.aborted is true', async () => {
    const reg = {} as any;
    const controller = new AbortController();
    controller.abort();

    await expect(callServiceMethod(reg, 'svc', 'm', {}, { signal: controller.signal })).rejects.toThrowError(/Request canceled/i);
  });

  it('throws notFound for unknown service', async () => {
    const reg = {} as any;
    await expect(callServiceMethod(reg, 'missing', 'm', {}, {})).rejects.toThrowError(/Unknown service: missing/);
  });

  it('throws notFound for unknown method', async () => {
    const reg = defineServiceRegistry({ svc: {} } as any);
    await expect(callServiceMethod(reg, 'svc', 'missing', {}, {})).rejects.toThrowError(/Unknown method: svc\.missing/);
  });

  it('logs and rethrows when handler throws', async () => {
    const child = vi.fn(() => ({ error: errorSpy }) as any);
    const errorSpy = vi.fn();

    const logger = { child } as any;

    const spec = defineService({
      boom: async () => {
        throw new AppError('kaboom', 'infra');
      },
    });

    const reg = defineServiceRegistry({ svc: spec }) as ServiceRegistry;

    await expect(callServiceMethod(reg, 'svc', 'boom', { a: 1 }, { logger, traceId: 't-1' })).rejects.toThrowError(/kaboom/);

    expect(child).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'service-call',
        service: 'svc',
        method: 'boom',
        traceId: 't-1',
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'Service method failed',
      expect.objectContaining({
        params: { a: 1 },
        error: expect.objectContaining({ name: 'AppError', message: 'kaboom' }),
      }),
    );
  });

  it('throws AppError.internal when handler resolves to non-object', async () => {
    const spec = defineService({
      nope: async () => null as any,
    });
    const reg = defineServiceRegistry({ svc: spec }) as ServiceRegistry;

    await expect(callServiceMethod(reg, 'svc', 'nope', {}, {})).rejects.toThrowError(/Non-object result from svc\.nope/);
  });

  it('passes through when result is a plain object', async () => {
    const spec = defineService({
      ok: async (p: { x: number }) => ({ x: p.x }),
    });
    const reg = defineServiceRegistry({ svc: spec }) as ServiceRegistry;

    const out = await callServiceMethod(reg, 'svc', 'ok', { x: 7 }, {});
    expect(out).toEqual({ x: 7 });
  });

  it('logs stringified non-Error values and rethrows them as-is', async () => {
    const errorSpy = vi.fn();
    const child = vi.fn(() => ({ error: errorSpy }) as any);
    const logger = { child } as any;

    const spec = defineService({
      boomStr: async () => {
        // throw a non-Error value to exercise String(err)
        throw 'nope' as any;
      },
    });

    const reg = defineServiceRegistry({ svc: spec }) as ServiceRegistry;

    await expect(callServiceMethod(reg, 'svc', 'boomStr', { p: 1 }, { logger, traceId: 't-2' })).rejects.toBe('nope'); // non-Error rethrown as-is

    expect(child).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'service-call',
        service: 'svc',
        method: 'boomStr',
        traceId: 't-2',
      }),
    );

    // The logged error must be the stringified value, not an object
    expect(errorSpy).toHaveBeenCalledWith(
      'Service method failed',
      expect.objectContaining({
        params: { p: 1 },
        error: 'nope', // <- String(err) branch covered
      }),
    );
  });
});

describe('isServiceDescriptor', () => {
  it('accepts minimal valid descriptors', () => {
    expect(isServiceDescriptor({ serviceName: 'a', serviceMethod: 'b' })).toBe(true);
  });

  it('rejects invalid shapes', () => {
    expect(isServiceDescriptor(null)).toBe(false);
    expect(isServiceDescriptor(undefined)).toBe(false);
    expect(isServiceDescriptor([])).toBe(false);
    expect(isServiceDescriptor({})).toBe(false);
    expect(isServiceDescriptor({ serviceName: 'a' })).toBe(false);
    expect(isServiceDescriptor({ serviceMethod: 'b' })).toBe(false);
    expect(isServiceDescriptor({ serviceName: 1, serviceMethod: 'b' })).toBe(false);
    expect(isServiceDescriptor({ serviceName: 'a', serviceMethod: 1 })).toBe(false);
  });
});
