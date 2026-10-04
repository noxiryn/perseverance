/**
 * Hair styles (merged primitives), accessories and face textures for the Pose Studio rig.
 * Geometry is built in head-local / attachment-local coordinates (studs).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { rng } from '../../core/noise';
import type { Accessories, FaceStyle, HairStyle } from './types';

export type SurfaceKind = 'hair' | 'metal' | 'dark' | 'gold' | 'accent' | 'leather' | 'cloth';

export interface PartsFactory {
  material(kind: SurfaceKind, color: string, opts?: { doubleSide?: boolean }): THREE.Material;
  track<T extends { dispose(): void }>(g: T): T;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Non-indexed copy with only position/normal/uv so heterogeneous primitives can be merged. */
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k);
  n.clearGroups();
  if (g !== n) g.dispose();
  return n;
}

/** A cone whose base center sits at `base` and that points along `dir`. */
function spike(base: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, sides = 5, flatten = 1): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(radius, length, sides, 1);
  if (flatten !== 1) g.scale(1, 1, flatten);
  const d = dir.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d);
  g.applyQuaternion(q);
  const c = base.clone().addScaledVector(d, length * 0.5 - radius * 0.35);
  g.translate(c.x, c.y, c.z);
  return prep(g);
}

function cap(sx: number, sy: number, sz: number, y: number, z: number, thetaLen = Math.PI * 0.56): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, thetaLen);
  g.scale(sx, sy, sz);
  g.translate(0, y, z);
  return prep(g);
}

/** Point on the cap ellipsoid surface at polar angle t (from top) and azimuth a (0 = front). */
function capPoint(t: number, a: number, sx: number, sy: number, sz: number, y: number, z: number) {
  const p = new THREE.Vector3(Math.sin(t) * Math.sin(a) * sx, Math.cos(t) * sy + y, Math.sin(t) * Math.cos(a) * sz + z);
  const n = new THREE.Vector3(Math.sin(t) * Math.sin(a) / sx, Math.cos(t) / sy, (Math.sin(t) * Math.cos(a)) / sz).normalize();
  return { p, n };
}

