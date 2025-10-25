// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import { messageMetaAdapter, winstonAdapter, type MessageMetaLogger } from '../Adapters';
import type { BaseLogger } from '../Logger';

type Call = { method: 'debug' | 'info' | 'warn' | 'error'; message?: string; meta?: Record<string, unknown> | undefined };

function makeSink(partial?: Partial<MessageMetaLogger>) {
  const calls: Call[] = [];

  const record = (method: Call['method']) => (message?: string, meta?: Record<string, unknown>) => {
    calls.push({ method, message, meta });
  };

  const sink: MessageMetaLogger = {
    debug: partial?.debug ?? vi.fn(record('debug')),
    info: partial?.info ?? vi.fn(record('info')),
    warn: partial?.warn ?? vi.fn(record('warn')),
    error: partial?.error ?? vi.fn(record('error')),
    child: partial?.child,
  };

  return { sink, calls };
}

describe('messageMetaAdapter', () => {
  it('swaps (meta, message) -> (message, meta) for all levels', () => {
    const { sink, calls } = makeSink();
    const log: BaseLogger = messageMetaAdapter(sink);

    log.debug?.({ a: 1 }, 'd');
    log.info?.({ b: 2 }, 'i');
    log.warn?.({ c: 3 }, 'w');
    log.error?.({ d: 4 }, 'e');

    expect(calls).toEqual([
      { method: 'debug', message: 'd', meta: { a: 1 } },
      { method: 'info', message: 'i', meta: { b: 2 } },
      { method: 'warn', message: 'w', meta: { c: 3 } },
      { method: 'error', message: 'e', meta: { d: 4 } },
    ]);
  });

  it('cleans empty meta {} to undefined', () => {
    const { sink, calls } = makeSink();
    const log = messageMetaAdapter(sink);

    log.info?.({}, 'hello');
    log.warn?.({}, undefined);

    expect(calls[0]).toEqual({ method: 'info', message: 'hello', meta: undefined });
    expect(calls[1]).toEqual({ method: 'warn', message: undefined, meta: undefined });
  });

  it('passes through undefined meta and undefined message', () => {
    const { sink, calls } = makeSink();
    const log = messageMetaAdapter(sink);

    log.debug?.(undefined, undefined);
    expect(calls[0]).toEqual({ method: 'debug', message: undefined, meta: undefined });
  });

  it('propagates child() when the sink implements it', () => {
    const childCalls: Call[] = [];
    const childSink: MessageMetaLogger = {
      warn: vi.fn((msg?: string, meta?: Record<string, unknown>) => {
        childCalls.push({ method: 'warn', message: msg, meta });
      }),
    };

    const parentChild = vi.fn((_bindings: Record<string, unknown>) => childSink);

    const { sink, calls } = makeSink({ child: parentChild });
    const log = messageMetaAdapter(sink);

    const child = log.child?.({ reqId: 'abc' }) as BaseLogger;
    child.warn?.({ k: 1 }, 'from-child');

    expect(parentChild).toHaveBeenCalledWith({ reqId: 'abc' });
    expect(childCalls).toEqual([{ method: 'warn', message: 'from-child', meta: { k: 1 } }]);
    expect(calls).toHaveLength(0);
  });

  it('when sink has no child(), child() returns an adapter wrapping the same sink', () => {
    const { sink, calls } = makeSink();
    const log = messageMetaAdapter(sink);

    const child = log.child?.({ foo: 'bar' }) as BaseLogger;
    child.error?.({ oops: true }, 'boom');

    expect(calls).toEqual([{ method: 'error', message: 'boom', meta: { oops: true } }]);
  });

  it('handles optional level methods gracefully (no throws, no calls)', () => {
    const warnSpy = vi.fn((_m?: string, _meta?: Record<string, unknown>) => {});
    const partialSink: MessageMetaLogger = { warn: warnSpy };

    const log = messageMetaAdapter(partialSink);

    expect(() => log.debug?.({ a: 1 }, 'd')).not.toThrow();
    expect(() => log.info?.({ b: 2 }, 'i')).not.toThrow();
    expect(() => log.error?.({ c: 3 }, 'e')).not.toThrow();

    log.warn?.({ w: 1 }, 'warned');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('warned', { w: 1 });
  });
});

describe('winstonAdapter', () => {
  it('delegates to messageMetaAdapter (message, meta)', () => {
    const { sink, calls } = makeSink();
    const win = sink;
    const log = winstonAdapter(win);

    log.info?.({ user: 'alice' }, 'login');
    log.error?.({}, 'bad');

    expect(calls[0]).toEqual({ method: 'info', message: 'login', meta: { user: 'alice' } });
    expect(calls[1]).toEqual({ method: 'error', message: 'bad', meta: undefined });
  });

  it('winstonAdapter + child chain still works', () => {
    const childCalls: Call[] = [];
    const childSink: MessageMetaLogger = {
      info: vi.fn((msg?: string, meta?: Record<string, unknown>) => {
        childCalls.push({ method: 'info', message: msg, meta });
      }),
    };
    const parent: MessageMetaLogger = {
      child: vi.fn(() => childSink),
    };

    const log = winstonAdapter(parent);
    const c = log.child?.({ bind: 1 })!;
    c.info?.({ ok: true }, 'child-info');

    expect((parent.child as any).mock.calls[0][0]).toEqual({ bind: 1 });
    expect(childCalls).toEqual([{ method: 'info', message: 'child-info', meta: { ok: true } }]);
  });
});
