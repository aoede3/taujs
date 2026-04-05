import { defineService, defineServiceRegistry } from '../../../Config';

import type { ServiceContext, TypedServiceContext } from '../../../Config';

declare module '../../../Config' {
  interface ServiceContext {
    tenantId?: string;
  }
}

const marketService = defineService({
  getItem: async (params: { id: string }) => ({
    item: {
      id: params.id,
      title: 'Sample item',
    },
  }),
});

type AuthDependencies = {
  market: typeof marketService;
};

const authService = defineService({
  login: async (params: { email: string; password: string }, ctx: TypedServiceContext<AuthDependencies>) => {
    const tenantId: string | undefined = ctx.tenantId;
    void tenantId;

    if (!ctx.call) {
      throw new Error('call unavailable');
    }

    const item = await ctx.call('market', 'getItem', { id: params.email });

    // @ts-expect-error method names should be narrowed by service
    await ctx.call('market', 'login', { id: params.email });

    // @ts-expect-error args should be checked per method
    await ctx.call('market', 'getItem', { slug: params.email });

    return {
      user: {
        id: item.item.id,
        role: params.password.length > 0 ? 'member' : 'guest',
      },
    };
  },
});

const serviceRegistry = defineServiceRegistry({
  auth: authService,
  market: marketService,
});

declare const serviceCtx: ServiceContext;
declare const typedCtx: TypedServiceContext<typeof serviceRegistry>;

if (serviceCtx.tenantId) {
  const tenantId: string = serviceCtx.tenantId;
  void tenantId;
}

if (typedCtx.call) {
  const marketResult: Promise<{ item: { id: string; title: string } }> = typedCtx.call('market', 'getItem', { id: 'sku_123' });
  const loginResult: Promise<{ user: { id: string; role: string } }> = typedCtx.call('auth', 'login', {
    email: 'user@example.com',
    password: 'secret',
  });

  void marketResult;
  void loginResult;

  // @ts-expect-error service names should be narrowed
  typedCtx.call('missing', 'getItem', { id: 'sku_123' });

  // @ts-expect-error method names should be narrowed by service
  typedCtx.call('market', 'login', { id: 'sku_123' });

  // @ts-expect-error args should be checked per method
  typedCtx.call('auth', 'login', { email: 'user@example.com' });
}

void serviceRegistry;
