import type { Writable } from 'node:stream';

import type { LogFns } from './Logger.js';

/**
 * Solid's stream controller. Deliberately NOT a drift-copy of `@taujs/react/src/utils/Streaming.ts`
 * (see `test/UtilsDrift.test.ts`). The POLICY for socket-origin classification is shared - R0-02's
 * origin doctrine, which is about Node socket error shapes and is genuinely framework-neutral - but
 * the controller's terminal semantics follow the ruled SOLID matrix (design 2), which differs from
 * React's in four ways that byte-identity would silently erase:
 *
 *   1. A seroval SERIALISATION FAILURE is FATAL infrastructure/delivery failure (design 2, R3).
 *      React has no equivalent channel at all.
 *   2. A post-shell fatality must DESTROY the sink and must NEVER call `end()` - ending it would
 *      let the host serialise `__INITIAL_DATA__` and report a truncated document as success.
 *   3. Every terminal must DETACH τjs-owned request state exactly once (M1). Solid exposes no
 *      dispose seam, so this is the only release mechanism.
 *   4. Solid never emits `onRenderError`, so there is no advisory channel to route.
 */

// R0-02: benignity is a property of an error's ORIGIN, never of its message/name/user-set
// properties when it came from render/data code. Classify by origin AND shape.
export type StreamErrSource = 'socket' | 'render';

// Disconnect signals worth trusting on a socket/writable-origin error.
const BENIGN_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED']);
// Exact (case-insensitive, trimmed) node/undici socket messages - NOT loose substrings, so an
// app error whose message merely contains "aborted" is not mistaken for a disconnect.
const BENIGN_SOCKET_MESSAGES = new Set(['aborted', 'socket hang up', 'premature close', 'request aborted']);

/**
 * Matrix row #7b: benign cancellation ONLY on actual socket state. Row #7a is the complement -
 * a render-origin sink failure is FATAL and is never benign by shape, because a component can
 * throw `Object.assign(new Error(), { code: 'EPIPE' })`.
 */
export function isBenignSocketError(err: unknown, source: StreamErrSource): boolean {
  if (source !== 'socket') return false;

  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.code === 'string' && BENIGN_SOCKET_CODES.has(e.code)) return true;
  if (e?.name === 'AbortError') return true;

  return BENIGN_SOCKET_MESSAGES.has(
    String(e?.message ?? '')
      .trim()
      .toLowerCase(),
  );
}

export type Settler = {
  done: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
  isSettled: () => boolean;
};

export function createSettler(): Settler {
  let settled = false;
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolve = () => {
      if (!settled) {
        settled = true;
        res();
      }
    };
    reject = (e) => {
      if (!settled) {
        settled = true;
        rej(e);
      }
    };
  });

  return { done, resolve, reject, isSettled: () => settled };
}

export function startTimer(ms: number, onExpiry: () => void): () => void {
  // Only arm for finite positive values; 0/Infinity mean "no bound" by documented convention.
  if (!(Number.isFinite(ms) && ms > 0)) return () => {};
  const t = setTimeout(onExpiry, ms);

  return () => clearTimeout(t);
}

export type StreamController = {
  /** Register cleanup that must run exactly once on ANY terminal. */
  addCleanup(fn: () => void): void;
  /** M1: release τjs-owned request state. Runs exactly once, on every terminal. */
  setDetach(fn: () => void): void;

  /** The shell has been committed (Solid's `onCompleteShell` + head emitted). */
  markShellCommitted(): void;

  /** Normal completion: the sink has already been ended by the adapter. Resolves `done`. */
  complete(message?: string): void;
  /** Benign cancel (caller abort / socket disconnect): ends the sink, resolves `done`. */
  benignAbort(why: string): void;
  /**
   * FATAL. Rejects `done` and tears the response down. Pre-shell the sink was never committed;
   * post-shell it is DESTROYED and never ended, so a truncated document can never be reported as
   * a successful delivery.
   */
  fatalAbort(err: unknown): void;

  readonly done: Promise<void>;
  /** The terminal guard (design 2). Every adapter callback and sink op consults this. */
  readonly terminated: boolean;
  readonly shellCommitted: boolean;
};

export function createStreamController(writable: Writable, logger: LogFns): StreamController {
  const { log, warn, error } = logger;

  let terminated = false;
  let shellCommitted = false;
  let detached = false;

  const settle = createSettler();
  // Pre-attach a no-op rejection handler to the SAME promise, so an unobserved `done` can never
  // raise `unhandledRejection` (Node's default mode turns that into a process-terminating
  // `uncaughtException`) while consumers who await `done` still receive the fatal error.
  settle.done.catch(() => {});

  const cleanups: Array<() => void> = [];
  let detach: (() => void) | undefined;

  const runDetach = () => {
    // M1: exactly once, on every terminal, whatever the terminal was.
    if (detached) return;
    detached = true;
    try {
      detach?.();
    } catch {}
  };

  const runCleanups = () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {}
    }
    cleanups.length = 0;
  };

  const terminate = (mode: 'complete' | 'benign' | 'fatal', err?: unknown) => {
    if (terminated) return;
    terminated = true;

    runCleanups();
    runDetach();

    try {
      if (mode === 'fatal') {
        // Never `end()` here. Ending a committed stream lets the host's finish listener serialise
        // `__INITIAL_DATA__` and present an incomplete document as a success - the FATAL-EMPTY
        // defect the B2R review ruled out. Destroy instead.
        if (!writable.destroyed) writable.destroy();
      } else if (mode === 'benign') {
        if (!writable.writableEnded && !writable.destroyed) writable.end();
      }
      // 'complete': the adapter already ended the sink in its deferred-end path.
    } catch {}

    if (mode === 'fatal') settle.reject(err);
    else settle.resolve();
  };

  return {
    addCleanup(fn) {
      cleanups.push(fn);
    },

    setDetach(fn) {
      detach = fn;
    },

    markShellCommitted() {
      shellCommitted = true;
    },

    complete(message) {
      if (terminated) return;
      try {
        if (message) log(message);
      } catch {}
      terminate('complete');
    },

    benignAbort(why) {
      if (terminated) return;
      try {
        warn(why);
      } catch {}
      terminate('benign');
    },

    fatalAbort(err) {
      if (terminated) return;
      try {
        error('Stream aborted with error', err);
      } catch {}
      terminate('fatal', err);
    },

    get done() {
      return settle.done;
    },
    get terminated() {
      return terminated;
    },
    get shellCommitted() {
      return shellCommitted;
    },
  };
}

/** Writable guards. Matrix rows #7a (render origin -> FATAL) and #7b (socket origin -> benign). */
export function wireWritableGuards(
  writable: Writable,
  handlers: { benignAbort: (why: string) => void; fatalAbort: (err: unknown) => void },
): { cleanup: () => void } {
  const registered: Array<() => void> = [];
  const add = (event: string, fn: (...args: never[]) => void) => {
    writable.once(event, fn as (...args: unknown[]) => void);
    registered.push(() => {
      try {
        writable.removeListener(event, fn as (...args: unknown[]) => void);
      } catch {}
    });
  };

  add('error', ((err: unknown) => {
    // The destination emitted 'error', so this IS socket-origin by construction.
    if (isBenignSocketError(err, 'socket')) handlers.benignAbort('Client disconnected during stream');
    else handlers.fatalAbort(err);
  }) as never);

  add('close', (() => handlers.benignAbort('Writable closed early (likely client disconnect)')) as never);

  return {
    cleanup: () => {
      for (const off of registered) off();
      registered.length = 0;
    },
  };
}
