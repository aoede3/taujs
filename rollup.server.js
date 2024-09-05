import path from 'node:path';
import url from 'node:url';

// import alias from '@rollup/plugin-alias';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export default {
  input: 'dist/server/index.js',
  output: {
    compact: true,
    file: 'dist/server/index.js',
    format: 'esm',
    sourcemap: false,
  },
  plugins: [
    //   // alias({
    //   //   entries: [{ find: '@client', replacement: path.resolve(__dirname, 'dist/client') }],
    //   // }),
    nodeResolve(),
  ],
  external: (id) => id.includes('rollup') || id.includes('node_modules'),
};
