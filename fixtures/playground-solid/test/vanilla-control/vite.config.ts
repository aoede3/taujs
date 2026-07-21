import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite';

// The SAME compiler configuration τjs's managed compilation uses: `ssr: true`. Nothing else, so
// the control shares the playground's bootstrap and hydration codegen and differs only by the
// absence of τjs. The driver in `../vanilla-control.test.ts` supplies root/outDir/input.
export default defineConfig({
  plugins: [solid({ ssr: true })],
});
