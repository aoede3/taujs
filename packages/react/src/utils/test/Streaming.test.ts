import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  DEFAULT_BENIGN_ERRORS,
  isBenignStreamErr,
  createSettler,
  startShellTimer,
  wireWritableGuards,
  createStreamController,
  type StreamLogger,
} from '../Streaming';

function makeWritableMock() {
  const events = new Map<string, Set<Function>>();
  let throwOnNextRemove = false;

  const findRegistered = (ev: string, fn: Function) => {
    const set = events.get(ev);
    if (!set) return undefined;
    for (const l of set) {
      if (l === fn || (l as any).listener === fn) return l;
    }
    return undefined;
  };

  const writable: any = {
    writableEnded: false,
    destroyed: false,
    _destroyCalls: 0,

    once(ev: string, fn: Function) {
      const wrapper = (...args: any[]) => {
        try {
          fn(...args);
        } finally {
          writable.removeListener(ev, fn); // remove by original, Node-style
        }
      };
      (wrapper as any).listener = fn; // important: emulate Node
      if (!events.has(ev)) events.set(ev, new Set());
      events.get(ev)!.add(wrapper);
      return writable;
    },

    removeListener(ev: string, fn: Function) {
      const l = findRegistered(ev, fn);
      if (l) {
        events.get(ev)!.delete(l);
      }
      if (throwOnNextRemove) {
        throwOnNextRemove = false;
        // throw **after** removing so we still end up with no dangling listeners
        throw new Error('removeListener boom');
      }
      return writable;
    },

    emit(ev: string, ...args: any[]) {
      const set = events.get(ev);
      if (!set) return false;
      // copy so handlers can remove themselves safely
      [...set].forEach((fn) => fn(...args));
      return true;
    },

    destroy() {
      writable.destroyed = true;
      writable._destroyCalls++;
    },

    setThrowOnFirstRemove() {
      throwOnNextRemove = true;
    },
  };

  return writable as import('node:stream').Writable & {
    emit: (ev: string, ...args: any[]) => boolean;
    setThrowOnFirstRemove: () => void;
    _destroyCalls: number;
    writableEnded: boolean;
    destroyed: boolean;
  };
}

