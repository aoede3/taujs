// @vitest-environment node
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';

import { createStreamController, isBenignSocketError } from '../Streaming.js';

const noopLog = { log: () => {}, warn: () => {}, error: () => {} };

describe('createStreamController - detach runs EXACTLY ONCE on every terminal kind', () => {
  const kinds = [
    ['complete', (c: ReturnType<typeof createStreamController>) => c.complete('done')],
    ['benignAbort', (c: ReturnType<typeof createStreamController>) => c.benignAbort('cancelled')],
    ['fatalAbort', (c: ReturnType<typeof createStreamController>) => c.fatalAbort(new Error('boom'))],
  ] as const;

  for (const [label, terminate] of kinds) {
    it(`${label} detaches exactly once`, async () => {
      const sink = new PassThrough();
      sink.on('error', () => {});
      const detach = vi.fn();
      const controller = createStreamController(sink, noopLog);
      controller.setDetach(detach);

      terminate(controller);
      // repeated + mixed terminals must not detach again
      controller.complete();
      controller.benignAbort('again');
      controller.fatalAbort(new Error('again'));

      expect(detach).toHaveBeenCalledTimes(1);
      await controller.done.catch(() => {});
    });
  }

  it('detaches even when a cleanup throws', async () => {
    const sink = new PassThrough();
    sink.on('error', () => {});
    const detach = vi.fn();
    const controller = createStreamController(sink, noopLog);
    controller.addCleanup(() => {
      throw new Error('cleanup exploded');
    });
    controller.setDetach(detach);

    controller.complete();

    expect(detach).toHaveBeenCalledTimes(1);
    await controller.done;
  });

  it('detaches even when the detach fn itself throws, and still settles done', async () => {
    const sink = new PassThrough();
    sink.on('error', () => {});
    const controller = createStreamController(sink, noopLog);
    controller.setDetach(() => {
      throw new Error('detach exploded');
    });

    controller.benignAbort('cancel');

    await expect(controller.done).resolves.toBeUndefined();
  });

  it('a fatal DESTROYS the sink and never ends it; a benign cancel ENDS it', async () => {
    const fatalSink = new PassThrough();
    fatalSink.on('error', () => {});
    const fatal = createStreamController(fatalSink, noopLog);
    fatal.fatalAbort(new Error('boom'));
    await expect(fatal.done).rejects.toThrow('boom');
    expect(fatalSink.destroyed).toBe(true);
    expect(fatalSink.writableEnded).toBe(false);

    const benignSink = new PassThrough();
    benignSink.on('error', () => {});
    const benign = createStreamController(benignSink, noopLog);
    benign.benignAbort('cancel');
    await expect(benign.done).resolves.toBeUndefined();
    expect(benignSink.writableEnded).toBe(true);
  });

  it('an unobserved fatal done raises no unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const sink = new PassThrough();
      sink.on('error', () => {});
      const controller = createStreamController(sink, noopLog);
      controller.fatalAbort(new Error('nobody is awaiting this'));

      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('isBenignSocketError - R0-02 origin doctrine', () => {
  it('trusts socket-origin disconnect shapes', () => {
    expect(isBenignSocketError(Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'socket')).toBe(true);
    expect(isBenignSocketError(Object.assign(new Error('x'), { name: 'AbortError' }), 'socket')).toBe(true);
    expect(isBenignSocketError(new Error('socket hang up'), 'socket')).toBe(true);
    expect(isBenignSocketError(new Error('  Aborted  '), 'socket')).toBe(true); // trimmed + case-insensitive
  });

  it('NEVER treats a render-origin error as benign, whatever its shape', () => {
    // The doctrine's whole point: a component can throw an EPIPE-shaped error.
    expect(isBenignSocketError(Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'render')).toBe(false);
    expect(isBenignSocketError(new Error('aborted'), 'render')).toBe(false);
  });

  it('does not match on loose substrings', () => {
    expect(isBenignSocketError(new Error('Payment aborted unexpectedly'), 'socket')).toBe(false);
  });
});
