/**
 * 3D model loading for the importer: .obj (+ .mtl + textures), .glb / .gltf (+ .bin + textures)
 * and .fbx. All selected files are exposed through blob URLs; a LoadingManager URL modifier maps
 * every resource reference (by file name, case-insensitive, any folder prefix) to its blob.
 */
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { extOf } from '../../platform';

import type { ModelFile } from './modelCache';

export type { ModelFile } from './modelCache';
export { cacheModelFiles, cachedModelFiles } from './modelCache';

export type ModelFormat = 'obj' | 'glb' | 'gltf' | 'fbx';

export interface LoadedModel {
  root: THREE.Object3D;
  name: string;
  format: ModelFormat;
  mainFile: string;
  /** Referenced resources that were not among the selected files. */
  missing: string[];
  meshCount: number;
  triangles: number;
}

export const MODEL_EXTENSIONS = ['obj', 'mtl', 'glb', 'gltf', 'bin', 'fbx', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif'];
const MAIN_PRIORITY: ModelFormat[] = ['glb', 'gltf', 'fbx', 'obj'];

/** 1×1 white PNG used for textures that were not selected (keeps the material color visible). */
const WHITE_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

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

/** `mtllib` file names referenced by an OBJ file. */
export function mtlLibsOf(objText: string): string[] {
  const out: string[] = [];
  const re = /^\s*mtllib\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(objText))) out.push(m[1]);
  return out;
}

function mimeOf(name: string): string {
  const e = extOf(name);
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  if (e === 'gif') return 'image/gif';
  if (e === 'bmp') return 'image/bmp';
  if (e === 'gltf') return 'model/gltf+json';
  return 'application/octet-stream';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function loadModel(files: ModelFile[]): Promise<LoadedModel> {
  const main = pickMainFile(files);
  if (!main) throw new Error('No 3D model found. Select an .obj, .glb, .gltf or .fbx file (plus its .mtl and textures).');
  const format = extOf(main.name) as ModelFormat;

  const urls = new Map<string, string>();
  const created: string[] = [];
  for (const f of files) {
    const u = URL.createObjectURL(new Blob([f.data], { type: mimeOf(f.name) }));
    created.push(u);
    urls.set(resourceKey(f.name), u);
  }
  const missing = new Set<string>();

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob:|data:)/i.test(url)) return url;
    const hit = urls.get(resourceKey(url));
    if (hit) return hit;
    const key = resourceKey(url);
    if (key) missing.add(key);
    return /\.(png|jpe?g|webp|gif|bmp|tga)$/i.test(key) ? WHITE_PIXEL : url;
  });
  // Track outstanding resource loads (textures keep loading after OBJ/FBX parsing returns).
  let total = 0;
  let done = 0;
  let settle: () => void = () => {};
  const allLoaded = new Promise<void>((r) => (settle = r));
  const start = manager.itemStart.bind(manager);
  const end = manager.itemEnd.bind(manager);
  manager.itemStart = (url: string) => {
    total++;
    start(url);
  };
  manager.itemEnd = (url: string) => {
    done++;
    end(url);
    if (done >= total) settle();
  };

  try {
    let root: THREE.Object3D;
    if (format === 'obj') {
      const text = new TextDecoder().decode(main.data);
      const loader = new OBJLoader(manager);
      const libs = mtlLibsOf(text).map(resourceKey);
      const mtl = files.find((f) => libs.includes(resourceKey(f.name))) ?? files.find((f) => extOf(f.name) === 'mtl');
      for (const l of libs) if (!urls.has(l)) missing.add(l);
      if (mtl) {
        const creator = new MTLLoader(manager).parse(new TextDecoder().decode(mtl.data), '');
        creator.preload();
        loader.setMaterials(creator);
      }
      root = loader.parse(text);
    } else if (format === 'fbx') {
      root = new FBXLoader(manager).parse(main.data, '');
    } else {
      const gltf = await withTimeout(new GLTFLoader(manager).parseAsync(main.data, ''), 60000, 'Loading the glTF model');
      root = gltf.scene ?? gltf.scenes?.[0];
      if (!root) throw new Error('The glTF file contains no scene.');
    }
    if (total > done) await withTimeout(allLoaded, 30000, 'Loading textures').catch(() => undefined);

    let meshCount = 0;
    let triangles = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshCount++;
      const g = mesh.geometry;
      triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
      if (!g.attributes.normal) g.computeVertexNormals();
      mesh.frustumCulled = false;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const mm = m as THREE.MeshPhongMaterial;
        if (mm.map) mm.map.colorSpace = THREE.SRGBColorSpace;
        // Roblox OBJ exports often flag opaque parts as transparent (d 1 / Tr 0) — avoid sorting artifacts.
        if (mm.transparent && mm.opacity >= 0.99 && !mm.alphaMap) mm.transparent = false;
        mm.needsUpdate = true;
      }
    });
    if (!meshCount) throw new Error(`“${main.name}” contains no meshes.`);
    return {
      root,
      name: main.name.replace(/\.[^.]+$/, ''),
      format,
      mainFile: main.name,
      missing: [...missing].filter((m) => !/^(blob:|data:)/.test(m)),
      meshCount,
      triangles: Math.round(triangles),
    };
  } finally {
    // Images are decoded by now (or failed); free the blobs.
    window.setTimeout(() => created.forEach((u) => URL.revokeObjectURL(u)), 1000);
  }
}

export async function filesFromDom(list: File[]): Promise<ModelFile[]> {
  return Promise.all(list.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
}
