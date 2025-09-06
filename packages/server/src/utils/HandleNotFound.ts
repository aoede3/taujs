import type { FastifyRequest, FastifyReply } from 'fastify';

import { SSRTAG } from '../constants';
import { ensureNonNull } from './Templates';
import { isDevelopment } from './System';

import type { ProcessedConfig } from '../types';

export const handleNotFound = async (
  req: FastifyRequest,
  reply: FastifyReply,
  processedConfigs: ProcessedConfig[],
  maps: {
    cssLinks: Map<string, string>;
    bootstrapModules: Map<string, string>;
    templates: Map<string, string>;
  },
) => {
  if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

  try {
    const defaultConfig = processedConfigs[0];
    if (!defaultConfig) throw new Error('No default configuration found.');

    const { clientRoot } = defaultConfig;
    const cspNonce = req.cspNonce;

    let template = ensureNonNull(maps.templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

    const cssLink = maps.cssLinks.get(clientRoot);
    const bootstrapModule = maps.bootstrapModules.get(clientRoot);

    template = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');
    if (!isDevelopment && cssLink) template = template.replace('</head>', `${cssLink}</head>`);
    if (bootstrapModule) template = template.replace('</body>', `<script nonce="${cspNonce}" type="module" src="${bootstrapModule}" defer></script></body>`);

    reply.status(200).type('text/html').send(template);
  } catch (error) {
    console.error('Failed to serve clientHtmlTemplate:', error);
    reply.status(500).send('Internal Server Error');
  }
};
