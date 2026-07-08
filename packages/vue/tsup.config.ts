import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entryPoints: ['src/index.ts', 'src/plugin.ts'],
  external: ['vue', '@vue/server-renderer', 'vite', '@vitejs/plugin-vue'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
