import { describe, it, expect, beforeEach, vi } from 'vitest';

// @vitejs/plugin-vue is a peer dependency; mock it so the passthrough is testable without
// invoking the real plugin. (Vue's pluginVue has no react-refresh-preamble equivalent, so
// this mirrors @taujs/react's plugin test minus those cases.)
vi.mock('@vitejs/plugin-vue', () => ({
  default: vi.fn(),
}));

import vue from '@vitejs/plugin-vue';
import { pluginVue } from '../plugin';

type VueMock = ReturnType<typeof vi.fn>;

describe('pluginVue', () => {
  beforeEach(() => {
    (vue as unknown as VueMock).mockReset();
  });

  it('calls @vitejs/plugin-vue with undefined when no options are passed and returns its result', () => {
    const mockVuePlugin = { name: 'mock-vue-plugin' };
    (vue as unknown as VueMock).mockReturnValue(mockVuePlugin);

    const result = pluginVue();

    expect(vue).toHaveBeenCalledTimes(1);
    expect(vue).toHaveBeenCalledWith(undefined);
    expect(result).toBe(mockVuePlugin);
  });

  it('forwards the given options to @vitejs/plugin-vue and returns its result', () => {
    const mockVuePlugin = { name: 'mock-vue-plugin-with-options' };
    const opts = { include: [/\.vue$/] };
    (vue as unknown as VueMock).mockReturnValue(mockVuePlugin);

    const result = pluginVue(opts);

    expect(vue).toHaveBeenCalledTimes(1);
    expect(vue).toHaveBeenCalledWith(opts);
    expect(result).toBe(mockVuePlugin);
  });
});
