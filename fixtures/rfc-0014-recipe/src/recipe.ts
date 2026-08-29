// RFC 0014 §1 - the complexity-budget recipe, compiled VERBATIM (M6) against the PUBLISHED
// @taujs/server API: `@taujs/server` and `@taujs/server/config` resolve through the workspace
// package's own `exports` map to its GENERATED declarations (`dist/*.d.ts`), never to source. It
// must compile with ZERO errors and no `any` - a separately declared `onUpgrade` callback would
// carry implicit `any` parameters otherwise, which a Fastify reviewer would reject on sight.
// Never executed; its only job is to fail `pnpm -r typecheck` if the public surface this RFC adds
// ever stops matching §1. The SAME source is also typechecked against a packed, extracted tarball
// in packages/server/src/test/Rfc0014RecipePack.test.ts, so a broken `files` allow-list or export
// map fails there even if the workspace-linked check above stays green.

import Fastify from 'fastify';

import { createServer } from '@taujs/server';

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TaujsConfig } from '@taujs/server/config';

const app = Fastify();
const config: TaujsConfig = { apps: [], server: { hmrTransport: 'mediated' } };

const tau = await createServer({ fastify: app, config }); // config.server.hmrTransport = 'mediated'

const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
  if (tau.dev.hmr.tryHandleUpgrade(req, socket, head)) return;
  socket.destroy(); // the application decides what happens to upgrades that are not τjs's
};
app.server.on('upgrade', onUpgrade);
app.addHook('onClose', async () => {
  app.server.off('upgrade', onUpgrade);
});
