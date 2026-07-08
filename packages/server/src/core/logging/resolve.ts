import { noopLogger } from './noop';

import type { Logs } from './types';

export const resolveLogs = (logger?: Logs): Logs => logger ?? noopLogger;
