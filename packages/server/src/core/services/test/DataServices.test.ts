// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  nowCalls: [100, 160.3],
  childMock: vi.fn(),
  debugMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock('node:perf_hooks', () => {
  let i = 0;
  return {
    performance: {
      now: () => hoisted.nowCalls[Math.min(i++, hoisted.nowCalls.length - 1)],
    },
  };
});

class MockAppError extends Error {
  code?: string;
  details?: unknown;
  override cause?: unknown;
  constructor(message: string, code?: string, details?: unknown, cause?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    if (cause) (this as any).cause = cause;
  }
  static notFound(msg: string) {
    return new MockAppError(msg, 'NOT_FOUND');
  }
  static internal(msg: string, opts?: { cause?: unknown; details?: unknown }) {
    return new MockAppError(msg, 'INTERNAL', opts?.details, opts?.cause);
  }
  static timeout(msg: string) {
    return new MockAppError(msg, 'TIMEOUT');
  }
}
vi.mock('../../errors/AppError', () => ({ AppError: MockAppError }));

function makeLogger() {
  hoisted.childMock.mockReturnValue({ debug: hoisted.debugMock, error: hoisted.errorMock });
  return {
    child: hoisted.childMock,
    debug: hoisted.debugMock,
    error: hoisted.errorMock,
  };
}

async function importModule() {
  vi.resetModules();
  return await import('../DataServices');
}