export function buildHairGeometry(style: HairStyle): THREE.BufferGeometry | null {
  if (style === 'none') return null;
  const parts: THREE.BufferGeometry[] = [];
  const R = rng(style === 'spiky' ? 7 : style === 'messy' ? 23 : style === 'slick' ? 5 : 11);
  const CAP = { sx: 0.84, sy: 0.64, sz: 0.82, y: 0.08, z: -0.02 };
  const cp = (t: number, a: number) => capPoint(t, a, CAP.sx, CAP.sy, CAP.sz, CAP.y, CAP.z);

  if (style === 'spiky') {
    parts.push(cap(CAP.sx, CAP.sy, CAP.sz, CAP.y, CAP.z));
    // Crown spikes swept back and outward.
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + (R() - 0.5) * 0.3;
      const t = 0.35 + R() * 0.75;
      const { p, n } = cp(t, a);
      const dir = n.clone().add(new THREE.Vector3(0, 0.15, -0.55)).add(new THREE.Vector3(0, -0.25 * t, 0));
      parts.push(spike(p, dir, 0.42 + R() * 0.32, 0.15 + R() * 0.06, 4, 0.7));
    }
    // Top tufts
    for (let i = 0; i < 5; i++) {
      const { p, n } = cp(0.15 + R() * 0.25, R() * Math.PI * 2);
      parts.push(spike(p, n.clone().add(new THREE.Vector3(0, 0.3, -0.5)), 0.4 + R() * 0.2, 0.16, 4, 0.7));
    }
    // Bangs over the eyes.
    for (let i = 0; i < 7; i++) {
      const x = -0.52 + (i / 6) * 1.04 + (R() - 0.5) * 0.06;
      const base = new THREE.Vector3(x, 0.22 + R() * 0.06, 0.6);
      const dir = new THREE.Vector3(x * 0.25 + (R() - 0.5) * 0.25, -1, 0.32);
      parts.push(spike(base, dir, 0.42 + R() * 0.2, 0.12 + R() * 0.04, 4, 0.55));
    }
    // Sides and back
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const base = new THREE.Vector3(0.66 * s, 0.12 - i * 0.04, 0.3 - i * 0.3);
        parts.push(spike(base, new THREE.Vector3(0.25 * s, -1, -0.1), 0.38 + R() * 0.15, 0.13, 4, 0.6));
      }
    }
    for (let i = 0; i < 6; i++) {
      const x = -0.5 + (i / 5) * 1.0;
      const base = new THREE.Vector3(x, 0.05 + R() * 0.1, -0.6);
      parts.push(spike(base, new THREE.Vector3(x * 0.3, -1, -0.45), 0.45 + R() * 0.2, 0.15, 4, 0.6));
    }
  } else if (style === 'messy') {
    parts.push(cap(CAP.sx * 1.02, CAP.sy * 1.04, CAP.sz * 1.02, CAP.y, CAP.z));
    for (let i = 0; i < 30; i++) {
      const a = R() * Math.PI * 2;
      const t = 0.1 + R() * 1.05;
      const { p, n } = cp(t, a);
      const dir = n.clone().add(new THREE.Vector3((R() - 0.5) * 1.2, (R() - 0.3) * 0.8, (R() - 0.6) * 0.9));
      parts.push(spike(p, dir, 0.24 + R() * 0.22, 0.12 + R() * 0.08, 3, 0.6));
    }
    for (let i = 0; i < 6; i++) {
      const x = -0.48 + (i / 5) * 0.96;
      const base = new THREE.Vector3(x, 0.2, 0.6);
      parts.push(spike(base, new THREE.Vector3((R() - 0.5) * 0.8, -1, 0.4), 0.3 + R() * 0.15, 0.12, 3, 0.55));
    }
  } else if (style === 'slick') {
    parts.push(cap(0.69, 0.52, 0.72, 0.2, -0.08, Math.PI * 0.52));
    const back = new THREE.SphereGeometry(1, 20, 12);
    back.scale(0.62, 0.38, 0.42);
    back.translate(0, 0.12, -0.36);
    parts.push(prep(back));
    for (let i = 0; i < 6; i++) {
      const x = -0.42 + (i / 5) * 0.84;
      const base = new THREE.Vector3(x, 0.5 - Math.abs(x) * 0.25, 0.1);
      parts.push(spike(base, new THREE.Vector3(x * 0.2, 0.18, -1), 0.75 + R() * 0.2, 0.16, 4, 0.5));
    }
  } else if (style === 'long') {
    parts.push(cap(CAP.sx, CAP.sy, CAP.sz, CAP.y, CAP.z));
    for (const s of [-1, 1]) {
      const side = new RoundedBoxGeometry(0.2, 1.35, 0.85, 2, 0.08);
      side.translate(0.67 * s, -0.42, -0.06);
      parts.push(prep(side));
    }
    const backPanel = new RoundedBoxGeometry(1.3, 1.6, 0.22, 2, 0.08);
    backPanel.translate(0, -0.5, -0.62);
    parts.push(prep(backPanel));
    for (let i = 0; i < 6; i++) {
      const x = -0.5 + (i / 5) * 1.0;
      parts.push(spike(new THREE.Vector3(x, 0.22, 0.6), new THREE.Vector3(x * 0.15, -1, 0.3), 0.38 + R() * 0.12, 0.13, 4, 0.55));
    }
    for (let i = 0; i < 5; i++) {
      const x = -0.5 + (i / 4) * 1.0;
      parts.push(spike(new THREE.Vector3(x, -1.25, -0.6), new THREE.Vector3(0, -1, -0.15), 0.3, 0.16, 4, 0.6));
    }
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!merged) return null;
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Accessories                                                         */
/* ------------------------------------------------------------------ */

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, f: PartsFactory, setup?: (m: THREE.Mesh) => void) {
  f.track(geo);
  const m = new THREE.Mesh(geo, mat);
  setup?.(m);
  return m;
}

