import vue from '@vitejs/plugin-vue';

import type { PluginOption } from 'vite';

export function pluginVue(opts?: Parameters<typeof vue>[0]): PluginOption {
  return vue(opts);
}
