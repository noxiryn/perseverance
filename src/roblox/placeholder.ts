/**
 * Placeholder Roblox-style character renderer (contract used by templates & the Roblox module).
 * Draws a blocky R6 avatar in a slight 3/4 oblique view (top + side faces visible) into a
 * transparent canvas — synchronously, no WebGL. 'shaded' = 3-tone cel shading (top light, front
 * mid, side shadow) with spiky anime hair, a hair shadow over the blank face and a dark ink
 * outline; 'flat' = one clean silhouette color.
 */
import { createCanvas, ctx2d } from '../core/canvas';

export type PlaceholderPose = 'idle' | 'action' | 'back' | 'sword' | 'arms-crossed' | 'hero';

export interface PlaceholderOptions {
  width: number;
  height: number;
  pose?: PlaceholderPose;
  /** 'flat' = single-color silhouette; 'shaded' = simple 3-tone shading. */
  style?: 'flat' | 'shaded';
  skin?: string;
  shirt?: string;
  pants?: string;
  hair?: string;
  /** Silhouette color for style 'flat'. */
  silhouette?: string;
}

type Pt = [number, number];

interface Tones {
  top: string;
  front: string;
  side: string;
}

function parseHex(hex: string): [number, number, number] {
  let s = hex.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [128, 128, 128];
}

function shade(hex: string, k: number): string {
  const [r, g, b] = parseHex(hex);
  const f = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function tonesOf(color: string, flat: boolean): Tones {
  if (flat) return { top: color, front: color, side: color };
  return { top: shade(color, 0.2), front: color, side: shade(color, -0.38) };
}

interface PoseSpec {
  armL: number; // screen-left arm (character's right), degrees, + = outward
  armR: number; // screen-right arm, degrees, + = outward
  legL: number;
  legR: number;
  head: number;
  crossed?: boolean;
  sword?: boolean;
  cape?: boolean;
  back?: boolean;
  drop?: number; // lower the body (studs)
  /** Design box height in studs (extra headroom for raised weapons). */
  fit?: number;
}

const POSES: Record<PlaceholderPose, PoseSpec> = {
  idle: { armL: 5, armR: 5, legL: 0, legR: 0, head: 0 },
  action: { armL: 38, armR: 112, legL: 13, legR: 13, head: -4, drop: 0.12 },
  back: { armL: 6, armR: 6, legL: 0, legR: 0, head: 0, back: true },
  sword: { armL: 16, armR: 140, legL: 9, legR: 9, head: -6, sword: true, drop: 0.08, fit: 8.7 },
  'arms-crossed': { armL: 0, armR: 0, legL: 3, legR: 3, head: 4, crossed: true },
  hero: { armL: 24, armR: 24, legL: 14, legR: 14, head: -5, cape: true, drop: 0.1 },
};

const SHOULDER_Y = 3.62;

/**
 * Horizontal reach (studs, from the torso center) of a pose: arms (incl. their extruded depth),
 * the sword and the hair. Used to fit wide poses into narrow canvases without clipping.
 */
export function poseExtents(pose: PoseSpec): { left: number; right: number } {
  const DX = 0.36; // oblique depth offset (to the right)
  let left = 1.32,
    right = 1.32 + DX; // head + hair
  const arm = (pivotX: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a),
      s = Math.sin(a);
    for (const lx of [-0.5, 0.5])
      for (const ly of [-0.38, 1.62]) {
        const x = pivotX + lx * c - ly * s;
        left = Math.max(left, -x);
        right = Math.max(right, x + DX);
      }
  };
  if (pose.crossed) {
    arm(-1.5, 4);
    arm(1.5, -4);
  } else {
    arm(-1.5, pose.armL);
    arm(1.5, -pose.armR);
  }
  if (pose.sword && !pose.crossed) {
    const a = (-pose.armR * Math.PI) / 180;
    const hx = 1.5 - Math.sin(a) * 1.45;
    const ba = Math.atan2(Math.cos(a), -Math.sin(a)) - 1.35;
    const tipX = hx + Math.cos(ba) * 3.35;
    const guard = Math.abs(Math.sin(ba)) * 0.62;
    left = Math.max(left, -tipX, -(hx - guard));
    right = Math.max(right, tipX, hx + guard);
  }
  if (pose.cape) {
    left = Math.max(left, 1.6);
    right = Math.max(right, 1.9);
  }
  return { left, right };
}