/** Sword held in a hand: grip at the origin, blade along +Z. */
export function buildSword(f: PartsFactory): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Sword';
  const metal = f.material('metal', '#c9ccd4');
  const dark = f.material('leather', '#2a1b10');
  const gold = f.material('gold', '#b8902b');
  g.add(mesh(new THREE.BoxGeometry(0.07, 0.26, 2.9), metal, f, (m) => (m.position.z = 1.85)));
  g.add(mesh(new THREE.ConeGeometry(0.13, 0.4, 4), metal, f, (m) => {
    m.rotation.x = Math.PI / 2;
    m.scale.set(1, 1, 0.27);
    m.position.z = 3.48;
  }));
  g.add(mesh(new THREE.BoxGeometry(0.16, 0.85, 0.12), gold, f, (m) => (m.position.z = 0.38)));
  g.add(mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.75, 10), dark, f, (m) => {
    m.rotation.x = Math.PI / 2;
    m.position.z = 0;
  }));
  g.add(mesh(new THREE.SphereGeometry(0.11, 10, 8), gold, f, (m) => (m.position.z = -0.42)));
  return g;
}

/** Sheathed katana diagonally across the back (attach to torso). */
export function buildKatana(f: PartsFactory, accent: string): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Katana';
  const sheath = f.material('dark', '#141416');
  const wrap = f.material('cloth', '#2b2b2f');
  const cord = f.material('accent', accent);
  const inner = new THREE.Group();
  inner.add(mesh(new THREE.BoxGeometry(0.13, 3.0, 0.18), sheath, f, (m) => (m.position.y = -0.6)));
  inner.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 16), cord, f, (m) => (m.position.y = 0.92)));
  inner.add(mesh(new THREE.BoxGeometry(0.11, 0.95, 0.14), wrap, f, (m) => (m.position.y = 1.42)));
  inner.add(mesh(new THREE.BoxGeometry(0.15, 0.1, 0.19), cord, f, (m) => (m.position.y = 0.3)));
  inner.rotation.z = -0.62;
  g.add(inner);
  g.position.set(0.1, 0.15, -0.6);
  return g;
}

/** Round shield on the outer side of the left forearm. */
export function buildShield(f: PartsFactory, accent: string): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Shield';
  const face = f.material('accent', accent);
  const rim = f.material('metal', '#8e9097');
  g.add(mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.14, 28), face, f, (m) => (m.rotation.z = Math.PI / 2)));
  g.add(mesh(new THREE.TorusGeometry(0.85, 0.07, 6, 28), rim, f, (m) => (m.rotation.y = Math.PI / 2)));
  g.add(mesh(new THREE.SphereGeometry(0.2, 12, 8), rim, f, (m) => (m.position.x = 0.08)));
  g.position.x = 0.08;
  return g;
}

/** Crown on top of the head (attach to head center). */
export function buildCrown(f: PartsFactory): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Crown';
  const gold = f.material('gold', '#e1b12c', { doubleSide: true });
  g.add(mesh(new THREE.CylinderGeometry(0.5, 0.46, 0.26, 20, 1, true), gold, f));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(
      mesh(new THREE.ConeGeometry(0.1, 0.3, 4), gold, f, (m) => {
        m.position.set(Math.sin(a) * 0.48, 0.27, Math.cos(a) * 0.48);
      }),
    );
  }
  g.position.y = 0.78;
  g.rotation.x = -0.08;
  return g;
}

