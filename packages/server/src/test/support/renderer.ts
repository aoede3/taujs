import type { ManagedContributionShape } from '../../utils/ManagedPlugins';
import type { TaujsRendererContribution } from '../../utils/RendererContract';

// A minimal, structurally-valid renderer contribution for tests that just need the required field.
export function testRenderer(opts: { key?: string; managedCompilation?: boolean; expectsModule?: boolean; compiler?: unknown } = {}): TaujsRendererContribution {
  return {
    brand: 'taujs.renderer-contribution/v1',
    key: opts.key ?? 'test',
    contractVersion: 'v1',
    managedCompilation: opts.managedCompilation ?? false,
    expectsModule: opts.expectsModule ?? false,
    ...(opts.compiler ? { compiler: opts.compiler } : {}),
  } as unknown as TaujsRendererContribution;
}

// Wrap an ESC-1 managed compiler contribution as a renderer contribution (managedCompilation:true).
export function rendererFromManaged(managed: ManagedContributionShape): TaujsRendererContribution {
  return {
    brand: 'taujs.renderer-contribution/v1',
    key: managed.key,
    contractVersion: 'v1',
    managedCompilation: true,
    expectsModule: false,
    compiler: managed,
  } as unknown as TaujsRendererContribution;
}
