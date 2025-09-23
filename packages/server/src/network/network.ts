import pc from 'picocolors';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { CONTENT } from '../constants';
import { isPrivateIPv4 } from '../utils/System';
import { normaliseDebug, type DebugConfig } from '../utils/Logger';

type BannerPluginOpts = { debug?: DebugConfig | boolean };

export const bannerPlugin: FastifyPluginAsync<BannerPluginOpts> = async (fastify, options) => {
  const dbg = normaliseDebug(options.debug);

  fastify.decorate('showBanner', function showBanner(this: FastifyInstance) {
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return;

    const { address, port } = addr;
    const boundHost = address === '::1' ? 'localhost' : address === '::' ? '::' : address === '0.0.0.0' ? '0.0.0.0' : address;

    console.log(`┃ Local    ${pc.bold(`http://localhost:${port}/`)}`);

    if (boundHost === 'localhost' || boundHost === '127.0.0.1') {
      console.log('┃ Network  use --host to expose\n');
      return;
    }

    const nets = networkInterfaces();
    let networkAddress: string | null = null;

    for (const ifaces of Object.values(nets)) {
      if (!ifaces) continue;

      for (const iface of ifaces) {
        if (iface.internal || iface.family !== 'IPv4') continue;
        if (isPrivateIPv4(iface.address)) {
          networkAddress = iface.address;
          break;
        }
        if (!networkAddress) networkAddress = iface.address;
      }
      if (networkAddress && isPrivateIPv4(networkAddress)) break;
    }

    if (networkAddress) {
      console.log(`┃ Network  http://${networkAddress}:${port}/\n`);
      if ((dbg as any)?.network || (dbg as any)?.all)
        console.log(pc.yellow(`${CONTENT.TAG} [network] Dev server exposed on network — for local testing only.`));
    }
    console.log(pc.green(`${CONTENT.TAG} [network] Bound to host: ${boundHost}`));
  });

  fastify.addHook('onReady', async function () {
    if (this.server.listening) {
      this.showBanner();
      return;
    }
    this.server.once('listening', () => this.showBanner());
  });
};
