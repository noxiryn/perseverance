/**
 * Exact perspective framing (pure math, no three.js — unit-tested).
 *
 * The studio camera orbits a target at (yaw, pitch, distance) and the final render is cropped
 * exactly to the frame, so framing must account for perspective depth: points nearer the camera
 * project larger. `fitCamera` finds the smallest distance (and the target shift in the camera
 * plane) that keeps every point inside the frame with a margin.
 */

export type V3 = [number, number, number];

const DEG = Math.PI / 180;

/** Camera basis for an orbit camera looking at the target (same convention as three's lookAt). */
export function orbitBasis(yawDeg: number, pitchDeg: number): { d: V3; r: V3; u: V3 } {
  const yaw = yawDeg * DEG;
  const pitch = Math.max(-88, Math.min(88, pitchDeg)) * DEG;
  // d: from the target toward the camera.
  const d: V3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  // r = normalize(up × d), u = d × r (three.js Matrix4.lookAt with up = +Y).
  let r: V3 = [d[2], 0, -d[0]];
  const rl = Math.hypot(r[0], r[2]) || 1;
  r = [r[0] / rl, 0, r[2] / rl];
  const u: V3 = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
  return { d, r, u };
}

export interface FitResult {
  target: V3;
  distance: number;
}

/**
 * Fit a set of world points (flat xyz triples) into the view of an orbit camera.
 * @param margin  > 1 leaves space around the content (1.1 = content spans 1/1.1 of the frame).
 */
export function fitCamera(points: ArrayLike<number>, yawDeg: number, pitchDeg: number, fovDeg: number, aspect: number, margin: number): FitResult | null {
  const n = Math.floor(points.length / 3);
  if (!n) return null;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3],
      y = points[i * 3 + 1],
      z = points[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX + maxX + minY + maxY + minZ + maxZ)) return null;
  const c: V3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const { d, r, u } = orbitBasis(yawDeg, pitchDeg);
  // Points in camera-plane coordinates relative to the box center.
  const px = new Float64Array(n),
    py = new Float64Array(n),
    pz = new Float64Array(n);
  let zMax = -Infinity,
    radius = 0;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3] - c[0],
      y = points[i * 3 + 1] - c[1],
      z = points[i * 3 + 2] - c[2];
    px[i] = x * r[0] + y * r[1] + z * r[2];
    py[i] = x * u[0] + y * u[1] + z * u[2];
    pz[i] = x * d[0] + y * d[1] + z * d[2];
    if (pz[i] > zMax) zMax = pz[i];
    radius = Math.max(radius, Math.hypot(x, y, z));
  }
  const half = Math.tan((Math.max(5, Math.min(120, fovDeg)) * DEG) / 2);
  const m = Math.max(1, margin);
  const kx = (half * Math.max(0.05, aspect)) / m;
  const ky = half / m;

  // For a distance D (camera at target + D·d), a target shift (a, b) along (r, u) is feasible when
  // |x_i − a| ≤ (D − z_i)·kx and |y_i − b| ≤ (D − z_i)·ky for every point. The feasible ranges
  // of a and b only widen as D grows, so the smallest D is found by bisection.
  const ranges = (D: number) => {
    let loA = -Infinity,
      hiA = Infinity,
      loB = -Infinity,
      hiB = Infinity;
    for (let i = 0; i < n; i++) {
      const depth = D - pz[i];
      const wx = depth * kx,
        wy = depth * ky;
      if (px[i] - wx > loA) loA = px[i] - wx;
      if (px[i] + wx < hiA) hiA = px[i] + wx;
      if (py[i] - wy > loB) loB = py[i] - wy;
      if (py[i] + wy < hiB) hiB = py[i] + wy;
    }
    return { loA, hiA, loB, hiB, ok: loA <= hiA && loB <= hiB };
  };
  const minDepth = Math.max(0.05, radius * 0.02);
  let lo = zMax + minDepth;
  let hi = Math.max(lo * 2, lo + radius / Math.min(kx, ky) + radius + 1);
  for (let k = 0; k < 60 && !ranges(hi).ok; k++) hi *= 2;
  for (let k = 0; k < 48; k++) {
    const mid = (lo + hi) / 2;
    if (ranges(mid).ok) hi = mid;
    else lo = mid;
  }
  const f = ranges(hi);
  const a = f.ok ? (f.loA + f.hiA) / 2 : 0;
  const b = f.ok ? (f.loB + f.hiB) / 2 : 0;
  return {
    target: [c[0] + a * r[0] + b * u[0], c[1] + a * r[1] + b * u[1], c[2] + a * r[2] + b * u[2]],
    distance: hi,
  };
}

/** Largest |NDC| coordinate of the points for the given orbit camera (> 1 means outside the frame). */
export function maxNdcExtent(points: ArrayLike<number>, target: V3, yawDeg: number, pitchDeg: number, distance: number, fovDeg: number, aspect: number): number {
  const { d, r, u } = orbitBasis(yawDeg, pitchDeg);
  const half = Math.tan((Math.max(5, Math.min(120, fovDeg)) * DEG) / 2);
  let worst = 0;
  const n = Math.floor(points.length / 3);
  for (let i = 0; i < n; i++) {
    const x = points[i * 3] - target[0],
      y = points[i * 3 + 1] - target[1],
      z = points[i * 3 + 2] - target[2];
    const depth = distance - (x * d[0] + y * d[1] + z * d[2]);
    if (depth <= 1e-6) return Infinity;
    const nx = Math.abs(x * r[0] + y * r[1] + z * r[2]) / (depth * half * aspect);
    const ny = Math.abs(x * u[0] + y * u[1] + z * u[2]) / (depth * half);
    if (nx > worst) worst = nx;
    if (ny > worst) worst = ny;
  }
  return worst;
}

/**
 * Supersampling factor for an offscreen render: up to 2× for smooth toon edges, but capped so the
 * multisampled drawing buffer stays within ~8.5 MP (a 1080p frame at 2×) — larger MSAA buffers
 * (hundreds of MB) risk GPU context loss / out-of-memory on integrated GPUs. 4K outputs render 1:1.
 */
export function supersampleFactor(w: number, h: number, maxSide: number, maxPixels = 8_500_000): number {
  const bySide = maxSide / Math.max(1, w, h);
  const byArea = Math.sqrt(maxPixels / Math.max(1, w * h));
  return Math.max(1, Math.min(2, bySide, byArea));
}
