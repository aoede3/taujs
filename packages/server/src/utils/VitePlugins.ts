import type { PluginOption, Plugin } from 'vite';

type PluginInput = PluginOption | PluginOption[] | readonly PluginOption[] | undefined;

function flattenPlugins(input: PluginInput): Plugin[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap(flattenPlugins);

  return [input as Plugin];
}

/**
 * Preserves order: internal first, then app plugins (or flip if you prefer).
 * Best-effort dedupe by plugin.name (keeps first occurrence).
 */
export function mergePlugins(opts: { internal?: PluginInput; apps?: Array<{ plugins?: PluginInput }> }): Plugin[] {
  const internal = flattenPlugins(opts.internal);
  const apps = (opts.apps ?? []).flatMap((a) => flattenPlugins(a.plugins));
  const merged = [...internal, ...apps];
  const seen = new Set<string>();

  return merged.filter((p) => {
    const name = typeof p?.name === 'string' ? p.name : '';

    if (!name) return true; // keep anonymous plugins
    if (seen.has(name)) return false; // drop duplicates
    seen.add(name);

    return true;
  });
}
