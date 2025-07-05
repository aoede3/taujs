import { describe, it, expect, vi } from 'vitest';

vi.mock('@vitejs/plugin-react', () => ({
  default: vi.fn(),
}));

import { pluginReact } from '../plugin';
import react from '@vitejs/plugin-react';

describe('pluginReact', () => {
  it('calls @vitejs/plugin-react with no options when none are passed', () => {
    const mockReturn = { name: 'mock-plugin' };
    (react as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockReturn);

    const result = pluginReact();

    expect(react).toHaveBeenCalledWith(undefined);
    expect(result).toBe(mockReturn);
  });

  it('calls @vitejs/plugin-react with the given options', () => {
    const mockReturn = { name: 'plugin-with-options' };
    const opts: { jsxRuntime: 'automatic' | 'classic' } = { jsxRuntime: 'automatic' };
    (react as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockReturn);

    const result = pluginReact(opts);

    expect(react).toHaveBeenCalledWith(opts);
    expect(result).toBe(mockReturn);
  });
});
