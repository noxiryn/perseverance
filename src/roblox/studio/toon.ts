/**
 * Pure helpers for the Pose Studio look (no three.js dependency, unit-tested):
 *  - toon gradient maps with hand-placed band thresholds,
 *  - camera-relative light directions.
 */

export const GRADIENT_RES = 256;

/**
 * Toon ramp sampled by three's MeshToonMaterial at `dot(N, L) * 0.5 + 0.5`.
 *
 * Faces turned away from a light (dot ≤ ~0.03) receive nothing from it (value 0) — shadows come
 * from the ambient/fill light only, so a rim light behind the character never brightens the front.
 * The lit half is split into `steps - 1` flat bands whose thresholds are spread between grazing
 * light (dot ≈ 0.03) and ~45° incidence (dot ≈ 0.7), giving the posterized 3–4 tone look of
 * cel-shaded GFX. The first threshold sits slightly above 0 so faces exactly perpendicular to a
 * light don't flicker between bands; sample the ramp with linear filtering at a high resolution so
 * band edges are crisp but never noisy.
 */
export function toonGradient(steps: number, res = GRADIENT_RES): Uint8Array {
  const n = Math.max(2, Math.min(6, Math.round(steps)));
  const lit = n - 1; // number of lit bands
  // Band start positions as dot(N, L).
  const dots: number[] = [];
  if (lit === 1) dots.push(0.1);
  else for (let k = 0; k < lit; k++) dots.push(0.03 + (0.7 - 0.03) * (k / (lit - 1)));
  const values: number[] = [];
  for (let k = 0; k < lit; k++) values.push(lit === 1 ? 1 : 0.35 + 0.65 * Math.pow(k / (lit - 1), 0.85));
  const out = new Uint8Array(res);
  for (let i = 0; i < res; i++) {
    const dot = ((i + 0.5) / res) * 2 - 1;
    let v = 0;
    for (let k = 0; k < lit; k++) if (dot >= dots[k]) v = values[k];
    out[i] = Math.round(v * 255);
  }
  return out;
}

/**
 * World-space unit direction toward a light placed relative to the camera.
 * `azimuth` 0° = from the camera, +90° = from the right of the frame, ±180° = from behind the
 * subject (rim); `elevation` is degrees above the world horizon. `cameraYaw` is the camera's orbit
 * angle (0 = in front of the character on +Z, + = toward the character's left / +X).
 */
export function lightDirection(cameraYaw: number, azimuth: number, elevation: number): [number, number, number] {
  const a = ((cameraYaw + azimuth) * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** Orbit yaw (degrees) of a camera at `pos` looking at `target` (same convention as StudioCamera.yaw). */
export function yawOf(pos: { x: number; z: number }, target: { x: number; z: number }): number {
  const dx = pos.x - target.x;
  const dz = pos.z - target.z;
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return (Math.atan2(dx, dz) * 180) / Math.PI;
}
