/**
 * Pose Studio presets: poses, body colors, hair colors, lighting, camera angles, defaults.
 *
 * Joint rotation convention (degrees, Euler order 'YXZ', i.e. Z then X then Y about the parent axes),
 * character facing +Z:
 *  - arms/legs hang along -Y; X < 0 swings a limb forward; Z < 0 moves the RIGHT arm/leg outward
 *    (Z > 0 for the left side); Y turns a raised limb around the vertical axis (+Y toward the
 *    character's left);
 *  - elbows flex with X < 0, knees with X > 0;
 *  - neck X > 0 looks down, Y > 0 turns toward the character's left; waist X > 0 leans forward.
 */
import type {
  BodyColors,
  Joints,
  JointId,
  LightSpec,
  StudioCamera,
  StudioLighting,
  StudioState,
  Vec3,
} from './types';
import { zeroJoints } from './types';

export interface PosePreset {
  id: string;
  name: string;
  joints: Partial<Joints>;
  rootOffset?: Vec3;
  /** Overrides for the R6 rig (single-piece limbs): joints + root offset. */
  r6?: { joints?: Partial<Joints>; rootOffset?: Vec3 };
}

export const POSE_PRESETS: PosePreset[] = [
  {
    id: 'idle',
    name: 'Idle',
    joints: { rightShoulder: [0, 0, -5], leftShoulder: [0, 0, 5], rightElbow: [-8, 0, 0], leftElbow: [-8, 0, 0], neck: [3, 0, 0] },
  },
  { id: 'tpose', name: 'T-Pose', joints: { rightShoulder: [0, 0, -90], leftShoulder: [0, 0, 90] } },
  {
    id: 'walk',
    name: 'Walk',
    joints: {
      rightShoulder: [-28, 0, -4],
      leftShoulder: [26, 0, 4],
      rightElbow: [-20, 0, 0],
      leftElbow: [-10, 0, 0],
      rightHip: [24, 0, 0],
      rightKnee: [18, 0, 0],
      leftHip: [-26, 0, 0],
      leftKnee: [8, 0, 0],
    },
    rootOffset: [0, -0.05, 0],
  },
  {
    id: 'run',
    name: 'Run',
    joints: {
      root: [8, 0, 0],
      waist: [12, 0, 0],
      neck: [-12, 0, 0],
      rightShoulder: [-70, 0, -6],
      rightElbow: [-70, 0, 0],
      leftShoulder: [50, 0, 6],
      leftElbow: [-55, 0, 0],
      rightHip: [35, 0, 0],
      rightKnee: [85, 0, 0],
      leftHip: [-60, 0, 0],
      leftKnee: [45, 0, 0],
    },
    rootOffset: [0, -0.15, 0],
  },
  {
    id: 'jump',
    name: 'Jump',
    joints: {
      neck: [-8, 0, 0],
      rightShoulder: [-150, 0, -25],
      leftShoulder: [-150, 0, 25],
      rightElbow: [-15, 0, 0],
      leftElbow: [-15, 0, 0],
      rightHip: [-35, 0, -4],
      rightKnee: [65, 0, 0],
      leftHip: [-12, 0, 4],
      leftKnee: [35, 0, 0],
    },
    rootOffset: [0, 0.7, 0],
  },
  {
    id: 'sit',
    name: 'Sit',
    joints: {
      rightHip: [-90, 0, -3],
      leftHip: [-90, 0, 3],
      rightKnee: [90, 0, 0],
      leftKnee: [90, 0, 0],
      rightShoulder: [-25, 0, -4],
      leftShoulder: [-25, 0, 4],
      rightElbow: [-35, 0, 0],
      leftElbow: [-35, 0, 0],
    },
    rootOffset: [0, -0.85, 0],
    r6: {
      joints: { rightHip: [-90, 0, 0], leftHip: [-90, 0, 0], rightKnee: [0, 0, 0], leftKnee: [0, 0, 0], rightShoulder: [-35, 0, -3], leftShoulder: [-35, 0, 3], rightElbow: [0, 0, 0], leftElbow: [0, 0, 0] },
      rootOffset: [0, -1, 0],
    },
  },
  {
    id: 'wave',
    name: 'Wave',
    joints: {
      root: [0, 8, 0],
      neck: [0, -8, 6],
      rightShoulder: [0, 0, -110],
      rightElbow: [0, 0, -55],
      rightWrist: [0, 0, -10],
      leftShoulder: [0, 0, 6],
      leftElbow: [-10, 0, 0],
    },
  },
  {
    id: 'point',
    name: 'Point',
    joints: {
      neck: [0, -28, 0],
      rightShoulder: [-88, -32, 0],
      rightElbow: [-5, 0, 0],
      leftShoulder: [5, 0, 5],
      leftElbow: [-12, 0, 0],
    },
  },
  {
    id: 'fighting',
    name: 'Fighting Stance',
    joints: {
      root: [0, 30, 0],
      waist: [6, -8, 0],
      neck: [0, -28, 0],
      rightShoulder: [-55, 0, -12],
      rightElbow: [-105, 25, 0],
      leftShoulder: [-80, 0, 18],
      leftElbow: [-100, -30, 0],
      rightHip: [18, 0, -10],
      rightKnee: [28, 0, 0],
      leftHip: [-28, 0, 10],
      leftKnee: [22, 0, 0],
    },
    rootOffset: [0, -0.2, 0],
    r6: { joints: { rightShoulder: [-95, 15, 0], leftShoulder: [-100, -15, 0], rightElbow: [0, 0, 0], leftElbow: [0, 0, 0] } },
  },
  {
    id: 'swordSlash',
    name: 'Sword Slash',
    joints: {
      root: [0, 20, 0],
      waist: [10, 18, 0],
      neck: [0, -28, 0],
      rightShoulder: [-72, 48, 0],
      rightElbow: [-12, 0, 0],
      rightWrist: [50, 0, 0],
      leftShoulder: [32, 0, 38],
      leftElbow: [-30, 0, 0],
      rightHip: [-48, 0, -10],
      rightKnee: [58, 0, 0],
      leftHip: [30, 0, 12],
      leftKnee: [22, 0, 0],
    },
    rootOffset: [0, -0.42, 0],
    r6: {
      joints: {
        root: [8, 30, 0],
        waist: [0, 0, 0],
        neck: [0, -30, 0],
        rightShoulder: [-100, 52, 0],
        rightElbow: [0, 0, 0],
        rightWrist: [0, 0, 0],
        leftShoulder: [30, 0, 35],
        leftElbow: [0, 0, 0],
        rightHip: [-38, 0, -10],
        rightKnee: [0, 0, 0],
        leftHip: [32, 0, 10],
        leftKnee: [0, 0, 0],
      },
      rootOffset: [0, -0.28, 0],
    },
  },
  {
    id: 'swordShoulder',
    name: 'Sword on Shoulder',
    joints: {
      root: [0, 15, 0],
      neck: [0, -12, 0],
      rightShoulder: [-30, 0, -9],
      rightElbow: [2, -80, 117],
      rightWrist: [-15, 60, -1],
      leftShoulder: [0, 0, 8],
      leftElbow: [-10, 0, 0],
      rightHip: [0, 0, -4],
      leftHip: [0, 0, 6],
    },
    r6: { joints: { rightShoulder: [-135, 0, -10], rightElbow: [0, 0, 0], rightWrist: [0, 0, 0] } },
  },
  {
    id: 'crossedArms',
    name: 'Crossed Arms',
    joints: {
      neck: [4, 0, 0],
      rightShoulder: [-46, 1, 29],
      rightElbow: [-30, 0, 41],
      leftShoulder: [-35, -1, -26],
      leftElbow: [-23, 0, -46],
    },
    r6: { joints: { rightShoulder: [-78, 45, 0], leftShoulder: [-70, -42, 0], rightElbow: [0, 0, 0], leftElbow: [0, 0, 0] } },
  },
  {
    id: 'handsOnHips',
    name: 'Hands on Hips',
    joints: {
      rightShoulder: [7, -1, -39],
      rightElbow: [0, -12, 91],
      leftShoulder: [7, 1, 39],
      leftElbow: [0, 12, -91],
      rightHip: [0, 0, -5],
      leftHip: [0, 0, 5],
    },
    r6: { joints: { rightShoulder: [8, 0, -22], leftShoulder: [8, 0, 22], rightElbow: [0, 0, 0], leftElbow: [0, 0, 0] } },
  },
  {
    id: 'heroLanding',
    name: 'Hero Landing',
    joints: {
      root: [8, -18, 0],
      waist: [32, 0, 0],
      neck: [-42, 8, 0],
      rightHip: [-82, 0, -12],
      rightKnee: [92, 0, 0],
      leftHip: [18, 0, 10],
      leftKnee: [104, 0, 0],
      leftAnkle: [-8, 0, 0],
      rightShoulder: [-18, 0, -10],
      rightElbow: [-6, 0, 0],
      leftShoulder: [40, 0, 48],
      leftElbow: [-22, 0, 0],
    },
    rootOffset: [0, -1.12, 0],
    r6: {
      joints: {
        root: [22, -15, 0],
        waist: [0, 0, 0],
        neck: [-32, 8, 0],
        rightHip: [-58, 0, -8],
        rightKnee: [0, 0, 0],
        leftHip: [52, 0, 8],
        leftKnee: [0, 0, 0],
        leftAnkle: [0, 0, 0],
        rightShoulder: [-28, 0, -6],
        rightElbow: [0, 0, 0],
        leftShoulder: [35, 0, 40],
        leftElbow: [0, 0, 0],
      },
      rootOffset: [0, -0.85, 0],
    },
  },
  {
    id: 'lookingBack',
    name: 'Looking Back',
    joints: {
      root: [0, 155, 0],
      waist: [2, -25, 0],
      neck: [12, -65, -6],
      rightShoulder: [8, 0, -6],
      rightElbow: [-10, 0, 0],
      leftShoulder: [-10, 0, 6],
      leftElbow: [-20, 0, 0],
    },
    r6: { joints: { root: [0, 150, 0], waist: [0, 0, 0], neck: [12, -78, 0], rightElbow: [0, 0, 0], leftElbow: [0, 0, 0] } },
  },
  {
    id: 'thinking',
    name: 'Thinking',
    joints: {
      neck: [10, 14, 8],
      rightShoulder: [-32, 1, 17],
      rightElbow: [-1, -45, 103],
      leftShoulder: [-18, 0, 3],
      leftElbow: [1, 27, -87],
    },
    r6: { joints: { rightShoulder: [-118, 28, 0], leftShoulder: [-55, -35, 0], rightElbow: [0, 0, 0], leftElbow: [0, 0, 0] } },
  },
  {
    id: 'kneel',
    name: 'Kneel',
    joints: {
      waist: [8, 0, 0],
      neck: [14, 0, 0],
      rightHip: [-80, 0, -6],
      rightKnee: [80, 0, 0],
      leftHip: [8, 0, 6],
      leftKnee: [92, 0, 0],
      rightShoulder: [-35, 0, -6],
      rightElbow: [-55, 0, 0],
      leftShoulder: [6, 0, 8],
    },
    rootOffset: [0, -0.7, 0],
    r6: { joints: { waist: [0, 0, 0], root: [8, 0, 0], rightHip: [-85, 0, 0], leftHip: [55, 0, 0], rightKnee: [0, 0, 0], leftKnee: [0, 0, 0], rightElbow: [0, 0, 0] }, rootOffset: [0, -0.8, 0] },
  },
  {
    id: 'victory',
    name: 'Victory',
    joints: {
      neck: [-12, 0, 0],
      rightShoulder: [0, 0, -155],
      leftShoulder: [0, 0, 155],
      rightElbow: [0, 0, -10],
      leftElbow: [0, 0, 10],
      rightHip: [0, 0, -6],
      leftHip: [0, 0, 6],
    },
  },
  {
    id: 'guard',
    name: 'Sword Guard',
    joints: {
      root: [0, 25, 0],
      neck: [0, -22, 0],
      rightShoulder: [-29, 0, 24],
      rightElbow: [-55, 0, 44],
      rightWrist: [38, -17, 0],
      leftShoulder: [-25, 1, -23],
      leftElbow: [-49, -1, -44],
      rightHip: [15, 0, -8],
      rightKnee: [15, 0, 0],
      leftHip: [-20, 0, 8],
      leftKnee: [15, 0, 0],
    },
    rootOffset: [0, -0.15, 0],
    r6: { joints: { rightShoulder: [-45, 25, 0], leftShoulder: [-35, -20, 0], rightElbow: [0, 0, 0], leftElbow: [0, 0, 0], rightWrist: [0, 0, 0] } },
  },
];

