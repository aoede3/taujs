import type { Logs } from './types';

export const noopLogger: Logs = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  isDebugEnabled: () => false,
};
