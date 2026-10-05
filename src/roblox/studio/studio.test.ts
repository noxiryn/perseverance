import { describe, expect, it } from 'vitest';
import { MAX_RENDER, freshTransform, outputFrameSize, padCrop, readPlacement, reeditTransform, type Placement } from './placement';
import {
  BODY_COLOR_PRESETS,
  CAMERA_PRESETS,
  LIGHTING_PRESETS,
  POSE_PRESETS,
  cameraFromPreset,
  defaultCamera,
  defaultStudioState,
  lightingFromPreset,
  mirrorJoints,
  normalizeStudioState,
  posePreset,
  resolvePose,
} from './presets';
import { JOINTS_R15, MIRROR_JOINT, zeroJoints } from './types';
import { GRADIENT_RES, lightDirection, toonGradient, yawOf } from './toon';
import { WHITE_PIXEL_PNG, isTextureName, mimeOf, mtlLibsOf, pickMainFile, resourceKey, selectMtlFiles } from './modelFiles';
import { fitCamera, maxNdcExtent, orbitBasis, supersampleFactor } from './framing';
import { inflateSync } from 'node:zlib';
import { cacheModelFiles, cachedModelFiles } from './modelCache';

describe('output frame size', () => {
  it('uses the document size or a long side, keeping the aspect ratio', () => {
    expect(outputFrameSize('document', 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(outputFrameSize(1024, 1920, 1080)).toEqual({ width: 1024, height: 576 });
    expect(outputFrameSize(2048, 1080, 1920)).toEqual({ width: 1152, height: 2048 });
    expect(outputFrameSize('document', null, null)).toEqual({ width: 1024, height: 1024 });
  });

  it('caps renders at 4096 px', () => {
    const r = outputFrameSize('document', 8000, 4000);
    expect(Math.max(r.width, r.height)).toBe(MAX_RENDER);
    expect(r.width / r.height).toBeCloseTo(2, 2);
    expect(outputFrameSize(99999, 512, 512)).toEqual({ width: 4096, height: 4096 });
  });
});

describe('crop + placement', () => {
  it('pads and clamps the crop to the frame', () => {
    expect(padCrop({ x: 5, y: 10, width: 20, height: 30 }, 100, 100, 8)).toEqual({ x: 0, y: 2, width: 33, height: 46 });
    expect(padCrop({ x: 90, y: 90, width: 10, height: 10 }, 100, 100, 8)).toEqual({ x: 82, y: 82, width: 18, height: 18 });
  });

  it('places a frame-sized crop exactly over the document when sizes match', () => {
    const p: Placement = { frameW: 1000, frameH: 500, crop: { x: 100, y: 50, width: 200, height: 300 } };
    const t = freshTransform(p, 1000, 500);
    expect(t).toMatchObject({ x: 100, y: 50, scaleX: 1, scaleY: 1, rotation: 0 });
  });

  it('scales a smaller render up to fit the document (contain, centered)', () => {
    const p: Placement = { frameW: 500, frameH: 500, crop: { x: 0, y: 0, width: 500, height: 500 } };
    const t = freshTransform(p, 1920, 1080);
    expect(t.scaleX).toBeCloseTo(1080 / 500);
    // box center at the document center
    expect(t.x + 250).toBeCloseTo(960);
    expect(t.y + 250).toBeCloseTo(540);
  });

  it('re-edit keeps the frame → document mapping of a moved/scaled layer', () => {
    const old: Placement = { frameW: 1000, frameH: 1000, crop: { x: 400, y: 300, width: 200, height: 400 } };
    const oldT = { x: 50, y: 60, scaleX: 0.5, scaleY: 0.5, rotation: 0 };
    // Identical re-render → identical transform.
    expect(reeditTransform(old, oldT, old)).toMatchObject({ x: 50, y: 60, scaleX: 0.5, scaleY: 0.5 });
    // New render at twice the resolution with the same content → half the scale, same doc box center.
    const next: Placement = { frameW: 2000, frameH: 2000, crop: { x: 800, y: 600, width: 400, height: 800 } };
    const t = reeditTransform(old, oldT, next);
    expect(t.scaleX).toBeCloseTo(0.25);
    expect(t.x + next.crop.width / 2).toBeCloseTo(oldT.x + old.crop.width / 2);
    expect(t.y + next.crop.height / 2).toBeCloseTo(oldT.y + old.crop.height / 2);
  });

  it('re-edit follows a shifted crop through the layer scale and rotation', () => {
    const old: Placement = { frameW: 1000, frameH: 1000, crop: { x: 400, y: 400, width: 200, height: 200 } };
    const oldT = { x: 0, y: 0, scaleX: 2, scaleY: 2, rotation: 90 };
    const next: Placement = { frameW: 1000, frameH: 1000, crop: { x: 410, y: 400, width: 200, height: 200 } };
    const t = reeditTransform(old, oldT, next);
    // +10 frame px in x → scaled ×2 → rotated 90° → +20 doc px in y
    expect(t.x).toBeCloseTo(0);
    expect(t.y).toBeCloseTo(20);
    expect(t.rotation).toBe(90);
  });

  it('reads placements defensively', () => {
    expect(readPlacement(null)).toBeNull();
    expect(readPlacement({ frameW: 1, frameH: 2 })).toBeNull();
    expect(readPlacement({ frameW: 10, frameH: 20, crop: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
      frameW: 10,
      frameH: 20,
      crop: { x: 1, y: 2, width: 3, height: 4 },
    });
  });
});

describe('presets', () => {
  it('has at least 16 pose presets with unique ids, including the required ones', () => {
    expect(POSE_PRESETS.length).toBeGreaterThanOrEqual(16);
    const ids = POSE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = POSE_PRESETS.map((p) => p.name);
    for (const n of ['Idle', 'T-Pose', 'Walk', 'Run', 'Jump', 'Sit', 'Wave', 'Point', 'Fighting Stance', 'Sword Slash', 'Sword on Shoulder', 'Crossed Arms', 'Hands on Hips', 'Hero Landing', 'Looking Back', 'Thinking', 'Kneel'])
      expect(names).toContain(n);
  });

  it('resolves every pose into finite joints for both rigs', () => {
    for (const p of POSE_PRESETS)
      for (const rig of ['R6', 'R15'] as const) {
        const r = resolvePose(p, rig);
        for (const id of JOINTS_R15) {
          expect(r.joints[id]).toHaveLength(3);
          for (const v of r.joints[id]) expect(Number.isFinite(v)).toBe(true);
        }
        expect(r.rootOffset.every(Number.isFinite)).toBe(true);
      }
  });

  it('applies R6 overrides', () => {
    const sit = posePreset('sit')!;
    expect(resolvePose(sit, 'R6').rootOffset).toEqual([0, -1, 0]);
    expect(resolvePose(sit, 'R15').rootOffset).toEqual([0, -0.85, 0]);
  });

  it('resolvePose never shares arrays with the preset', () => {
    const p = posePreset('wave')!;
    const r = resolvePose(p, 'R15');
    r.joints.rightShoulder[0] = 999;
    expect(p.joints.rightShoulder![0]).not.toBe(999);
  });

  it('lighting, camera and body color presets are complete', () => {
    const lightIds = LIGHTING_PRESETS.map((l) => l.id);
    expect(lightIds).toEqual(expect.arrayContaining(['studio', 'dramaticRim', 'sunset', 'noir', 'crimson', 'violetGothic', 'neon']));
    const camIds = CAMERA_PRESETS.map((c) => c.id);
    expect(camIds).toEqual(expect.arrayContaining(['front', 'threeQuarterLeft', 'threeQuarterRight', 'lowHero', 'high', 'profile', 'backShoulder']));
    expect(BODY_COLOR_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(lightingFromPreset('nope').preset).toBe('studio');
    const cam = cameraFromPreset('lowHero', { ...defaultCamera(), pan: [1, 2, 3], distance: 2 });
    expect(cam).toMatchObject({ preset: 'lowHero', pitch: -24, pan: [0, 0, 0], distance: 1 });
  });

  it('mirroring twice restores the pose', () => {
    const j = resolvePose(posePreset('point')!, 'R15').joints;
    const back = mirrorJoints(mirrorJoints(j, MIRROR_JOINT), MIRROR_JOINT);
    for (const id of JOINTS_R15) for (let k = 0; k < 3; k++) expect(back[id][k]).toBeCloseTo(j[id][k]);
    const m = mirrorJoints(j, MIRROR_JOINT);
    expect(m.leftShoulder[0]).toBe(j.rightShoulder[0]);
    expect(m.leftShoulder[2]).toBe(-j.rightShoulder[2] || 0);
  });

  it('normalizes garbage and partial states over the defaults', () => {
    const d = defaultStudioState();
    expect(normalizeStudioState(null)).toEqual(d);
    expect(normalizeStudioState('x')).toEqual(d);
    const n = normalizeStudioState({ rig: 'R15', pose: { joints: { neck: [1, 2, 3], waist: ['a', 2, 3] } }, appearance: { hair: 'long', colors: { head: '#ff0000' } }, camera: { baseDistance: -4 } });
    expect(n.rig).toBe('R15');
    expect(n.pose.joints.neck).toEqual([1, 2, 3]);
    expect(n.pose.joints.waist).toEqual([0, 0, 0]);
    expect(n.pose.preset).toBe('custom');
    expect(n.appearance.hair).toBe('long');
    expect(n.appearance.colors.head).toBe('#ff0000');
    expect(n.appearance.colors.torso).toBe(d.appearance.colors.torso);
    expect(n.camera.baseDistance).toBe(d.camera.baseDistance);
    expect(normalizeStudioState({ rig: 'R99' }).rig).toBe('R6');
  });

  it('round-trips through JSON (stored on layer.generator.params)', () => {
    const s = defaultStudioState();
    s.pose.joints = { ...zeroJoints(), neck: [5, 6, 7] };
    expect(normalizeStudioState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('toon ramp + camera-relative lights', () => {
  it('builds ramps with no light on faces turned away and N-1 lit bands', () => {
    for (const steps of [2, 3, 4, 5, 6]) {
      const g = toonGradient(steps);
      expect(g.length).toBe(GRADIENT_RES);
      expect(g[0]).toBe(0);
      expect(g[Math.floor(GRADIENT_RES * 0.49)]).toBe(0); // dot < 0
      expect(g[GRADIENT_RES - 1]).toBe(255);
      const distinct = new Set(g);
      expect(distinct.size).toBe(steps); // 0 + (steps - 1) lit values
      for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThanOrEqual(g[i - 1]);
    }
    expect(toonGradient(99)).toEqual(toonGradient(6));
  });

  it('places lights relative to the camera yaw', () => {
    const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));
    near(lightDirection(0, 0, 0), [0, 0, 1]); // from the camera at the front
    near(lightDirection(0, 90, 0), [1, 0, 0]); // frame right = +X when looking from the front
    near(lightDirection(90, 0, 0), [1, 0, 0]); // camera orbited to +X
    near(lightDirection(0, 180, 0), [0, 0, -1]); // from behind
    near(lightDirection(0, 0, 90), [0, 1, 0]);
    expect(yawOf({ x: 1, z: 0 }, { x: 0, z: 0 })).toBeCloseTo(90);
    expect(yawOf({ x: 0, z: 5 }, { x: 0, z: 0 })).toBeCloseTo(0);
    expect(yawOf({ x: 0, z: 0 }, { x: 0, z: 0 })).toBe(0);
  });
});

describe('model files', () => {
  it('matches resources by case-insensitive base name', () => {
    expect(resourceKey('textures\\Body_Tex.PNG')).toBe('body_tex.png');
    expect(resourceKey('https://x.y/a/b%20c.png?v=1#f')).toBe('b c.png');
    expect(resourceKey('./foo/bar.mtl')).toBe('bar.mtl');
  });

  it('picks the main model file (glb > gltf > fbx > obj)', () => {
    expect(pickMainFile([{ name: 'a.png' }, { name: 'a.mtl' }, { name: 'Avatar.OBJ' }])?.name).toBe('Avatar.OBJ');
    expect(pickMainFile([{ name: 'a.obj' }, { name: 'b.glb' }])?.name).toBe('b.glb');
    expect(pickMainFile([{ name: 'a.png' }])).toBeNull();
  });

  it('parses mtllib references', () => {
    expect(mtlLibsOf('# comment\nmtllib Avatar.mtl\nv 0 0 0\n')).toEqual(['Avatar.mtl']);
    expect(mtlLibsOf('mtllib a.mtl b.mtl\n')).toEqual(['a.mtl', 'b.mtl']);
    expect(mtlLibsOf('mtllib my model.mtl\n')).toEqual(['my model.mtl']);
    expect(mtlLibsOf('v 1 2 3')).toEqual([]);
  });

  it('knows texture names and MIME types', () => {
    expect(isTextureName('a.PNG')).toBe(true);
    expect(isTextureName('a.tga')).toBe(true);
    expect(isTextureName('a.mtl')).toBe(false);
    expect(mimeOf('x.jpeg')).toBe('image/jpeg');
    expect(mimeOf('x.gltf')).toBe('model/gltf+json');
    expect(mimeOf('x.bin')).toBe('application/octet-stream');
  });

  it('caches model files by name + size for re-editing', () => {
    const files = [{ name: 'a.obj', data: new ArrayBuffer(8) }];
    const key = cacheModelFiles(files);
    expect(cachedModelFiles(key)).toBe(files);
    expect(cachedModelFiles('missing')).toBeNull();
    expect(cachedModelFiles(42)).toBeNull();
  });
});

describe('missing-texture stand-in', () => {
  it('is a valid opaque white 1×1 RGBA PNG', () => {
    const bytes = Buffer.from(WHITE_PIXEL_PNG.split(',')[1], 'base64');
    expect([...bytes.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    // IHDR: 1×1, 8-bit, color type 6 (RGBA)
    expect(bytes.readUInt32BE(16)).toBe(1);
    expect(bytes.readUInt32BE(20)).toBe(1);
    expect(bytes[24]).toBe(8);
    expect(bytes[25]).toBe(6);
    let p = 8;
    let raw: number[] | null = null;
    while (p < bytes.length) {
      const len = bytes.readUInt32BE(p);
      const type = bytes.toString('ascii', p + 4, p + 8);
      if (type === 'IDAT') raw = [...inflateSync(bytes.subarray(p + 8, p + 8 + len))];
      p += 12 + len;
    }
    // filter byte + RGBA
    expect(raw).toEqual([0, 255, 255, 255, 255]);
  });

  it('selects every referenced MTL library (and falls back to all .mtl files)', () => {
    const files = [{ name: 'Avatar.obj' }, { name: 'b.mtl' }, { name: 'A.MTL' }, { name: 'tex.png' }];
    expect(selectMtlFiles('mtllib a.mtl\nmtllib b.mtl\nv 0 0 0', files).map((f) => f.name)).toEqual(['A.MTL', 'b.mtl']);
    expect(selectMtlFiles('mtllib other.mtl', files).map((f) => f.name)).toEqual(['b.mtl', 'A.MTL']);
    expect(selectMtlFiles('v 0 0 0', [{ name: 'x.obj' }])).toEqual([]);
  });
});

describe('perspective framing', () => {
  /** Corners of an axis-aligned box as flat xyz triples. */
  const box = (min: [number, number, number], max: [number, number, number]) => {
    const out: number[] = [];
    for (let k = 0; k < 8; k++) out.push(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]);
    return out;
  };

  it('builds an orthonormal camera basis matching the orbit convention', () => {
    const { d, r, u } = orbitBasis(35, 6);
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(d, r)).toBeCloseTo(0, 6);
    expect(dot(d, u)).toBeCloseTo(0, 6);
    expect(dot(r, u)).toBeCloseTo(0, 6);
    expect(u[1]).toBeGreaterThan(0); // up stays up
    // Front view: camera on +Z, right = +X
    const f = orbitBasis(0, 0);
    expect(f.d[2]).toBeCloseTo(1, 6);
    expect(f.r[0]).toBeCloseTo(1, 6);
  });

  it('keeps a deep model inside the frame at a 3/4 angle (with the margin)', () => {
    // Two cubes ≈ 3.6 studs wide and deep — the case the old approximation cropped.
    const pts = [...box([-1.8, 0, -1.8], [0, 1.8, 0]), ...box([0, 0, 0], [1.8, 3.6, 1.8])];
    for (const [yaw, pitch] of [[35, 6], [-35, 6], [22, -24], [0, 4], [155, 12]]) {
      const fit = fitCamera(pts, yaw, pitch, 35, 16 / 9, 1.07)!;
      const ext = maxNdcExtent(pts, fit.target, yaw, pitch, fit.distance, 35, 16 / 9);
      expect(ext).toBeLessThanOrEqual(1 / 1.07 + 1e-3);
      // Tight: something touches the margin.
      expect(ext).toBeGreaterThan(1 / 1.07 - 0.02);
    }
  });

  it('centers asymmetric content and respects tall/wide aspect ratios', () => {
    const pts = box([-0.5, 0, -0.5], [0.5, 5, 0.5]);
    for (const aspect of [1, 9 / 16, 16 / 9]) {
      const fit = fitCamera(pts, 0, 0, 35, aspect, 1.1)!;
      expect(maxNdcExtent(pts, fit.target, 0, 0, fit.distance, 35, aspect)).toBeLessThanOrEqual(1 / 1.1 + 1e-3);
      expect(fit.target[1]).toBeGreaterThan(2);
      expect(fit.target[1]).toBeLessThan(3);
    }
    expect(fitCamera([], 0, 0, 35, 1, 1)).toBeNull();
  });

  it('caps supersampling so 4K renders stay 1:1 and 1080p renders get 2×', () => {
    expect(supersampleFactor(1920, 1080, 8192)).toBe(2);
    expect(supersampleFactor(4096, 2304, 8192)).toBe(1);
    expect(supersampleFactor(4096, 4096, 8192)).toBe(1);
    expect(supersampleFactor(1024, 1024, 1536)).toBeCloseTo(1.5, 6);
    expect(supersampleFactor(3000, 3000, 8192)).toBe(1);
    expect(supersampleFactor(2048, 2048, 8192)).toBeGreaterThan(1);
    expect(supersampleFactor(2048, 2048, 8192) * 2048).toBeLessThanOrEqual(Math.sqrt(8_500_000) + 1);
  });
});