const logger: StreamLogger = {
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('isBenignStreamErr / DEFAULT_BENIGN_ERRORS', () => {
  it('matches known benign patterns', () => {
    const msgs = ['ECONNRESET', 'EPIPE', 'socket hang up', 'aborted', 'premature close'];
    for (const m of msgs) {
      expect(DEFAULT_BENIGN_ERRORS.test(m)).toBe(true);
      expect(isBenignStreamErr(new Error(m))).toBe(true);
    }
  });

  it('non-matching errors are not benign', () => {
    expect(isBenignStreamErr(new Error('boom'))).toBe(false);
    expect(isBenignStreamErr({ message: 'other' })).toBe(false);
    expect(isBenignStreamErr({})).toBe(false);
  });
});

describe('createSettler', () => {
  it('resolves once and ignores subsequent resolve/reject', async () => {
    const s = createSettler();
    s.resolve();
    s.resolve(); // ignored
    s.reject(new Error('later')); // ignored
    await expect(s.done).resolves.toBeUndefined();
    expect(s.isSettled()).toBe(true);
  });

  it('rejects once and ignores subsequent resolve/reject', async () => {
    const s = createSettler();
    const err = new Error('first');
    s.reject(err);
    s.resolve(); // ignored
    await expect(s.done).rejects.toBe(err);
    expect(s.isSettled()).toBe(true);
  });
});

describe('startShellTimer', () => {
  it('calls onTimeout only when not cancelled', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const cancel = startShellTimer(100, cb);
    vi.advanceTimersByTime(50);
    expect(cb).not.toHaveBeenCalled();
    cancel();
    vi.advanceTimersByTime(100);
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires after duration if not cancelled', () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    startShellTimer(100, cb);
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('wireWritableGuards', () => {
  it('benign error triggers benignAbort', () => {
    const w = makeWritableMock();
    const benignAbort = vi.fn();
    const fatalAbort = vi.fn();
    const onError = vi.fn();

    wireWritableGuards(w, { benignAbort, fatalAbort, onError });
    w.emit('error', new Error('socket hang up'));

    expect(benignAbort).toHaveBeenCalledWith('Client disconnected during stream');
    expect(fatalAbort).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('non-benign error triggers onError and fatalAbort', () => {
    const w = makeWritableMock();
    const benignAbort = vi.fn();
    const fatalAbort = vi.fn();
    const onError = vi.fn();
    wireWritableGuards(w, { benignAbort, fatalAbort, onError });

    const err = new Error('boom');
    w.emit('error', err);

    expect(onError).toHaveBeenCalledWith(err);
    expect(fatalAbort).toHaveBeenCalledWith(err);
    expect(benignAbort).not.toHaveBeenCalled();
  });

  it('close and finish are treated as benign', () => {
    const w = makeWritableMock();
    const benignAbort = vi.fn();
    const fatalAbort = vi.fn();
    wireWritableGuards(w, { benignAbort, fatalAbort });

    w.emit('close');
    w.emit('finish');

    expect(benignAbort).toHaveBeenCalledTimes(2);
    expect(fatalAbort).not.toHaveBeenCalled();
  });

  it('cleanup removes listeners and swallows removeListener errors', () => {
    const w = makeWritableMock();
    const benignAbort = vi.fn();
    const fatalAbort = vi.fn();

    const { cleanup } = wireWritableGuards(w, { benignAbort, fatalAbort });
    const { cleanup: cleanup2 } = wireWritableGuards(w, { benignAbort, fatalAbort });

    // Force one removeListener() to throw but, still remove handler
    w.setThrowOnFirstRemove();

    expect(() => cleanup()).not.toThrow(); // try/catch path
    expect(() => cleanup2()).not.toThrow(); // normal path

    // After cleanup, nothing should fire
    w.emit('error', new Error('socket hang up'));
    w.emit('close');
    w.emit('finish');

    expect(benignAbort).not.toHaveBeenCalled();
    expect(fatalAbort).not.toHaveBeenCalled();
  });

  it('calls onFinish when provided and does not call benignAbort', () => {
    const w = makeWritableMock();
    const benignAbort = vi.fn();
    const fatalAbort = vi.fn();
    const onFinish = vi.fn();

    wireWritableGuards(w, { benignAbort, fatalAbort, onFinish });

    // simulate normal completion
    w.emit('finish');

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(benignAbort).not.toHaveBeenCalled();
    expect(fatalAbort).not.toHaveBeenCalled();
  });
});

describe('createStreamController', () => {
  it('benignAbort: logs warn, runs cleanups, destroys if needed, resolves done, idempotent', async () => {
    const w = makeWritableMock();
    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');

    const c = createStreamController(w, logger);

    const stopShellTimer = vi.fn();
    const removeAbortListener = vi.fn();
    const guardsCleanup = vi.fn();
    const streamAbort = vi.fn();

    c.setStopShellTimer(stopShellTimer);
    c.setRemoveAbortListener(removeAbortListener);
    c.setGuardsCleanup(guardsCleanup);
    c.setStreamAbort(streamAbort);

    c.benignAbort('because nice');
    expect(c.isAborted).toBe(true);

    // idempotent: second call does nothing extra
    c.benignAbort('again');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    expect(stopShellTimer).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(guardsCleanup).toHaveBeenCalledTimes(1);
    expect(streamAbort).toHaveBeenCalledTimes(1);

    expect(w._destroyCalls).toBe(1);

    await expect(c.done).resolves.toBeUndefined();
  });

  it('fatalAbort: logs error, runs cleanups, destroys if needed, rejects done', async () => {
    const w = makeWritableMock();
    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');

    const c = createStreamController(w, logger);

    const stopShellTimer = vi.fn();
    const removeAbortListener = vi.fn();
    const guardsCleanup = vi.fn();
    const streamAbort = vi.fn();

    c.setStopShellTimer(stopShellTimer);
    c.setRemoveAbortListener(removeAbortListener);
    c.setGuardsCleanup(guardsCleanup);
    c.setStreamAbort(streamAbort);

    const err = new Error('kaboom');
    c.fatalAbort(err);

    expect(c.isAborted).toBe(true);
    expect(error).toHaveBeenCalledWith('Stream aborted with error:', err);
    expect(warn).not.toHaveBeenCalled();

    expect(stopShellTimer).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(guardsCleanup).toHaveBeenCalledTimes(1);
    expect(streamAbort).toHaveBeenCalledTimes(1);
    expect(w._destroyCalls).toBe(1);

    await expect(c.done).rejects.toBe(err);
  });

  it('does not destroy if already ended', async () => {
    const w = makeWritableMock();
    w.writableEnded = true;
    const c = createStreamController(w, logger);
    c.benignAbort('normal end');
    await expect(c.done).resolves.toBeUndefined();
    expect(w._destroyCalls).toBe(0);
  });

  it('does not destroy if already destroyed', async () => {
    const w = makeWritableMock();
    w.destroyed = true;
    const c = createStreamController(w, logger);
    c.benignAbort('already destroyed');
    await expect(c.done).resolves.toBeUndefined();
    expect(w._destroyCalls).toBe(0);
  });

  it("non-message error goes through onError+fatalAbort (err?.message ?? '')", () => {
    const w = makeWritableMock();
    const benignAbort = vi.fn();
    const fatalAbort = vi.fn();
    const onError = vi.fn();

    wireWritableGuards(w, { benignAbort, fatalAbort, onError });

    // err without .message -> empty string -> not benign
    const err = {} as any;
    w.emit('error', err);

    expect(onError).toHaveBeenCalledWith(err);
    expect(fatalAbort).toHaveBeenCalledWith(err);
    expect(benignAbort).not.toHaveBeenCalled();
  });

  it('cleanup swallows exceptions from all hooks and destroy()', async () => {
    const w = makeWritableMock();
    // Make destroy throw; we still want to know it was called
    const destroyCall = vi.spyOn(w, 'destroy').mockImplementation(() => {
      throw new Error('destroy boom');
    });

    const c = createStreamController(w, logger);

    const stopShellTimer = vi.fn(() => {
      throw new Error('stop boom');
    });
    const removeAbortListener = vi.fn(() => {
      throw new Error('remove boom');
    });
    const guardsCleanup = vi.fn(() => {
      throw new Error('guards boom');
    });
    const streamAbort = vi.fn(() => {
      throw new Error('abort boom');
    });

    c.setStopShellTimer(stopShellTimer);
    c.setRemoveAbortListener(removeAbortListener);
    c.setGuardsCleanup(guardsCleanup);
    c.setStreamAbort(streamAbort);

    // Should not throw; should still resolve
    c.benignAbort('cleanup throws ok');

    await expect(c.done).resolves.toBeUndefined();
    expect(c.isAborted).toBe(true);

    expect(stopShellTimer).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(guardsCleanup).toHaveBeenCalledTimes(1);
    expect(streamAbort).toHaveBeenCalledTimes(1);
    expect(destroyCall).toHaveBeenCalledTimes(1);
  });

  it('fatalAbort(undefined) resolves (covers "else settle.resolve()")', async () => {
    const w = makeWritableMock();
    const errorSpy = vi.spyOn(logger, 'error');

    const c = createStreamController(w, logger);
    c.fatalAbort(undefined as any); // err is undefined

    // Should resolve, not reject
    await expect(c.done).resolves.toBeUndefined();
    expect(c.isAborted).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('Stream aborted with error:', undefined);
  });

  it('fatalAbort is a no-op after already aborted (early return)', async () => {
    const w = makeWritableMock();
    const errorSpy = vi.spyOn(logger, 'error');

    const c = createStreamController(w, logger);
    c.benignAbort('first'); // aborts & resolves
    await expect(c.done).resolves.toBeUndefined();

    // Second call should early-return and NOT log again
    c.fatalAbort(new Error('later'));
    expect(errorSpy).not.toHaveBeenCalled(); // none during fatal path
  });

  it('logs optional message via log when available, runs cleanups, resolves', async () => {
    const w = makeWritableMock();

    const log = vi.fn(); // provide log to exercise (log ?? warn)
    const warn = vi.fn();
    const error = vi.fn();
    const c = createStreamController(w, { log, warn, error });

    const stopShellTimer = vi.fn();
    const removeAbortListener = vi.fn();
    const guardsCleanup = vi.fn();
    const streamAbort = vi.fn();

    c.setStopShellTimer(stopShellTimer);
    c.setRemoveAbortListener(removeAbortListener);
    c.setGuardsCleanup(guardsCleanup);
    c.setStreamAbort(streamAbort);

    c.complete('all good');

    // completed + logged via log (not warn)
    expect(c.isAborted).toBe(true);
    expect(log).toHaveBeenCalledWith('all good');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    // cleanups + destroy
    expect(stopShellTimer).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(guardsCleanup).toHaveBeenCalledTimes(1);
    expect(streamAbort).toHaveBeenCalledTimes(1);
    expect(w._destroyCalls).toBe(1);

    await expect(c.done).resolves.toBeUndefined();

    // idempotent: calling again does nothing
    log.mockClear();
    c.complete('ignored');
    expect(log).not.toHaveBeenCalled();
  });

  it('falls back to warn when log is undefined', async () => {
    const w = makeWritableMock();

    // omit log to hit (log ?? warn)
    const warn = vi.fn();
    const error = vi.fn();
    const c = createStreamController(w, { warn, error });

    c.complete('fallback warn');
    expect(warn).toHaveBeenCalledWith('fallback warn');
    expect(error).not.toHaveBeenCalled();
    await expect(c.done).resolves.toBeUndefined();
  });

  it('is a no-op if already aborted', async () => {
    const w = makeWritableMock();
    const log = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const c = createStreamController(w, { log, warn, error });

    c.benignAbort('first'); // aborts
    await expect(c.done).resolves.toBeUndefined();

    log.mockClear();
    warn.mockClear();
    error.mockClear();

    // Now complete should NO-OP
    c.complete('should not log');
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
