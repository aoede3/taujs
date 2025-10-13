import type { Writable } from 'node:stream';

export type StreamLogger = {
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
};

export const DEFAULT_BENIGN_ERRORS = /ECONNRESET|EPIPE|socket hang up|aborted|premature/i;

export function isBenignStreamErr(err: unknown): boolean {
  const msg = String((err as any)?.message ?? '');

  return DEFAULT_BENIGN_ERRORS.test(msg);
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
    benignErrorPattern = DEFAULT_BENIGN_ERRORS,
  }: {
    benignAbort: (why: string) => void;
    fatalAbort: (err: unknown) => void;
    onError?: (e: unknown) => void;
    benignErrorPattern?: RegExp;
  },
): WritableGuards {
  const handlers: Array<() => void> = [];
  const add = (ev: string, fn: (...a: any[]) => void) => {
    writable.once(ev, fn);
    handlers.push(() => writable.removeListener(ev, fn));
  };

  add('error', (err) => {
    const msg = String((err as any)?.message ?? '');
    if (benignErrorPattern.test(msg)) {
      benignAbort('Client disconnected during stream');
    } else {
      onError?.(err);
      fatalAbort(err);
    }
  });

  add('close', () => benignAbort('Writable closed early (likely client disconnect)'));
  add('finish', () => benignAbort('Stream finished (normal completion)'));

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
  benignAbort(why: string): void;
  fatalAbort(err: unknown): void;

  // state
  readonly done: Promise<void>;
  readonly isAborted: boolean;
};

export function createStreamController(writable: Writable, logger: StreamLogger): StreamController {
  const { warn, error } = logger;

  let aborted = false;
  const settle = createSettler();

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