/** Polygon with positive (clockwise on screen) orientation — needed for one nonzero fill. */
function clockwise(pts: Pt[]): Pt[] {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a < 0 ? pts.slice().reverse() : pts;
}

export function renderPlaceholderCharacter(opts: PlaceholderOptions): HTMLCanvasElement {
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const flat = opts.style === 'flat';
  const sil = opts.silhouette ?? '#111111';
  const col = (v: string | undefined, d: string) => (flat ? sil : (v ?? d));
  const skin = col(opts.skin, '#d8b48a');
  const shirt = col(opts.shirt, '#1d1d22');
  const pants = col(opts.pants, '#26262c');
  const hair = col(opts.hair, '#2a2833');
  const pose = POSES[opts.pose ?? 'idle'] ?? POSES.idle;

  // Layout: studs → px. Design box ≈ 6.6 × 7.9 studs (room for raised arms / sword / hair),
  // widened per pose when raised arms or a weapon reach further (never clipped at the edges).
  const ext = poseExtents(pose);
  const margin = 0.14; // ink outline + anti-aliasing
  const u = Math.min(width / 6.6, width / (2 * (ext.right - 0.2 + margin)), width / (2 * (ext.left + 0.2 + margin)), height / (pose.fit ?? 7.9));
  const cx = width / 2 - u * 0.2;
  const baseY = height - u * 0.35 + (pose.drop ?? 0) * u;
  const P = (x: number, y: number): Pt => [cx + x * u, baseY - y * u];
  const D: Pt = [u * 0.36, -u * 0.26]; // oblique depth offset (back face up-right)

  const art = createCanvas(width, height);
  const g = ctx2d(art);
  g.lineJoin = 'round';

  const seam = Math.max(0.6, u * 0.012);
  // Flat silhouettes: every shape goes into ONE path filled once at the end, so adjacent parts
  // never show anti-aliasing seams (all subpaths share one orientation for the nonzero rule).
  const flatPath: Path2D | null = flat ? new Path2D() : null;
  let pathTarget: Path2D | null = flatPath;
  const fillPoly = (pts: Pt[], color: string) => {
    if (pathTarget) {
      const cw = clockwise(pts);
      pathTarget.moveTo(cw[0][0], cw[0][1]);
      for (let i = 1; i < cw.length; i++) pathTarget.lineTo(cw[i][0], cw[i][1]);
      pathTarget.closePath();
      return;
    }
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fill();
    // Close anti-aliasing hairlines between adjacent faces.
    g.strokeStyle = color;
    g.lineWidth = seam;
    g.stroke();
  };

  /**
   * Extruded box: local rect (x,y,w,h in px, y down) around pivot, rotated by `deg`.
   * `capTop: false` skips the face along the local top edge (used for hands drawn over the end
   * of an arm, so they read as the skin-colored end of the limb instead of a separate slab).
   */
  const block = (pivot: Pt, x: number, y: number, w: number, h: number, deg: number, color: string, capTop = true) => {
    const t = tonesOf(color, flat);
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a),
      s = Math.sin(a);
    const rot = (lx: number, ly: number): Pt => [pivot[0] + lx * c - ly * s, pivot[1] + lx * s + ly * c];
    const F: Pt[] = [rot(x, y), rot(x + w, y), rot(x + w, y + h), rot(x, y + h)];
    const B: Pt[] = F.map((p) => [p[0] + D[0], p[1] + D[1]] as Pt);
    for (let i = 0; i < 4; i++) {
      if (!capTop && i === 0) continue; // edge F0→F1 is the local top edge
      const p0 = F[i],
        p1 = F[(i + 1) % 4];
      const nx = p1[1] - p0[1],
        ny = -(p1[0] - p0[0]);
      if (nx * D[0] + ny * D[1] <= 0) continue;
      const len = Math.hypot(nx, ny) || 1;
      fillPoly([p0, p1, B[(i + 1) % 4], B[i]], ny / len < -0.55 ? t.top : t.side);
    }
    fillPoly(F, t.front);
    return F;
  };

  /** Rounded extruded block (classic head). */
  const roundBlock = (x: number, y: number, w: number, h: number, r: number, color: string) => {
    if (pathTarget) {
      // roundRect subpaths are clockwise like the normalized polygons.
      for (let i = 4; i >= 0; i--) pathTarget.roundRect(x + (D[0] * i) / 4, y + (D[1] * i) / 4, w, h, r);
      return;
    }
    const t = tonesOf(color, flat);
    const steps = 14;
    g.fillStyle = t.side;
    for (let i = steps; i >= 1; i--) {
      const k = i / steps;
      g.beginPath();
      g.roundRect(x + D[0] * k, y + D[1] * k, w, h, r);
      g.fill();
    }
    g.fillStyle = t.top;
    for (let i = steps; i >= 1; i--) {
      const k = i / steps;
      g.beginPath();
      g.roundRect(x + D[0] * k, y + D[1] * k, w - r * 0.8, h * 0.3, [r, r * 0.4, 0, 0]);
      g.fill();
    }
    g.fillStyle = t.front;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
  };

  // --- cape (behind everything) ---
  if (pose.cape) {
    const capeColor = flat ? sil : shade(shirt === '#1d1d22' ? '#7a1214' : shirt, -0.1);
    const t = tonesOf(capeColor, flat);
    const top = P(0, 3.95);
    fillPoly([[top[0] - u * 1.05, top[1]], [top[0] + u * 1.05 + D[0], top[1] + D[1]], [top[0] + u * 1.9, top[1] + u * 3.6], [top[0] + u * 0.2, top[1] + u * 3.85], [top[0] - u * 1.6, top[1] + u * 3.55]], t.side);
    fillPoly([[top[0] - u * 1.05, top[1] + u * 0.2], [top[0] + u * 0.3, top[1] + u * 0.25], [top[0] + u * 0.1, top[1] + u * 3.75], [top[0] - u * 1.6, top[1] + u * 3.55]], t.front);
  }

  const shoulderY = SHOULDER_Y;
  const armL = () => block(P(-1.5, shoulderY), -u * 0.5, -u * 0.38, u, u * 2, pose.armL, shirt);
  const armR = () => block(P(1.5, shoulderY), -u * 0.5, -u * 0.38, u, u * 2, -pose.armR, shirt);
  // Hands (skin) at the arm ends for a bit of readability in shaded mode.
  const hand = (pivotX: number, deg: number) => {
    if (flat) return;
    block(P(pivotX, shoulderY), -u * 0.5, u * 1.25, u, u * 0.37, deg, skin, false);
  };

  // --- back arm (screen-left) ---
  if (!pose.crossed) {
    armL();
    hand(-1.5, pose.armL);
  }
  // --- legs ---
  block(P(-0.5, 2), -u * 0.5, 0, u * 0.99, u * 2, pose.legL, pants);
  block(P(0.5, 2), -u * 0.49, 0, u * 0.99, u * 2, -pose.legR, pants);
  // --- torso ---
  const torsoTL = P(-1, 4);
  block(torsoTL, 0, 0, u * 2, u * 2, 0, shirt);
  if (!flat && !pose.back) {
    // Shirt collar / skin V for a bit of character.
    const nk = P(0, 4);
    fillPoly([[nk[0] - u * 0.32, nk[1]], [nk[0] + u * 0.32, nk[1]], [nk[0], nk[1] + u * 0.42]], shade(skin, -0.12));
  }
  if (pose.crossed) {
    // Upper arms at the sides, forearms crossed in front of the chest.
    block(P(-1.5, shoulderY), -u * 0.5, -u * 0.38, u, u * 1.3, 4, shirt);
    block(P(1.5, shoulderY), -u * 0.5, -u * 0.38, u, u * 1.3, -4, shirt);
    const chest = P(0, 3.05);
    block(chest, -u * 1.35, -u * 0.36, u * 2.7, u * 0.72, -7, flat ? sil : shade(shirt, -0.18));
    block(chest, -u * 1.3, -u * 0.32, u * 2.6, u * 0.66, 9, shirt);
    if (!flat) {
      block(P(-1.25, 3.05), -u * 0.32, -u * 0.34, u * 0.5, u * 0.62, 9, skin, false);
      block(P(1.25, 3.05), -u * 0.18, -u * 0.36, u * 0.5, u * 0.66, -7, skin, false);
    }
  } else {
    // --- sword (behind the front arm) ---
    if (pose.sword) {
      const a = (-pose.armR * Math.PI) / 180;
      const sp = P(1.5, shoulderY);
      const hx = sp[0] - Math.sin(a) * u * 1.45,
        hy = sp[1] + Math.cos(a) * u * 1.45;
      const armDir = Math.atan2(Math.cos(a), -Math.sin(a));
      const ba = armDir - 1.35; // blade swept back over the head
      const dir: Pt = [Math.cos(ba), Math.sin(ba)];
      const nrm: Pt = [-dir[1], dir[0]];
      const L = u * 3.0,
        bw = u * 0.16;
      const tip: Pt = [hx + dir[0] * (L + u * 0.35), hy + dir[1] * (L + u * 0.35)];
      const b0: Pt = [hx + dir[0] * u * 0.3, hy + dir[1] * u * 0.3];
      const b1: Pt = [hx + dir[0] * L, hy + dir[1] * L];
      const bladeLight = flat ? sil : '#d9dde4';
      const bladeDark = flat ? sil : '#8d929c';
      fillPoly([[b0[0] + nrm[0] * bw, b0[1] + nrm[1] * bw], [b1[0] + nrm[0] * bw, b1[1] + nrm[1] * bw], tip, [b1[0], b1[1]], [b0[0], b0[1]]], bladeLight);
      fillPoly([[b0[0] - nrm[0] * bw, b0[1] - nrm[1] * bw], [b1[0] - nrm[0] * bw, b1[1] - nrm[1] * bw], tip, [b1[0], b1[1]], [b0[0], b0[1]]], bladeDark);
      const gw = u * 0.62,
        gt = u * 0.12;
      const gc: Pt = [hx + dir[0] * u * 0.28, hy + dir[1] * u * 0.28];
      fillPoly(
        [
          [gc[0] + nrm[0] * gw - dir[0] * gt, gc[1] + nrm[1] * gw - dir[1] * gt],
          [gc[0] + nrm[0] * gw + dir[0] * gt, gc[1] + nrm[1] * gw + dir[1] * gt],
          [gc[0] - nrm[0] * gw + dir[0] * gt, gc[1] - nrm[1] * gw + dir[1] * gt],
          [gc[0] - nrm[0] * gw - dir[0] * gt, gc[1] - nrm[1] * gw - dir[1] * gt],
        ],
        flat ? sil : '#b8902b',
      );
      const hw = u * 0.08;
      fillPoly(
        [
          [hx + nrm[0] * hw - dir[0] * u * 0.55, hy + nrm[1] * hw - dir[1] * u * 0.55],
          [hx + nrm[0] * hw + dir[0] * u * 0.2, hy + nrm[1] * hw + dir[1] * u * 0.2],
          [hx - nrm[0] * hw + dir[0] * u * 0.2, hy - nrm[1] * hw + dir[1] * u * 0.2],
          [hx - nrm[0] * hw - dir[0] * u * 0.55, hy - nrm[1] * hw - dir[1] * u * 0.55],
        ],
        flat ? sil : '#3a2414',
      );
    }
    // --- front arm (screen-right) ---
    armR();
    hand(1.5, -pose.armR);
  }

  // --- head ---
  const headW = u * 1.38,
    headH = u * 1.3;
  const tilt = (pose.head * Math.PI) / 180;
  const hc = P(0, 4.7);
  g.save();
  g.translate(hc[0], hc[1]);
  g.rotate(tilt);
  g.translate(-hc[0], -hc[1]);
  // Flat mode: collect the head in its own path, added to the silhouette with the tilt applied.
  const headPath: Path2D | null = flat ? new Path2D() : null;
  pathTarget = headPath;
  const hx0 = hc[0] - headW / 2,
    hy0 = hc[1] - headH / 2 + u * 0.02;
  roundBlock(hx0, hy0, headW, headH, u * 0.3, skin);
  // Hair shadow over the blank face (the GFX look).
  if (!flat && !pose.back) {
    const grad = g.createLinearGradient(0, hy0, 0, hy0 + headH * 0.75);
    grad.addColorStop(0, 'rgba(10,6,20,0.55)');
    grad.addColorStop(0.55, 'rgba(10,6,20,0.32)');
    grad.addColorStop(1, 'rgba(10,6,20,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(hx0, hy0, headW, headH, u * 0.3);
    g.fill();
  }
  // Spiky hair
  const ht = tonesOf(hair, flat);
  const hairTop = hy0 - u * 0.12;
  const spikes = (offX: number, offY: number, color: string, scale = 1) => {
    const pts: Pt[] = [];
    const L = hx0 - u * 0.2 + offX,
      R = hx0 + headW + u * 0.22 + offX;
    const bangsY = pose.back ? hy0 + headH * 0.92 : hy0 + headH * 0.42;
    // left side down to the bangs line
    pts.push([L + u * 0.1, bangsY + offY + u * 0.08]);
    pts.push([L - u * 0.18 * scale, hy0 + headH * 0.18 + offY]);
    pts.push([L + u * 0.02, hy0 + headH * 0.05 + offY]);
    // crown spikes
    const n = 7;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = L + (R - L) * t;
      const arch = Math.sin(t * Math.PI) * u * 0.32;
      if (i % 2 === 0) pts.push([x + u * 0.14 * (t - 0.4), hairTop - arch - u * (0.34 + 0.12 * ((i * 7) % 3)) * scale + offY]);
      else pts.push([x, hairTop - arch * 0.55 + u * 0.06 + offY]);
    }
    pts.push([R + u * 0.2 * scale, hy0 + headH * 0.12 + offY]);
    pts.push([R + u * 0.02, hy0 + headH * 0.32 + offY]);
    pts.push([R + u * 0.12 * scale, bangsY + offY + u * 0.04]);
    // jagged bangs / nape back to the left
    const m = 6;
    for (let i = m; i >= 0; i--) {
      const t = i / m;
      const x = L + u * 0.12 + (R - L - u * 0.24) * t;
      const down = i % 2 === 0 ? u * (pose.back ? 0.16 : 0.26) : -u * 0.06;
      pts.push([x, bangsY + down + offY]);
    }
    fillPoly(pts, color);
  };
  spikes(D[0] * 0.55, D[1] * 0.55, ht.side, 1.02);
  spikes(0, 0, ht.front);
  if (!flat) {
    // Highlight streaks on the crown.
    g.strokeStyle = ht.top;
    g.lineWidth = Math.max(1, u * 0.07);
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const x = hx0 + headW * (0.28 + i * 0.2);
      g.moveTo(x, hairTop + u * 0.02);
      g.lineTo(x + u * 0.14, hairTop - u * 0.18);
    }
    g.stroke();
  }
  g.restore();
  pathTarget = flatPath;

  if (flatPath) {
    if (headPath) flatPath.addPath(headPath, new DOMMatrix().translate(hc[0], hc[1]).rotate((tilt * 180) / Math.PI).translate(-hc[0], -hc[1]));
    g.fillStyle = sil;
    g.fill(flatPath, 'nonzero');
    return art;
  }

  // Dark ink outline around the whole silhouette (posterized GFX look).
  const out = createCanvas(width, height);
  const o = ctx2d(out);
  const ink = createCanvas(width, height);
  const ic = ctx2d(ink);
  ic.drawImage(art, 0, 0);
  ic.globalCompositeOperation = 'source-in';
  ic.fillStyle = '#0b0b0e';
  ic.fillRect(0, 0, width, height);
  const r = Math.max(1, u * 0.045);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    o.drawImage(ink, Math.cos(a) * r, Math.sin(a) * r);
  }
  o.drawImage(art, 0, 0);
  return out;
}
