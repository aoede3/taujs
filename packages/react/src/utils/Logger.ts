export type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createLogger(debug: boolean, custom?: Partial<Logger>): Logger {
  return {
    log: (...args: unknown[]) => {
      if (debug) (custom?.log ?? console.log)(...args);
    },

    warn: (...args: unknown[]) => {
      (custom?.warn ?? console.warn)(...args);
    },

    error: (...args: unknown[]) => {
      (custom?.error ?? console.error)(...args);
    },
  };
}

// export const createLogger = (debug: boolean): Logger => ({
//   log: (...args: unknown[]) => {
//     if (debug) console.log(...args);
//   },
//   warn: (...args: unknown[]) => {
//     if (debug) console.warn(...args);
//   },
//   error: (...args: unknown[]) => {
//     if (debug) console.error(...args);
//   },
// });