/** Headphones band + cups (attach to head center). */
export function buildHeadphones(f: PartsFactory, accent: string): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Headphones';
  const dark = f.material('dark', '#1b1b1f');
  const ring = f.material('accent', accent);
  g.add(mesh(new THREE.TorusGeometry(0.74, 0.07, 8, 28, Math.PI), dark, f, (m) => (m.position.y = 0.08)));
  for (const s of [-1, 1]) {
    g.add(
      mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 22), dark, f, (m) => {
        m.rotation.z = Math.PI / 2;
        m.position.set(0.72 * s, 0.02, 0);
      }),
    );
    g.add(
      mesh(new THREE.TorusGeometry(0.26, 0.04, 6, 22), ring, f, (m) => {
        m.rotation.y = Math.PI / 2;
        m.position.set(0.83 * s, 0.02, 0);
      }),
    );
  }
  return g;
}

/** Flowing cape hanging from the shoulders (attach to torso center). */
export function buildCape(f: PartsFactory, accent: string, torsoTop: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Cape';
  const geo = new THREE.BoxGeometry(2.1, 3.4, 0.06, 8, 14, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const t = (1.7 - y) / 3.4; // 0 at top, 1 at bottom
    const flare = 1 + 0.28 * t;
    const wave = Math.sin(x * 2.6 + t * 2) * 0.06 * t;
    pos.setX(i, x * flare);
    pos.setY(i, y - 1.7);
    pos.setZ(i, pos.getZ(i) - 0.12 - 0.55 * t * t + wave - Math.abs(x) * 0.08 * (1 - t));
  }
  geo.computeVertexNormals();
  g.add(mesh(geo, f.material('cloth', accent, { doubleSide: true }), f));
  // Collar
  g.add(
    mesh(new THREE.BoxGeometry(2.2, 0.16, 0.5), f.material('cloth', accent), f, (m) => {
      m.position.set(0, -0.02, -0.18);
    }),
  );
  g.position.set(0, torsoTop, -0.5);
  return g;
}

export function buildAccessories(
  f: PartsFactory,
  acc: Accessories,
  accent: string,
): { attach: 'rightHand' | 'torso' | 'leftForearm' | 'head'; object: THREE.Object3D }[] {
  const out: { attach: 'rightHand' | 'torso' | 'leftForearm' | 'head'; object: THREE.Object3D }[] = [];
  if (acc.sword) out.push({ attach: 'rightHand', object: buildSword(f) });
  if (acc.katana) out.push({ attach: 'torso', object: buildKatana(f, accent) });
  if (acc.shield) out.push({ attach: 'leftForearm', object: buildShield(f, accent) });
  if (acc.crown) out.push({ attach: 'head', object: buildCrown(f) });
  if (acc.headphones) out.push({ attach: 'head', object: buildHeadphones(f, accent) });
  if (acc.cape) out.push({ attach: 'torso', object: buildCape(f, accent, 0.95) });
  return out;
}

/* ------------------------------------------------------------------ */
/* Face                                                                */
/* ------------------------------------------------------------------ */

/** Face texture painted over the skin color (front face of the head). Null for 'blank'. */
export function buildFaceTexture(style: FaceStyle, skin: string): THREE.CanvasTexture | null {
  if (style === 'blank') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = skin;
  g.fillRect(0, 0, 256, 256);
  if (style === 'smile') {
    g.fillStyle = '#111111';
    for (const x of [100, 156]) {
      g.beginPath();
      g.ellipse(x, 112, 9, 17, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = '#111111';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(128, 128, 40, Math.PI * 0.22, Math.PI * 0.78);
    g.stroke();
  } else if (style === 'shadow') {
    // Jagged hair shadow falling over the eyes + soft falloff.
    const grad = g.createLinearGradient(0, 0, 0, 160);
    grad.addColorStop(0, 'rgba(0,0,0,0.78)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 160);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.moveTo(0, 0);
    const r = rng(3);
    for (let x = 0; x <= 256; x += 21) g.lineTo(x, 70 + r() * 55 + (x % 42 === 0 ? 18 : 0));
    g.lineTo(256, 0);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
