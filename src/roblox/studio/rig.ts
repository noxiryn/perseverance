/**
 * Blocky Roblox rigs (R6 and a lite R15) built from rounded boxes, plus pose application.
 * Units are studs; the character stands on y = 0 facing +Z.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { JointId, Joints, RigType, StudioPose } from './types';

export type PartRole = 'head' | 'torso' | 'arms' | 'legs';

export interface RigAttachments {
  head: THREE.Object3D;
  /** Upper torso center (back accessories, cape). */
  torso: THREE.Object3D;
  rightHand: THREE.Object3D;
  leftHand: THREE.Object3D;
  /** Outer side of the left forearm (shield). */
  leftForearm: THREE.Object3D;
}

export interface RigBuild {
  type: RigType;
  /** Whole figure: position = root offset, rotation = body rotation. */
  figure: THREE.Group;
  joints: Partial<Record<JointId, THREE.Object3D>>;
  attach: RigAttachments;
  /** Head mesh (for framing). */
  head: THREE.Mesh;
  meshes: THREE.Mesh[];
}

export interface RigMaterials {
  /** Material (or per-face array for the head) for a body part. */
  part(role: PartRole): THREE.Material | THREE.Material[];
  /** Register a geometry for disposal. */
  track<T extends { dispose(): void }>(g: T): T;
}

const DEG = Math.PI / 180;

function box(w: number, h: number, d: number, r: number, mats: RigMaterials) {
  return mats.track(new RoundedBoxGeometry(w, h, d, 3, r));
}