export function posePreset(id: string): PosePreset | undefined {
  return POSE_PRESETS.find((p) => p.id === id);
}

/** Resolve a preset into full joints + root offset for a rig. */
export function resolvePose(preset: PosePreset, rig: 'R6' | 'R15'): { joints: Joints; rootOffset: Vec3 } {
  const joints = zeroJoints();
  for (const [k, v] of Object.entries(preset.joints) as [JointId, Vec3][]) joints[k] = [...v];
  let rootOffset: Vec3 = preset.rootOffset ? [...preset.rootOffset] : [0, 0, 0];
  if (rig === 'R6' && preset.r6) {
    for (const [k, v] of Object.entries(preset.r6.joints ?? {}) as [JointId, Vec3][]) joints[k] = [...v];
    if (preset.r6.rootOffset) rootOffset = [...preset.r6.rootOffset];
  }
  return { joints, rootOffset };
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

export interface BodyColorPreset {
  id: string;
  name: string;
  colors: BodyColors;
}

export const BODY_COLOR_PRESETS: BodyColorPreset[] = [
  { id: 'skinBlack', name: 'Black Outfit', colors: { head: '#d9b38c', torso: '#2a2a2f', arms: '#d9b38c', legs: '#303036' } },
  { id: 'allBlack', name: 'All Black', colors: { head: '#e3b98f', torso: '#2a2a2f', arms: '#2a2a2f', legs: '#2a2a2f' } },
  { id: 'classic', name: 'Classic', colors: { head: '#f5cd30', torso: '#0d69ac', arms: '#f5cd30', legs: '#a4bd47' } },
  { id: 'classicBlue', name: 'Classic Blue', colors: { head: '#f5cd30', torso: '#1b6fc7', arms: '#f5cd30', legs: '#28497a' } },
  { id: 'classicGreen', name: 'Classic Green', colors: { head: '#f5cd30', torso: '#4b974b', arms: '#f5cd30', legs: '#2c5c2c' } },
  { id: 'crimson', name: 'Crimson Coat', colors: { head: '#d9b38c', torso: '#7a1214', arms: '#7a1214', legs: '#2a2a2f' } },
  { id: 'whiteShirt', name: 'White Shirt', colors: { head: '#d9b38c', torso: '#e8e6e1', arms: '#e8e6e1', legs: '#34343a' } },
  { id: 'violet', name: 'Violet', colors: { head: '#d9b38c', torso: '#3b2f6b', arms: '#3b2f6b', legs: '#2a2633' } },
  { id: 'guest', name: 'Guest', colors: { head: '#a3a2a5', torso: '#2a2a2f', arms: '#a3a2a5', legs: '#2a2a2f' } },
];

export const SKIN_TONES = ['#f5cd30', '#f1d2b5', '#e3b98f', '#d9b38c', '#b98a5e', '#8d5a3b', '#5c3a21', '#a3a2a5'];
export const HAIR_COLORS = ['#35323f', '#15151a', '#4a3226', '#7d78a6', '#d9c27a', '#b31b1b', '#eeeeee', '#2f6fd6'];

export const HAIR_STYLES: { value: 'spiky' | 'messy' | 'slick' | 'long' | 'none'; label: string }[] = [
  { value: 'spiky', label: 'Spiky Anime' },
  { value: 'messy', label: 'Messy' },
  { value: 'slick', label: 'Slick Back' },
  { value: 'long', label: 'Long' },
  { value: 'none', label: 'None' },
];

export const FACE_STYLES: { value: 'blank' | 'smile' | 'shadow'; label: string }[] = [
  { value: 'blank', label: 'Blank' },
  { value: 'smile', label: 'Classic Smile' },
  { value: 'shadow', label: 'Eye Shadow' },
];

/* ------------------------------------------------------------------ */
/* Lighting                                                            */
/* ------------------------------------------------------------------ */

const L = (color: string, intensity: number, azimuth: number, elevation: number): LightSpec => ({ color, intensity, azimuth, elevation });

export interface LightingPreset extends Omit<StudioLighting, 'preset'> {
  id: string;
  name: string;
  swatch: string[];
}

/**
 * Light directions are relative to the camera (see LightSpec): 0° = from the camera, -90° = from
 * the left of the frame, +90° = from the right, ±180° = from behind. Rims sit side-back (~125°) so
 * they catch the side faces visible in 3/4 views.
 */
export const LIGHTING_PRESETS: LightingPreset[] = [
  { id: 'studio', name: 'Studio', swatch: ['#f2f2f2', '#9aa7c7'], key: L('#ffffff', 2.6, -40, 50), rim: L('#ffffff', 1.4, 140, 35), fill: L('#dfe8ff', 0.3, 60, 5), ambient: 0.55, ambientColor: '#ffffff' },
  { id: 'dramaticRim', name: 'Dramatic Rim', swatch: ['#ffffff', '#2a3350'], key: L('#fff2e0', 3.2, -120, 32), rim: L('#ffffff', 4.2, 125, 26), fill: L('#4a5a80', 0.45, 0, 12), ambient: 0.1, ambientColor: '#ffffff' },
  { id: 'sunset', name: 'Sunset', swatch: ['#ffb35c', '#6a3a8a'], key: L('#ffc46b', 2.5, -50, 22), rim: L('#ff7a2e', 4.2, 130, 34), fill: L('#6a3a8a', 0.7, 80, 0), ambient: 0.35, ambientColor: '#ffcf99' },
  { id: 'noir', name: 'Noir', swatch: ['#ffffff', '#000000'], key: L('#ffffff', 3.6, -62, 48), rim: L('#ffffff', 0, 125, 20), fill: L('#ffffff', 0, 60, 10), ambient: 0.05, ambientColor: '#ffffff' },
  { id: 'crimson', name: 'Crimson', swatch: ['#ff1a1a', '#200004'], key: L('#fff0e8', 2.3, -32, 38), rim: L('#ff1a1a', 5.5, 125, 20), fill: L('#5a000c', 0.6, 75, 0), ambient: 0.12, ambientColor: '#ff5050' },
  { id: 'violetGothic', name: 'Violet Gothic', swatch: ['#f4f0ff', '#8b7cf6'], key: L('#f4f0ff', 2.6, -45, 48), rim: L('#8b7cf6', 4.0, 125, 26), fill: L('#3b2f6b', 0.7, 70, 0), ambient: 0.32, ambientColor: '#b8a8ff' },
  { id: 'neon', name: 'Neon', swatch: ['#3cf2ff', '#ff2bd6'], key: L('#3cf2ff', 3.0, -100, 16), rim: L('#ff2bd6', 3.8, 105, 16), fill: L('#2b2bff', 0.6, 0, 0), ambient: 0.1, ambientColor: '#ffffff' },
];

export function lightingFromPreset(id: string): StudioLighting {
  const p = LIGHTING_PRESETS.find((x) => x.id === id) ?? LIGHTING_PRESETS[0];
  return {
    preset: p.id,
    key: { ...p.key },
    rim: { ...p.rim },
    fill: { ...p.fill },
    ambient: p.ambient,
    ambientColor: p.ambientColor,
  };
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export interface CameraPreset {
  id: string;
  name: string;
  yaw: number;
  pitch: number;
  fov?: number;
}

export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'front', name: 'Front', yaw: 0, pitch: 4 },
  { id: 'threeQuarterLeft', name: '3/4 Left', yaw: 35, pitch: 6 },
  { id: 'threeQuarterRight', name: '3/4 Right', yaw: -35, pitch: 6 },
  { id: 'lowHero', name: 'Low Hero', yaw: 22, pitch: -24, fov: 42 },
  { id: 'high', name: 'High Angle', yaw: 18, pitch: 38 },
  { id: 'profile', name: 'Profile', yaw: 90, pitch: 2 },
  { id: 'backShoulder', name: 'Back Shoulder', yaw: 155, pitch: 12 },
];

