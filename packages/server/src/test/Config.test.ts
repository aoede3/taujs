import { describe, it, expect, vi } from 'vitest';

vi.mock('../constants', () => ({
  CONTENT: { TAG: '[τjs]' },
}));

import { defineConfig } from '../Config';

import type { TaujsConfig } from '../Config';

describe('createConfig', () => {
  it('returns the same object when at least one app is present', () => {
    const cfg: TaujsConfig = {
      apps: [{ appId: 'a', entryPoint: '/e' }],
    };
    const out = defineConfig(cfg);
    expect(out).toBe(cfg);
  });

  it('throws if no apps configured', () => {
    const cfg: TaujsConfig = { apps: [] };
    expect(() => defineConfig(cfg as any)).toThrow('At least one app must be configured');
  });
});