function pivot(parent: THREE.Object3D, x: number, y: number, z: number, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

function part(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material | THREE.Material[],
  y: number,
  joint: JointId,
  meshes: THREE.Mesh[],
  name: string,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  m.name = name;
  m.userData.joint = joint;
  parent.add(m);
  meshes.push(m);
  return m;
}

/** Rounded classic head (slightly wider than deep). */
function headGeometry(mats: RigMaterials) {
  return box(1.25, 1.2, 1.2, 0.34, mats);
}

export function buildRig(type: RigType, mats: RigMaterials): RigBuild {
  return type === 'R15' ? buildR15(mats) : buildR6(mats);
}

function buildR6(mats: RigMaterials): RigBuild {
  const meshes: THREE.Mesh[] = [];
  const figure = new THREE.Group();
  figure.name = 'figure';
  const root = pivot(figure, 0, 3, 0, 'root');
  part(root, box(2, 2, 1, 0.08, mats), mats.part('torso'), 0, 'root', meshes, 'Torso');
  const neck = pivot(root, 0, 1, 0, 'neck');
  const head = part(neck, headGeometry(mats), mats.part('head'), 0.6, 'neck', meshes, 'Head');
  const headAttach = pivot(neck, 0, 0.6, 0, 'headAttach');
  const armGeo = box(1, 2, 1, 0.08, mats);
  const legGeo = box(1, 2, 1, 0.08, mats);
  const rs = pivot(root, -1.5, 0.5, 0, 'rightShoulder');
  part(rs, armGeo, mats.part('arms'), -0.5, 'rightShoulder', meshes, 'Right Arm');
  const ls = pivot(root, 1.5, 0.5, 0, 'leftShoulder');
  part(ls, armGeo, mats.part('arms'), -0.5, 'leftShoulder', meshes, 'Left Arm');
  const rh = pivot(root, -0.5, -1, 0, 'rightHip');
  part(rh, legGeo, mats.part('legs'), -1, 'rightHip', meshes, 'Right Leg');
  const lh = pivot(root, 0.5, -1, 0, 'leftHip');
  part(lh, legGeo, mats.part('legs'), -1, 'leftHip', meshes, 'Left Leg');
  return {
    type: 'R6',
    figure,
    joints: { root, neck, rightShoulder: rs, leftShoulder: ls, rightHip: rh, leftHip: lh },
    attach: {
      head: headAttach,
      torso: pivot(root, 0, 0, 0, 'torsoAttach'),
      rightHand: pivot(rs, 0, -1.42, 0, 'rightHand'),
      leftHand: pivot(ls, 0, -1.42, 0, 'leftHand'),
      leftForearm: pivot(ls, 0.52, -0.95, 0, 'leftForearm'),
    },
    head,
    meshes,
  };
}

function buildR15(mats: RigMaterials): RigBuild {
  const meshes: THREE.Mesh[] = [];
  const figure = new THREE.Group();
  figure.name = 'figure';
  const root = pivot(figure, 0, 2.2, 0, 'root');
  part(root, box(2, 0.42, 1, 0.08, mats), mats.part('torso'), 0, 'root', meshes, 'LowerTorso');
  const waist = pivot(root, 0, 0.2, 0, 'waist');
  part(waist, box(2, 1.6, 1, 0.08, mats), mats.part('torso'), 0.8, 'waist', meshes, 'UpperTorso');
  const neck = pivot(waist, 0, 1.6, 0, 'neck');
  const head = part(neck, headGeometry(mats), mats.part('head'), 0.6, 'neck', meshes, 'Head');
  const headAttach = pivot(neck, 0, 0.6, 0, 'headAttach');

  const upper = box(1, 0.86, 1, 0.08, mats);
  const lower = box(1, 0.9, 1, 0.08, mats);
  const end = box(1, 0.32, 1, 0.08, mats);

  const arm = (side: 1 | -1) => {
    const p = side < 0 ? 'right' : 'left';
    const P = side < 0 ? 'Right' : 'Left';
    // Shoulder pivot near the top of the upper arm (like Roblox's R15 shoulder attachment), so
    // raised arms swing from the shoulder and the elbow sits 0.7 studs below it.
    const shoulder = pivot(waist, 1.5 * side, 1.45, 0, `${p}Shoulder`);
    part(shoulder, upper, mats.part('arms'), -0.27, `${p}Shoulder` as JointId, meshes, `${P}UpperArm`);
    const elbow = pivot(shoulder, 0, -0.7, 0, `${p}Elbow`);
    part(elbow, lower, mats.part('arms'), -0.42, `${p}Elbow` as JointId, meshes, `${P}LowerArm`);
    const wrist = pivot(elbow, 0, -0.85, 0, `${p}Wrist`);
    part(wrist, end, mats.part('arms'), -0.15, `${p}Wrist` as JointId, meshes, `${P}Hand`);
    return { shoulder, elbow, wrist };
  };
  const leg = (side: 1 | -1) => {
    const p = side < 0 ? 'right' : 'left';
    const P = side < 0 ? 'Right' : 'Left';
    const hip = pivot(root, 0.5 * side, -0.2, 0, `${p}Hip`);
    part(hip, upper, mats.part('legs'), -0.42, `${p}Hip` as JointId, meshes, `${P}UpperLeg`);
    const knee = pivot(hip, 0, -0.85, 0, `${p}Knee`);
    part(knee, lower, mats.part('legs'), -0.42, `${p}Knee` as JointId, meshes, `${P}LowerLeg`);
    const ankle = pivot(knee, 0, -0.85, 0, `${p}Ankle`);
    part(ankle, end, mats.part('legs'), -0.15, `${p}Ankle` as JointId, meshes, `${P}Foot`);
    return { hip, knee, ankle };
  };
  const ra = arm(-1),
    la = arm(1),
    rl = leg(-1),
    ll = leg(1);
  return {
    type: 'R15',
    figure,
    joints: {
      root,
      waist,
      neck,
      rightShoulder: ra.shoulder,
      rightElbow: ra.elbow,
      rightWrist: ra.wrist,
      leftShoulder: la.shoulder,
      leftElbow: la.elbow,
      leftWrist: la.wrist,
      rightHip: rl.hip,
      rightKnee: rl.knee,
      rightAnkle: rl.ankle,
      leftHip: ll.hip,
      leftKnee: ll.knee,
      leftAnkle: ll.ankle,
    },
    attach: {
      head: headAttach,
      torso: pivot(waist, 0, 0.8, 0, 'torsoAttach'),
      rightHand: pivot(ra.wrist, 0, -0.16, 0, 'rightHand'),
      leftHand: pivot(la.wrist, 0, -0.16, 0, 'leftHand'),
      leftForearm: pivot(la.elbow, 0.52, -0.45, 0, 'leftForearm'),
    },
    head,
    meshes,
  };
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

export function jointQuaternion(v: [number, number, number], out = new THREE.Quaternion()): THREE.Quaternion {
  _e.set(v[0] * DEG, v[1] * DEG, v[2] * DEG, 'YXZ');
  return out.setFromEuler(_e);
}

/** Blend: a · slerp(identity, b, t). */
function blendInto(out: THREE.Quaternion, a: [number, number, number], b: [number, number, number], t: number) {
  jointQuaternion(a, out);
  jointQuaternion(b, _q2);
  _q.identity().slerp(_q2, t);
  out.multiply(_q);
  return out;
}

/** Apply a pose (joints + root offset + body rotation) to a built rig. */
export function applyPose(rig: RigBuild, pose: StudioPose) {
  const j: Joints = pose.joints;
  const set = (id: JointId, q: THREE.Quaternion) => rig.joints[id]?.quaternion.copy(q);
  rig.figure.position.set(pose.rootOffset[0], pose.rootOffset[1], pose.rootOffset[2]);
  rig.figure.quaternion.copy(jointQuaternion(pose.bodyRotation));
  if (rig.type === 'R15') {
    for (const id of Object.keys(rig.joints) as JointId[]) set(id, jointQuaternion(j[id]));
    return;
  }
  // R6: single-piece limbs — fold the R15-only joints into the nearest R6 joint.
  const qRoot = jointQuaternion(j.root);
  const qWaist = jointQuaternion(j.waist, new THREE.Quaternion());
  set('root', qRoot.multiply(qWaist));
  set('neck', jointQuaternion(j.neck));
  set('rightShoulder', blendInto(new THREE.Quaternion(), j.rightShoulder, j.rightElbow, 0.5));
  set('leftShoulder', blendInto(new THREE.Quaternion(), j.leftShoulder, j.leftElbow, 0.5));
  // Rigid R6 arms: the wrist turns only what the hand holds (e.g. the sword grip).
  rig.attach.rightHand.quaternion.copy(jointQuaternion(j.rightWrist));
  rig.attach.leftHand.quaternion.copy(jointQuaternion(j.leftWrist));
  const qWaistInv = _qi.copy(qWaist).invert();
  const rh = blendInto(new THREE.Quaternion(), j.rightHip, j.rightKnee, 0.5);
  set('rightHip', rh.premultiply(qWaistInv));
  const lh = blendInto(new THREE.Quaternion(), j.leftHip, j.leftKnee, 0.5);
  set('leftHip', lh.premultiply(qWaistInv));
}
