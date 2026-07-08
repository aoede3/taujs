import { DEBUG_CATEGORIES } from './Logger';

import type { DebugCategory, DebugConfig } from '../core/logging/types';

export type DebugInput = DebugConfig | string | boolean | Array<DebugCategory | `-${DebugCategory}`> | undefined;

export function parseDebugInput(input: DebugInput): DebugConfig | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'boolean') return input;
  if (Array.isArray(input)) {
    const pos = new Set<DebugCategory>();
    const neg = new Set<DebugCategory>();

    for (const raw of input) {
      const s = String(raw);
      const isNeg = s.startsWith('-') || s.startsWith('!');
      const key = (isNeg ? s.slice(1) : s) as DebugCategory;
      const isValid = (DEBUG_CATEGORIES as readonly string[]).includes(key);

      if (!isValid) {
        console.warn(`[parseDebugInput] Invalid debug category: "${key}". Valid: ${DEBUG_CATEGORIES.join(', ')}`);
        continue;
      }

      (isNeg ? neg : pos).add(key);
    }

    if (neg.size > 0 && pos.size === 0) {
      const o: { all?: boolean } & Partial<Record<DebugCategory, boolean>> = { all: true };

      for (const k of neg) o[k] = false;

      return o;
    }

    if (pos.size > 0 || neg.size > 0) {
      const o: Partial<Record<DebugCategory, boolean>> = {};

      for (const k of pos) o[k] = true;
      for (const k of neg) o[k] = false;

      return o;
    }

    return undefined;
  }

  if (typeof input === 'string') {
    const raw = input.trim();

    if (!raw) return undefined;
    if (raw === '*' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'all') return true;

    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const flags: { all?: boolean } & Partial<Record<DebugCategory, boolean>> = {};
    const on = new Set<DebugCategory>();
    const off = new Set<DebugCategory>();

    for (const p of parts) {
      const neg = p.startsWith('-') || p.startsWith('!');
      const key = (neg ? p.slice(1) : p) as DebugCategory;
      const isValid = (DEBUG_CATEGORIES as readonly string[]).includes(key);

      if (!isValid) {
        console.warn(`[parseDebugInput] Invalid debug category: "${key}". Valid: ${DEBUG_CATEGORIES.join(', ')}`);
        continue;
      }
      (neg ? off : on).add(key);
    }

    if (off.size > 0 && on.size === 0) {
      flags.all = true;

      for (const k of off) flags[k] = false;

      return flags;
    }

    for (const k of on) flags[k] = true;
    for (const k of off) flags[k] = false;

    return flags;
  }

  return input;
}