beforeEach(() => {
  hoisted.childMock.mockReset();
  hoisted.debugMock.mockReset();
  hoisted.errorMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('defineService', () => {
  it('accepts raw function handlers (no schemas) and passes params/ctx through', async () => {
    const S = await importModule();
    const handler = vi.fn(async (p, ctx) => ({ ok: true, got: p, trace: ctx.traceId }));
    const svc = S.defineService({ ping: handler });
    const ctx = { traceId: 't-1' } as any;

    const res = await svc.ping({ a: 1 } as any, ctx);
    expect(res).toEqual({ ok: true, got: { a: 1 }, trace: 't-1' });
    expect(handler).toHaveBeenCalledWith({ a: 1 }, ctx);
  });

  it('wraps handlers with params and result schemas (function form and zod-like parse form)', async () => {
    const S = await importModule();

    const paramsSchemaFn = (u: unknown) => {
      const o = u as any;
      if (!o || typeof o.x !== 'number') throw new Error('bad params');
      return { x: o.x + 1 };
    };
    const resultSchemaParseLike = {
      parse: (u: unknown) => {
        const o = u as any;
        if (!o || typeof o.ok !== 'boolean') throw new Error('bad result');
        return { ...o, ok: !o.ok };
      },
    };

    const spec = S.defineService({
      work: {
        handler: vi.fn(async (p: { x: number }) => ({ ok: true, p })),
        params: paramsSchemaFn,
        result: resultSchemaParseLike,
      },
    });

    const out = await spec.work({ x: 9 } as any, {} as any);
    expect(out).toEqual({ ok: false, p: { x: 10 } });
  });

  it('wrapper with no schemas passes params and result through unchanged', async () => {
    const S = await importModule();
    const handler = vi.fn(async (p) => ({ echoed: p }));
    const spec = S.defineService({
      echo: { handler },
    });
    const params = { a: 1, b: 'x' } as any;
    const out = await spec.echo(params, {} as any);
    expect(handler).toHaveBeenCalledWith(params, expect.anything());
    expect(out).toEqual({ echoed: params });
  });
});

describe('defineServiceRegistry', () => {
  it('deep-freezes registry and service definitions', async () => {
    const S = await importModule();
    const svc = S.defineService({ a: async () => ({ a: 1 }) });
    const reg = S.defineServiceRegistry({ foo: svc });

    expect(Object.isFrozen(reg)).toBe(true);
    expect(Object.isFrozen(reg.foo)).toBe(true);

    expect(() => {
      (reg as any).bar = 1;
    }).toThrow(TypeError);
    expect(Object.prototype.hasOwnProperty.call(reg, 'bar')).toBe(false);
  });
});

describe('callServiceMethod', () => {
  it('calls method successfully, defaulting params to {} and logs debug with ms', async () => {
    const S = await importModule();

    const method = vi.fn(async (params, ctx) => {
      expect(params).toEqual({});
      expect(ctx.traceId).toBe('trace-123');
      return { hello: 'world' };
    });

    const registry = { svc: { m: method } } as any;
    const logger = makeLogger();

    const out = await S.callServiceMethod(registry, 'svc', 'm', undefined, {
      traceId: 'trace-123',
      logger: logger as any,
    });

    expect(out).toEqual({ hello: 'world' });
    expect(hoisted.childMock).toHaveBeenCalledWith(expect.objectContaining({ component: 'service-call', service: 'svc', method: 'm', traceId: 'trace-123' }));
    expect(hoisted.debugMock).toHaveBeenCalledWith({ ms: expect.any(Number) }, 'Service method ok');
  });

  it('throws timeout AppError if ctx.signal is already aborted', async () => {
    const S = await importModule();
    const ac = new AbortController();
    ac.abort(new Error('bye'));

    await expect(S.callServiceMethod({} as any, 'svc', 'm', {}, { signal: ac.signal })).rejects.toMatchObject({
      name: 'AppError',
      code: 'TIMEOUT',
      message: 'Request canceled',
    });
  });

  it('throws notFound for unknown service', async () => {
    const S = await importModule();
    await expect(S.callServiceMethod({} as any, 'missing', 'm', {}, {} as any)).rejects.toMatchObject({
      name: 'AppError',
      code: 'NOT_FOUND',
      message: 'Unknown service: missing',
    });
  });

  it('throws notFound for unknown method', async () => {
    const S = await importModule();
    await expect(S.callServiceMethod({ svc: {} } as any, 'svc', 'missing', {}, {} as any)).rejects.toMatchObject({
      name: 'AppError',
      code: 'NOT_FOUND',
      message: 'Unknown method: svc.missing',
    });
  });

  it('throws internal when handler returns non-object', async () => {
    const S = await importModule();
    const registry = { s: { bad: async () => 42 as any } } as any;
    await expect(S.callServiceMethod(registry, 's', 'bad', {}, {} as any)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INTERNAL',
      message: 'Non-object result from s.bad',
    });
  });

  it('rethrows AppError without wrapping', async () => {
    const S = await importModule();
    const err = MockAppError.internal('boom');
    const registry = {
      s: {
        m: async () => {
          throw err;
        },
      },
    } as any;
    await expect(S.callServiceMethod(registry, 's', 'm', {}, { logger: makeLogger() as any })).rejects.toBe(err);
  });

  it('wraps generic Error as AppError.internal with cause', async () => {
    const S = await importModule();
    const e = new Error('nope');
    const registry = {
      s: {
        m: async () => {
          throw e;
        },
      },
    } as any;
    await expect(S.callServiceMethod(registry, 's', 'm', {}, { logger: makeLogger() as any })).rejects.toMatchObject({
      name: 'AppError',
      code: 'INTERNAL',
      message: 'nope',
      cause: e,
    });
  });

  it('wraps non-Error throws as AppError.internal("Unknown error") with details', async () => {
    const S = await importModule();
    const m = async () => {
      throw 'weird';
    };
    const registry = { s: { m } } as any;
    await expect(S.callServiceMethod(registry, 's', 'm', {}, { logger: makeLogger() as any })).rejects.toMatchObject({
      name: 'AppError',
      code: 'INTERNAL',
      message: 'Unknown error',
      details: { err: 'weird' },
    });
  });
});

describe('withDeadline', () => {
  it('returns input signal when ms is undefined', async () => {
    const S = await importModule();
    const ac = new AbortController();
    const out = S.withDeadline(ac.signal, undefined);
    expect(out).toBe(ac.signal);
  });

  it('aborts after the specified deadline', async () => {
    const S = await importModule();
    vi.useFakeTimers();

    const out = S.withDeadline(undefined, 50)!;
    expect(out.aborted).toBe(false);

    vi.advanceTimersByTime(49);
    expect(out.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(out.aborted).toBe(true);
    expect(out.reason).toBeInstanceOf(Error);
    expect((out.reason as Error).message).toBe('DeadlineExceeded');
  });

  it('propagates parent abort and clears the timeout', async () => {
    const S = await importModule();
    vi.useFakeTimers();

    const parent = new AbortController();
    const child = S.withDeadline(parent.signal, 100)!;

    expect(child.aborted).toBe(false);

    const reason = new Error('ParentGone');
    parent.abort(reason);
    expect(child.aborted).toBe(true);
    expect(child.reason).toBe(reason);

    vi.advanceTimersByTime(1000);
    expect(child.aborted).toBe(true);
  });

  it('uses parent reason if provided by runtime when parent aborts without explicit reason', async () => {
    const S = await importModule();
    const parent = new AbortController();
    const child = S.withDeadline(parent.signal, 1000)!;
    parent.abort();
    expect(child.aborted).toBe(true);
    expect(child.reason).toBe(parent.signal.reason);
  });

  it('falls back to default Error("Aborted") when parent signal has no reason property', async () => {
    const S = await importModule();
    const listeners: Array<() => void> = [];
    const mockSignal: any = {
      aborted: false,
      reason: undefined,
      addEventListener: (type: string, cb: any) => {
        if (type === 'abort') listeners.push(cb);
      },
      removeEventListener: () => {},
    };
    const child = S.withDeadline(mockSignal, 1000)!;
    expect(child.aborted).toBe(false);
    mockSignal.aborted = true;
    listeners.forEach((cb) => cb());
    expect(child.aborted).toBe(true);
    expect(child.reason).toBeInstanceOf(Error);
    expect((child.reason as Error).message).toBe('Aborted');
  });
});

describe('isServiceDescriptor', () => {
  it('returns true for valid descriptor with/without args', async () => {
    const S = await importModule();
    expect(S.isServiceDescriptor({ serviceName: 'a', serviceMethod: 'b' })).toBe(true);
    expect(S.isServiceDescriptor({ serviceName: 'a', serviceMethod: 'b', args: {} })).toBe(true);
    expect(S.isServiceDescriptor({ serviceName: 'a', serviceMethod: 'b', args: { x: 1, y: 's', z: null } })).toBe(true);
  });

  it('returns false for non-object, arrays, missing fields, and bad args', async () => {
    const S = await importModule();

    expect(S.isServiceDescriptor(null)).toBe(false);
    expect(S.isServiceDescriptor(undefined)).toBe(false);
    expect(S.isServiceDescriptor([])).toBe(false);
    expect(S.isServiceDescriptor({})).toBe(false);
    expect(S.isServiceDescriptor({ serviceName: 'a' })).toBe(false);
    expect(S.isServiceDescriptor({ serviceMethod: 'b' })).toBe(false);
    expect(S.isServiceDescriptor({ serviceName: 'a', serviceMethod: 'b', args: [] })).toBe(false);
    expect(S.isServiceDescriptor({ serviceName: 'a', serviceMethod: 'b', args: null })).toBe(false);
    expect(S.isServiceDescriptor({ serviceName: 'a', serviceMethod: 'b', args: 1 as any })).toBe(false);
  });
});
