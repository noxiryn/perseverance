/**
 * Pure helpers for model import file handling (no three.js dependency, unit-tested):
 * resource name matching, main-file selection, OBJ `mtllib` parsing and MIME types.
 */
import { extOf } from '../../platform';

export type ModelFormat = 'obj' | 'glb' | 'gltf' | 'fbx';

export const MODEL_EXTENSIONS = ['obj', 'mtl', 'glb', 'gltf', 'bin', 'fbx', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif'];
const MAIN_PRIORITY: ModelFormat[] = ['glb', 'gltf', 'fbx', 'obj'];

/** Case-insensitive base name of a path or URL ("textures\\Foo.PNG?x" → "foo.png"). */
export function resourceKey(url: string): string {
  let s = url.split(/[?#]/)[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  return (s.split(/[\\/]/).pop() ?? s).trim().toLowerCase();
}

/** Choose the main model file among the selection (glb > gltf > fbx > obj). */
export function pickMainFile<T extends { name: string }>(files: T[]): T | null {
  for (const fmt of MAIN_PRIORITY) {
    const f = files.find((x) => extOf(x.name) === fmt);
    if (f) return f;
  }
  return null;
}

/** `mtllib` file names referenced by an OBJ file (a line may list several libraries). */
export function mtlLibsOf(objText: string): string[] {
  const out: string[] = [];
  const re = /^\s*mtllib\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(objText))) {
    const rest = m[1].trim();
    // Names usually have no spaces; when every token ends in .mtl treat them as a list.
    const tokens = rest.split(/\s+/);
    if (tokens.length > 1 && tokens.every((t) => /\.mtl$/i.test(t))) out.push(...tokens);
    else out.push(rest);
  }
  return out;
}

export function mimeOf(name: string): string {
  const e = extOf(name);
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  if (e === 'bmp') return 'image/bmp';
  if (e === 'gltf') return 'model/gltf+json';
  return 'application/octet-stream';
}

/** True for image files a model may reference as textures. */
export function isTextureName(name: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|tga)$/i.test(name);
}
