/**
 * τjs [ taujs ] Orchestration System
 * (c) 2024-present Aoede Ltd
 * Author: John Smith
 *
 * Licensed under the MIT License - attribution appreciated.
 * Part of the τjs [ taujs ] system for declarative, build-time orchestration of microfrontend applications,
 * including CSR, SSR, streaming, and middleware composition.
 */

import path from 'node:path';

export type AliasMap = Record<string, string>;

/**
 * RFC 0005 Amended contract §3 (VS5) - normalise a DECLARATIVE alias map (`taujs.config.ts`
 * `alias`). Vite does not resolve relative alias replacements - it expects absolute paths
 * (https://vite.dev/config/shared-options.html#resolve-alias) - so a relative value resolves
 * against the project root at config load; an absolute value passes through untouched. This keeps
 * the declarative file free of `path.resolve(__dirname, ...)` boilerplate without shipping strings
 * Vite would misread. Programmatic alias values are NOT normalised here (callers already hold real
 * paths - see `layerAlias`).
 */
export const normaliseDeclarativeAlias = (declarative: AliasMap | undefined, projectRoot: string): AliasMap => {
  if (!declarative) return {};

  const out: AliasMap = {};
  for (const [key, value] of Object.entries(declarative)) {
    out[key] = path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  }

  return out;
};

export type LayerAliasArgs = {
  /** Framework defaults (`@client`/`@server`/`@shared`) - lowest layer, already absolute. */
  defaults: AliasMap;
  /** Declarative `config.alias` - middle layer; relative values normalise against `projectRoot`. */
  declarative?: AliasMap;
  /** Programmatic `createServer`/`taujsBuild` option - top layer, pass-through. */
  programmatic?: AliasMap;
  /** Project root the declarative relative values resolve against. */
  projectRoot: string;
  /**
   * Called per key where a programmatic value overrides a DIFFERING declarative one. Deliberate
   * overrides are common in tooling wrappers, so callers log this at DEBUG only - never warn (§3).
   */
  onDeclarativeOverride?: (key: string, declarativeValue: string, programmaticValue: string) => void;
};

/**
 * RFC 0005 Amended contract §3 (VS5) - the ONE alias layering, shared by dev (`setupDevServer`)
 * and build (`taujsBuild`) so a single declared `alias` resolves identically in both. Precedence
 * lowest -> highest:
 *
 *   framework defaults  ->  declarative `config.alias`  ->  programmatic option
 *
 * Later layers win PER KEY; unrelated keys from every layer survive. Programmatic wins a
 * declarative conflict (matching the §2 philosophy); the collision is surfaced only through
 * `onDeclarativeOverride` (debug), never warn.
 */
export const layerAlias = ({ defaults, declarative, programmatic, projectRoot, onDeclarativeOverride }: LayerAliasArgs): AliasMap => {
  const normalisedDeclarative = normaliseDeclarativeAlias(declarative, projectRoot);
  const prog = programmatic ?? {};

  if (onDeclarativeOverride) {
    for (const [key, programmaticValue] of Object.entries(prog)) {
      const declarativeValue = normalisedDeclarative[key];
      if (declarativeValue !== undefined && declarativeValue !== programmaticValue) onDeclarativeOverride(key, declarativeValue, programmaticValue);
    }
  }

  return { ...defaults, ...normalisedDeclarative, ...prog };
};
