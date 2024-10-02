type Logger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export const createLogger = (debug: boolean): Logger => ({
  log: (...args: unknown[]) => {
    if (debug) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (debug) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (debug) console.error(...args);
  },
});
