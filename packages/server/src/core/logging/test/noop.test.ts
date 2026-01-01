import { describe, it, expect } from 'vitest';

import { noopLogger } from '../noop';

describe('noopLogger', () => {
  it('exposes logger methods that are no-ops', () => {
    expect(() => {
      noopLogger.debug({});
      noopLogger.info({});
      noopLogger.warn({});
      noopLogger.error({});
    }).not.toThrow();
  });

  it('returns itself from child()', () => {
    const child = noopLogger.child({ component: 'x' });
    expect(child).toBe(noopLogger);
  });

  it('isDebugEnabled always false', () => {
    expect(noopLogger.isDebugEnabled('routes' as any)).toBe(false);
  });
});
