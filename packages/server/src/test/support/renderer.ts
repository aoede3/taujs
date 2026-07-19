import type { ManagedContributionShape } from '../../utils/ManagedPlugins';
import type { TaujsRendererContribution } from '../../utils/RendererContract';

// A minimal, structurally-valid renderer contribution for tests that just need the required field.
export function testRenderer(opts: { key?: string; managedCompilation?: boolean; compiler?: unknown } = {}): TaujsRendererContribution {
  return {
    brand: 'taujs.renderer-contribution/v1',
    key: opts.key ?? 'test',
    contractVersion: 'v1',
    managedCompilation: opts.managedCompilation ?? false,
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
    compiler: managed,
  } as unknown as TaujsRendererContribution;
}

const RENDER_CONTRACT_TAG = Symbol.for('taujs.render-contract/v1');
// Brand render-fn doubles so the host's assertRenderContract accepts them (renderer v1: every render module
// is validated). Pass your existing renderSSR/renderStream doubles (their behaviour is preserved) or omit
// for trivial ones. The brand key MUST equal the app's declared `renderer` key (assertRenderContract checks
// key identity) - pair `testRenderer({ key })` with `brandedRenderModule(key, ...)`.
export function brandedRenderModule(key: string, mod: { renderSSR?: any; renderStream?: any } = {}) {
  const brand = <F extends object>(fn: F): F => {
    Object.defineProperty(fn, RENDER_CONTRACT_TAG, { value: { key, contractVersion: 'v1' }, enumerable: false });
    return fn;
  };
  const renderSSR = brand(mod.renderSSR ?? (async () => ({ headContent: '', appHtml: '' })));
  const renderStream = brand(mod.renderStream ?? (() => ({ abort() {}, done: Promise.resolve() })));
  return { renderSSR, renderStream };
}
