/**
 * Filter settings memory: the last parameters used for each filter (persisted per user, like
 * Photoshop remembering dialog settings) and the "last filter" re-applied by Filter ▸ Last Filter.
 */
import type { ParamValues } from '../../core/types';
import type { FilterDef } from '../../registry';
import { resolveParams } from '../engine';
import type { ApplyMode } from './apply';

const STORAGE_KEY = 'perseverance.fxFilters.params.v1';

function load(): Record<string, ParamValues> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, ParamValues>) : {};
  } catch {
    return {};
  }
}

let memory: Record<string, ParamValues> = load();
let saveTimer: number | undefined;

function persist() {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
    } catch {
      /* storage full / unavailable: memory stays in-session */
    }
  }, 300);
}

/** Remembered params for a filter merged over its defaults (unknown keys dropped). */
export function rememberedParams(def: FilterDef): ParamValues {
  const saved = memory[def.id];
  const known: ParamValues = {};
  if (saved) {
    for (const p of def.params) {
      const v = saved[p.key];
      if (v === undefined || v === null) continue;
      // keep only values of the right shape (params may change between versions)
      const ok =
        (p.type === 'number' || p.type === 'angle' || p.type === 'seed') ? typeof v === 'number' && isFinite(v)
        : p.type === 'boolean' ? typeof v === 'boolean'
        : p.type === 'select' ? typeof v === 'string' && p.options.some((o) => o.value === v)
        : p.type === 'color' || p.type === 'text' || p.type === 'font' ? typeof v === 'string'
        : typeof v === 'object';
      if (ok) known[p.key] = structuredClone(v);
    }
  }
  return resolveParams(def, known);
}

export function rememberParams(filterId: string, params: ParamValues) {
  memory = { ...memory, [filterId]: structuredClone(params) };
  persist();
}

export function forgetParams(filterId: string) {
  if (!(filterId in memory)) return;
  const next = { ...memory };
  delete next[filterId];
  memory = next;
  persist();
}

export interface LastFilter {
  filterId: string;
  params: ParamValues;
  /** 'auto' when the user kept the target's default mode (re-applied with the new target's default). */
  mode: 'auto' | ApplyMode;
}

let last: LastFilter | null = null;
const listeners = new Set<() => void>();

export function getLastFilter(): LastFilter | null {
  return last;
}

export function setLastFilter(l: LastFilter) {
  last = { ...l, params: structuredClone(l.params) };
  listeners.forEach((f) => f());
}

export function subscribeLastFilter(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
