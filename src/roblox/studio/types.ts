/**
 * Pose Studio state — a plain JSON object (stored in `layer.generator.params` so renders can be
 * re-edited). All angles are degrees; distances are Roblox studs.
 */

export type RigType = 'R6' | 'R15';
export type Vec3 = [number, number, number];

export const JOINTS_R15 = [
  'root',
  'waist',
  'neck',
  'rightShoulder',
  'rightElbow',
  'rightWrist',
  'leftShoulder',
  'leftElbow',
  'leftWrist',
  'rightHip',
  'rightKnee',
  'rightAnkle',
  'leftHip',
  'leftKnee',
  'leftAnkle',
] as const;
export type JointId = (typeof JOINTS_R15)[number];

export const JOINTS_R6: JointId[] = ['root', 'neck', 'rightShoulder', 'leftShoulder', 'rightHip', 'leftHip'];

export const JOINT_LABELS: Record<JointId, string> = {
  root: 'Body',
  waist: 'Waist',
  neck: 'Neck',
  rightShoulder: 'R Shoulder',
  rightElbow: 'R Elbow',
  rightWrist: 'R Wrist',
  leftShoulder: 'L Shoulder',
  leftElbow: 'L Elbow',
  leftWrist: 'L Wrist',
  rightHip: 'R Hip',
  rightKnee: 'R Knee',
  rightAnkle: 'R Ankle',
  leftHip: 'L Hip',
  leftKnee: 'L Knee',
  leftAnkle: 'L Ankle',
};

/** Left/right counterpart of each joint (self for center joints). */
export const MIRROR_JOINT: Record<JointId, JointId> = {
  root: 'root',
  waist: 'waist',
  neck: 'neck',
  rightShoulder: 'leftShoulder',
  rightElbow: 'leftElbow',
  rightWrist: 'leftWrist',
  leftShoulder: 'rightShoulder',
  leftElbow: 'rightElbow',
  leftWrist: 'rightWrist',
  rightHip: 'leftHip',
  rightKnee: 'leftKnee',
  rightAnkle: 'leftAnkle',
  leftHip: 'rightHip',
  leftKnee: 'rightKnee',
  leftAnkle: 'rightAnkle',
};

export type Joints = Record<JointId, Vec3>;

export type HairStyle = 'spiky' | 'messy' | 'slick' | 'long' | 'none';
export type FaceStyle = 'blank' | 'smile' | 'shadow';
export type ShadingMode = 'toon' | 'smooth' | 'flat';
export type Framing = 'head' | 'waist' | 'full';

export interface Accessories {
  sword: boolean;
  katana: boolean;
  shield: boolean;
  crown: boolean;
  headphones: boolean;
  cape: boolean;
}

export interface BodyColors {
  head: string;
  torso: string;
  arms: string;
  legs: string;
}

export interface StudioAppearance {
  colors: BodyColors;
  hair: HairStyle;
  hairColor: string;
  face: FaceStyle;
  accessories: Accessories;
  /** Cape / shield / headphones accent color. */
  accentColor: string;
}

export interface StudioPose {
  /** Preset id, or 'custom' once joints were edited by hand. */
  preset: string;
  joints: Joints;
  /** Offset of the whole rig (studs) — crouch/sit/jump heights. */
  rootOffset: Vec3;
  /** Whole-body rotation applied on top of the pose. */
  bodyRotation: Vec3;
}

export interface LightSpec {
  color: string;
  intensity: number;
  /** Degrees around the character: 0 = front, 90 = character's left, 180 = behind. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
}

export interface StudioLighting {
  preset: string;
  key: LightSpec;
  rim: LightSpec;
  fill: LightSpec;
  ambient: number;
  ambientColor: string;
}

export interface StudioCamera {
  preset: string;
  /** Orbit angle around the character (0 = front, + = toward the character's left). */
  yaw: number;
  /** + = camera above looking down. */
  pitch: number;
  fov: number;
  /** Distance multiplier relative to the auto framing distance. */
  distance: number;
  framing: Framing;
  /** World-space target offset from panning. */
  pan: Vec3;
  /** Auto-framing target (computed from the character/model bounds for the framing mode). */
  target: Vec3;
  /** Auto-framing distance (before the `distance` multiplier). */
  baseDistance: number;
}

export interface StudioShading {
  mode: ShadingMode;
  toonSteps: number;
  flatColor: string;
  outline: boolean;
  /** Outline thickness (≈ px per 1000 px of output height). */
  outlineThickness: number;
  outlineColor: string;
}

export interface StudioOutput {
  /** 'document' = document size; otherwise the long side in px (square frame for square docs). */
  size: 'document' | number;
}

export interface StudioState {
  version: 1;
  rig: RigType;
  pose: StudioPose;
  appearance: StudioAppearance;
  camera: StudioCamera;
  lighting: StudioLighting;
  shading: StudioShading;
  output: StudioOutput;
}

/** View-only subset shared by the model importer. */
export interface ViewSettings {
  camera: StudioCamera;
  lighting: StudioLighting;
  shading: StudioShading;
  output: StudioOutput;
}

export function zeroJoints(): Joints {
  const j = {} as Joints;
  for (const id of JOINTS_R15) j[id] = [0, 0, 0];
  return j;
}
