/**
 * Child-process development boot for the product-path cell (`test/dev-product-path.test.ts`).
 *
 * `@taujs/server` snapshots `NODE_ENV` at import (`System.ts`) and the fixture's Vitest process runs
 * without it, so the REAL development path cannot be entered in-process. This script is that path:
 * plain ESM JavaScript run by `node` with `NODE_ENV=development`, from the FIXTURE directory (so bare
 * specifiers such as `@taujs/server` resolve through the fixture's own `node_modules`), pointed at a
 * client root the test scaffolded.
 *
 * It scaffolds nothing. Argument 1 is the client root, argument 2 the declaration order. It prints
 * `TAUJS_DEV_URL <url>` on stdout once listening and stays up until SIGTERM.
 */
import { createServer } from '@taujs/server';
import { reactRenderer } from '@taujs/react/renderer';
import { vueRenderer } from '@taujs/vue/renderer';

const [clientRoot, order] = process.argv.slice(2);

const reactApp = {
  appId: 'web',
  entryPoint: 'web',
  renderer: reactRenderer({ project: 'tsconfig.react.json' }),
  routes: [{ path: '/react', attr: { render: 'ssr' } }],
};
const vueApp = {
  appId: 'shop',
  entryPoint: 'shop',
  renderer: vueRenderer(),
  routes: [{ path: '/vue', attr: { render: 'ssr' } }],
};

const { app } = await createServer({
  config: { server: { host: '127.0.0.1', port: 0 }, apps: order === 'react-first' ? [reactApp, vueApp] : [vueApp, reactApp] },
  clientRoot,
  projectRoot: clientRoot,
  port: 0,
});

await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
console.log(`TAUJS_DEV_URL http://127.0.0.1:${address.port}`);

process.on('SIGTERM', () => {
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
