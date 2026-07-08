/**
 * NOTE:
 * `@vitejs/plugin-react` is a **peer dependency only**.
 *
 * It is intentionally NOT installed as a dependency to avoid
 * coupling τjs to a specific Vite toolchain or React refresh implementation.
 *
 * Consumers using `@taujs/react/plugin` must install `@vitejs/plugin-react`
 * in their own project.
 */
import react from '@vitejs/plugin-react';
import type { Plugin, PluginOption } from 'vite';

function taujsReactPreambleFix(): Plugin {
  return {
    name: 'taujs:react-refresh-preamble-fix',
    apply: 'serve',
    enforce: 'post',
    transformIndexHtml(html) {
      if (html.includes('__vite_plugin_react_preamble_installed__')) return html;

      if (!html.includes('/@react-refresh')) return html;

      return html.replace(
        /<head([^>]*)>/i,
        `<head$1><script>window.__vite_plugin_react_preamble_installed__=true;window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(t)=>t;</script>`,
      );
    },
  };
}

export function pluginReact(opts?: Parameters<typeof react>[0]): PluginOption {
  return [react(opts), taujsReactPreambleFix()];
}
