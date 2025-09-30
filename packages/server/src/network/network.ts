import pc from 'picocolors';
import { networkInterfaces } from 'node:os';

import { CONTENT } from '../constants';
import { Logger } from '../utils/Logger';
import { isPrivateIPv4 } from '../utils/System';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { DebugConfig } from '../utils/Logger';

type BannerPluginOpts = { debug?: DebugConfig | boolean };

export const bannerPlugin: FastifyPluginAsync<BannerPluginOpts> = async (fastify, options) => {
  const logger = new Logger();
  if (options.debug !== undefined) {
    // Accepts: boolean | DebugCategory[] | { all?: boolean, [cat]: boolean }
    logger.configure(options.debug);
  }
  const dbgNetwork = logger.isDebugEnabled('network');

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
      if (dbgNetwork) {
        logger.warn(pc.yellow(`${CONTENT.TAG} [network] Dev server exposed on network — for local testing only.`));
      }
    }

    logger.info(pc.green(`${CONTENT.TAG} [network] Bound to host: ${boundHost}`));
  });

  fastify.addHook('onReady', async function () {
    if (this.server.listening) {
      this.showBanner();
      return;
    }
    this.server.once('listening', () => this.showBanner());
  });
};
