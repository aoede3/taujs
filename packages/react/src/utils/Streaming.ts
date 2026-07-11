import type { Writable } from 'node:stream';

export type StreamLogger = {
  log?: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
};

// R0-02: benignity is a property of an error's ORIGIN, never of its message/name/user-set
// properties when it came from render/data code. Classify by origin AND shape.
export type StreamErrSource = 'socket' | 'render';

// Disconnect signals worth trusting on a socket/writable-origin error.
const BENIGN_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED']);
// Exact (case-insensitive, trimmed) node/undici socket messages — NOT loose substrings, so an
// app error whose message merely contains "aborted" is not mistaken for a disconnect.
const BENIGN_SOCKET_MESSAGES = new Set(['aborted', 'socket hang up', 'premature close', 'request aborted']);

export function isBenignStreamErr(err: unknown, source: StreamErrSource): boolean {
  // Render/data-origin errors are never benign by shape: a component can throw
  // `new Error('Payment aborted unexpectedly')` or `Object.assign(new Error(), { code: 'EPIPE' })`.
  // The only benign render outcome is one the controller already knows about (callers check
  // `controller.isAborted` before classifying).
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
  const done = new Promise<void>((r, j) => {
    resolve = () => {
      if (!settled) {
        settled = true;
        r();
      }
    };
    reject = (e) => {
      if (!settled) {
        settled = true;
        j(e);
      }
    };
  });
  return { done, resolve, reject, isSettled: () => settled };
}

export function startShellTimer(ms: number, onTimeout: () => void): () => void {
  const t = setTimeout(onTimeout, ms);

  return () => clearTimeout(t);
}

/** Writable guards (error/close/finish) **/
export type WritableGuards = { cleanup: () => void };

export function wireWritableGuards(
  writable: Writable,
  {
    benignAbort,
    fatalAbort,
    onError,
    onFinish,
  }: {
    benignAbort: (why: string) => void;
    fatalAbort: (err: unknown) => void;
    onError?: (e: unknown) => void;
    onFinish?: () => void;
  },
): WritableGuards {
  const handlers: Array<() => void> = [];
  const add = (ev: string, fn: (...a: any[]) => void) => {
    writable.once(ev, fn);
    handlers.push(() => writable.removeListener(ev, fn));
  };

  add('error', (err) => {
    // These are writable/socket-origin errors (the destination emitted 'error'): classify as
    // 'socket' (R0-02).
    if (isBenignStreamErr(err, 'socket')) {
      benignAbort('Client disconnected during stream');
    } else {
      onError?.(err);
      fatalAbort(err);
    }
  });

  add('close', () => benignAbort('Writable closed early (likely client disconnect)'));

  add('finish', () => {
    if (onFinish) onFinish();
    else benignAbort('Stream finished (normal completion)');
  });

  return {
    cleanup: () => {
      for (const off of handlers) {
        try {
          off();
        } catch {}
      }
    },
  };
}

export type StreamController = {
  // lifecycle setters
  setStreamAbort(fn: () => void): void;
  setStopShellTimer(fn: () => void): void;
  setRemoveAbortListener(fn: () => void): void;
  setGuardsCleanup(fn: () => void): void;

  // termination APIs
  complete(message?: string): void;
  benignAbort(why: string): void;
  fatalAbort(err: unknown): void;

  // state
  readonly done: Promise<void>;
  readonly isAborted: boolean;
};

export function createStreamController(writable: Writable, logger: StreamLogger): StreamController {
  const { log, warn, error } = logger;

  let aborted = false;
  const settle = createSettler();
  // R0-01: pre-attach a no-op rejection handler to `settle.done`. This marks the SAME promise
  // as handled, so an unobserved `done` can never raise `unhandledRejection` (Node's default
  // mode turns that into a process-terminating `uncaughtException`) — while consumers who await
  // `done` still receive the fatal rejection on their own handler. Safe-by-default: the renderer
  // must not hand out a footgun promise (see server call site + `RenderStreamHandle`).
  settle.done.catch(() => {});

  let stopShellTimer: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;
  let guardsCleanup: (() => void) | undefined;
  let streamAbort: (() => void) | undefined;

  const cleanup = (benign: boolean, err?: unknown) => {
    /* v8 ignore next */
    if (aborted) return;
    aborted = true;

    try {
      stopShellTimer?.();
    } catch {}
    try {
      removeAbortListener?.();
    } catch {}
    try {
      guardsCleanup?.();
    } catch {}
    try {
      streamAbort?.();
    } catch {}

    // Ensure writable isn’t left hanging; harmless post-finish due to check
    try {
      if (!writable.writableEnded && !writable.destroyed) writable.destroy();
    } catch {}

    if (benign) settle.resolve();
    else if (err !== undefined) settle.reject(err);
    else settle.resolve();
  };

  return {
    setStreamAbort: (fn) => {
      streamAbort = fn;
    },

    setStopShellTimer: (fn) => {
      stopShellTimer = fn;
    },

    setRemoveAbortListener: (fn) => {
      removeAbortListener = fn;
    },

    setGuardsCleanup: (fn) => {
      guardsCleanup = fn;
    },

    complete(message?: string) {
      if (aborted) return;

      if (message) (log ?? warn)(message);
      cleanup(true);
    },

    benignAbort(why) {
      if (aborted) return;

      warn(why);
      cleanup(true);
    },

    fatalAbort(err) {
      if (aborted) return;

      error('Stream aborted with error:', err);
      cleanup(false, err);
    },

    get done() {
      return settle.done;
    },

    get isAborted() {
      return aborted;
    },
  };
}
