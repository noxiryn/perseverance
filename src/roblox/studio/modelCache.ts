/** Session cache of imported model files (no three.js dependency), for re-editing model renders. */

export interface ModelFile {
  name: string;
  data: ArrayBuffer;
}

const modelCache = new Map<string, ModelFile[]>();

export function cacheModelFiles(files: ModelFile[]): string {
  const key = files.map((f) => `${f.name}:${f.data.byteLength}`).join('|');
  modelCache.set(key, files);
  return key;
}

export function cachedModelFiles(key: unknown): ModelFile[] | null {
  return typeof key === 'string' ? (modelCache.get(key) ?? null) : null;
}
