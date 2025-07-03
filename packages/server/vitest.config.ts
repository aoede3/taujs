import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [...configDefaults.exclude, '**/index.ts/**', '**/*.d.ts/**', '**/*test*/**'],
      reporter: ['html'],
    },
    environment: 'jsdom',
    server: {
      deps: {
        inline: ['esbuild'],
      },
    },
  },
});
