import { describe, it, expect } from 'vitest';

import { noopLogger } from '../noop';
import { resolveLogs } from '../resolve';

import type { Logs } from '../types';

describe('resolveLogs', () => {
  it('returns provided logger when supplied', () => {
    let provided!: Logs;
    provided = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => provided,
      isDebugEnabled: () => true,
    };

    expect(resolveLogs(provided)).toBe(provided);
  });

  it('falls back to noopLogger when logger is undefined', () => {
    expect(resolveLogs()).toBe(noopLogger);
  });

  it('falls back to noopLogger when logger is null', () => {
    expect(resolveLogs(null as unknown as Logs)).toBe(noopLogger);
  });
});
