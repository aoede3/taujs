import react from '@vitejs/plugin-react';

import type { PluginOption } from 'vite';

export function pluginReact(opts?: Parameters<typeof react>[0]): PluginOption {
  return react(opts);
}