export function cameraFromPreset(id: string, base: StudioCamera): StudioCamera {
  const p = CAMERA_PRESETS.find((x) => x.id === id);
  if (!p) return base;
  return { ...base, preset: p.id, yaw: p.yaw, pitch: p.pitch, fov: p.fov ?? base.fov, pan: [0, 0, 0], distance: 1 };
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export function defaultCamera(): StudioCamera {
  return {
    preset: 'threeQuarterLeft',
    yaw: 35,
    pitch: 6,
    fov: 35,
    distance: 1,
    framing: 'full',
    pan: [0, 0, 0],
    target: [0, 2.7, 0],
    baseDistance: 11,
  };
}

export function defaultStudioState(): StudioState {
  const idle = resolvePose(POSE_PRESETS[0], 'R6');
  return {
    version: 1,
    rig: 'R6',
    pose: { preset: 'idle', joints: idle.joints, rootOffset: idle.rootOffset, bodyRotation: [0, 0, 0] },
    appearance: {
      colors: { ...BODY_COLOR_PRESETS[0].colors },
      hair: 'spiky',
      hairColor: '#35323f',
      face: 'blank',
      accessories: { sword: false, katana: false, shield: false, crown: false, headphones: false, cape: false },
      accentColor: '#7a1214',
    },
    camera: defaultCamera(),
    lighting: lightingFromPreset('studio'),
    shading: { mode: 'toon', toonSteps: 4, flatColor: '#0b0b0b', outline: true, outlineThickness: 3, outlineColor: '#000000' },
    output: { size: 'document' },
  };
}

/** Merge a possibly older/partial stored state over the defaults (re-edit robustness). */
export function normalizeStudioState(raw: unknown): StudioState {
  const d = defaultStudioState();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<StudioState>;
  const joints = zeroJoints();
  const rj = (r.pose?.joints ?? {}) as Partial<Joints>;
  for (const k of Object.keys(joints) as JointId[]) {
    const v = rj[k];
    if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')) joints[k] = [v[0], v[1], v[2]];
  }
  const vec = (v: unknown, def: Vec3): Vec3 =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number') ? [v[0], v[1], v[2]] : def;
  return {
    version: 1,
    rig: r.rig === 'R15' ? 'R15' : 'R6',
    pose: {
      preset: typeof r.pose?.preset === 'string' ? r.pose.preset : 'custom',
      joints,
      rootOffset: vec(r.pose?.rootOffset, [0, 0, 0]),
      bodyRotation: vec(r.pose?.bodyRotation, [0, 0, 0]),
    },
    appearance: {
      ...d.appearance,
      ...(r.appearance ?? {}),
      colors: { ...d.appearance.colors, ...(r.appearance?.colors ?? {}) },
      accessories: { ...d.appearance.accessories, ...(r.appearance?.accessories ?? {}) },
    },
    camera: {
      ...d.camera,
      ...(r.camera ?? {}),
      pan: vec(r.camera?.pan, [0, 0, 0]),
      target: vec(r.camera?.target, d.camera.target),
      baseDistance: typeof r.camera?.baseDistance === 'number' && r.camera.baseDistance > 0 ? r.camera.baseDistance : d.camera.baseDistance,
    },
    lighting: {
      ...d.lighting,
      ...(r.lighting ?? {}),
      key: { ...d.lighting.key, ...(r.lighting?.key ?? {}) },
      rim: { ...d.lighting.rim, ...(r.lighting?.rim ?? {}) },
      fill: { ...d.lighting.fill, ...(r.lighting?.fill ?? {}) },
    },
    shading: { ...d.shading, ...(r.shading ?? {}) },
    output: { ...d.output, ...(r.output ?? {}) },
  };
}

/** Mirror a pose left↔right (swap sides and negate Y/Z rotations). */
export function mirrorJoints(j: Joints, mirrorOf: Record<JointId, JointId>): Joints {
  const out = zeroJoints();
  for (const id of Object.keys(j) as JointId[]) {
    const src = j[mirrorOf[id]];
    out[id] = [src[0], -src[1] || 0, -src[2] || 0];
  }
  return out;
}
