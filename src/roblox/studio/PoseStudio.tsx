/**
 * Pose Studio — a three.js character poser (R6 / R15-lite blocky rigs) with pose presets, joint
 * sliders, appearance, camera, lighting and toon/smooth/silhouette shading. "Add to Document"
 * renders at document resolution with a transparent background into a raster layer whose
 * `generator: { kind: 'rig', params }` stores the full studio state for re-editing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlipHorizontal2, Grid3x3, RotateCcw, Sparkles } from 'lucide-react';
import { Button, Checkbox, ColorField, Dialog, Field, IconButton, Tabs } from '../../ui/controls';
import { activeDoc } from '../../state/editor';
import { openDialog, toast } from '../../state/ui';
import type { RasterLayer } from '../../core/types';
import '../roblox.css';
import { StudioStage } from './StudioStage';
import type { StudioScene } from './scene';
import { commitRender, frameSizeFor } from './output';
import { documentBackdrop } from './backdrop';
import {
  BODY_COLOR_PRESETS,
  CAMERA_PRESETS,
  FACE_STYLES,
  HAIR_COLORS,
  HAIR_STYLES,
  POSE_PRESETS,
  SKIN_TONES,
  cameraFromPreset,
  defaultStudioState,
  mirrorJoints,
  normalizeStudioState,
  posePreset,
  resolvePose,
} from './presets';
import {
  JOINTS_R15,
  JOINTS_R6,
  JOINT_LABELS,
  MIRROR_JOINT,
  type Accessories,
  type BodyColors,
  type JointId,
  type RigType,
  type StudioState,
  type Vec3,
} from './types';
import { CameraControls, FRAMING_OPTIONS, LightingControls, OutputControls, ShadingControls, type PreviewBackground } from './ViewControls';
import { Chip, ChipGrid, ColorRow, Group, Hint, Seg, SliderRow, SwatchRow } from './ui';
import { useFrameOverflow, useStickyPreset } from './useFraming';

type Tab = 'pose' | 'look' | 'camera' | 'light' | 'style';

const TABS: { value: Tab; label: string }[] = [
  { value: 'pose', label: 'Pose' },
  { value: 'look', label: 'Look' },
  { value: 'camera', label: 'Camera' },
  { value: 'light', label: 'Light' },
  { value: 'style', label: 'Render' },
];

const STORAGE_KEY = 'perseverance.roblox.poseStudio.v2';

/** Last studio state used in this session (so reopening keeps your character). */
let lastState: StudioState | null = null;

function loadLastState(): StudioState | null {
  if (lastState) return lastState;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return (lastState = normalizeStudioState(JSON.parse(raw)));
  } catch {
    /* storage unavailable or corrupt */
  }
  return null;
}

function rememberState(s: StudioState) {
  lastState = s;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota errors */
  }
}

/** R15-only joints map to the nearest R6 joint (R6 wrists exist: they turn the held sword). */
const R6_EQUIVALENT: Partial<Record<JointId, JointId>> = {
  waist: 'root',
  rightElbow: 'rightShoulder',
  leftElbow: 'leftShoulder',
  rightKnee: 'rightHip',
  rightAnkle: 'rightHip',
  leftKnee: 'leftHip',
  leftAnkle: 'leftHip',
};

const SWORD_POSES = new Set(['swordSlash', 'swordShoulder', 'guard']);

const ACCESSORY_LABELS: { key: keyof Accessories; label: string }[] = [
  { key: 'sword', label: 'Sword in hand' },
  { key: 'katana', label: 'Katana on back' },
  { key: 'shield', label: 'Shield' },
  { key: 'cape', label: 'Cape' },
  { key: 'crown', label: 'Crown' },
  { key: 'headphones', label: 'Headphones' },
];

const PART_LABELS: { key: keyof BodyColors; label: string }[] = [
  { key: 'head', label: 'Head' },
  { key: 'torso', label: 'Torso' },
  { key: 'arms', label: 'Arms' },
  { key: 'legs', label: 'Legs' },
];

const QUICK_CAMERAS = ['front', 'threeQuarterLeft', 'threeQuarterRight', 'lowHero', 'backShoulder'];

/** Everything that changes the framed silhouette enough to re-frame automatically. */
function frameKeyOf(s: StudioState, cameraPreset: string) {
  const a = s.appearance;
  const acc = (Object.keys(a.accessories) as (keyof Accessories)[]).filter((k) => a.accessories[k]).join(',');
  return `${s.rig}|${s.pose.preset}|${a.hair}|${acc}|${cameraPreset}|${s.camera.framing}|${s.camera.fov}`;
}

function vecEq(a: Vec3, b: Vec3) {
  return Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4;
}

export interface PoseStudioProps extends Record<string, unknown> {
  /** Re-edit this raster layer (generator.kind === 'rig'). */
  layerId?: string | null;
}

export function PoseStudioDialog({ close, layerId }: PoseStudioProps & { close: (r?: unknown) => void }) {
  const [editing] = useState<RasterLayer | null>(() => {
    const l = layerId ? activeDoc()?.layers[layerId] : null;
    return l && l.type === 'raster' && l.generator?.kind === 'rig' ? l : null;
  });
  const [state, setState] = useState<StudioState>(() =>
    editing ? normalizeStudioState(editing.generator!.params) : (loadLastState() ?? defaultStudioState()),
  );
  const [scene, setScene] = useState<StudioScene | null>(null);
  const [tab, setTab] = useState<Tab>('pose');
  const [joint, setJoint] = useState<JointId>('rightShoulder');
  const [background, setBackground] = useState<PreviewBackground>(() => (activeDoc() ? 'doc' : 'dark'));
  const [thirds, setThirds] = useState(false);
  const [docImage] = useState(() => documentBackdrop(editing?.id));
  const [busy, setBusy] = useState(false);
  const docSize = useMemo(() => {
    const d = activeDoc();
    return d ? { width: d.width, height: d.height } : null;
  }, []);

  const frame = frameSizeFor(state.output);
  const aspect = frame.width / frame.height;

  const update = useCallback((fn: (s: StudioState) => StudioState) => setState(fn), []);

  // Remember the character however the dialog closes (Cancel, Esc, backdrop click or Add).
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => () => rememberState(stateRef.current), []);

  /* ---------------- scene sync ---------------- */

  useEffect(() => {
    if (!scene) return;
    scene.setCharacter(state);
  }, [scene, state]);

  useEffect(() => {
    if (!scene) return;
    scene.onCameraEdit = (cam) =>
      setState((s) => ({ ...s, camera: { ...s.camera, ...cam, preset: 'custom' } }));
    return () => {
      scene.onCameraEdit = null;
    };
  }, [scene]);

  // Auto framing: recompute target/distance when the rig, preset pose, hair, accessories, camera
  // preset, framing or FOV change. When re-editing, keep the stored camera until something
  // framing-related changes.
  const cameraPreset = useStickyPreset(state.camera.preset);
  const frameKey = `${frameKeyOf(state, cameraPreset)}|${aspect.toFixed(4)}`;
  const lastFrameKey = useRef<string | null>(editing ? frameKey : null);
  const reframe = useCallback(
    (force = false) => {
      if (!scene) return;
      setState((s) => {
        scene.setCharacter(s);
        const f = scene.computeFraming(s.camera.framing, s.camera.fov, aspect, s.camera.yaw, s.camera.pitch);
        if (!force && vecEq(f.target, s.camera.target) && Math.abs(f.baseDistance - s.camera.baseDistance) < 1e-4) return s;
        return { ...s, camera: { ...s.camera, target: f.target, baseDistance: f.baseDistance, ...(force ? { pan: [0, 0, 0] as Vec3 } : {}) } };
      });
    },
    [scene, aspect],
  );
  useEffect(() => {
    if (!scene || lastFrameKey.current === frameKey) return;
    lastFrameKey.current = frameKey;
    reframe();
  }, [scene, frameKey, reframe]);
  // Hand-edited joints, zoom or pan can still push parts out of the frame: warn in the footer.
  const overflow = useFrameOverflow(scene, state.camera.framing, aspect, state);

  /* ---------------- pose editing ---------------- */

  const jointList: readonly JointId[] = state.rig === 'R6' ? JOINTS_R6 : JOINTS_R15;
  const activeJoint: JointId = state.rig === 'R6' ? (R6_EQUIVALENT[joint] ?? joint) : joint;
  const jv = state.pose.joints[activeJoint];

  const applyPreset = (id: string) => {
    const p = posePreset(id);
    if (!p) return;
    update((s) => {
      const r = resolvePose(p, s.rig);
      const acc = s.appearance.accessories;
      const needsSword = SWORD_POSES.has(id) && !acc.sword;
      return {
        ...s,
        pose: { ...s.pose, preset: id, joints: r.joints, rootOffset: r.rootOffset },
        appearance: needsSword ? { ...s.appearance, accessories: { ...acc, sword: true } } : s.appearance,
      };
    });
  };

  const setRig = (rig: RigType) =>
    update((s) => {
      if (s.rig === rig) return s;
      const p = posePreset(s.pose.preset);
      if (!p) return { ...s, rig };
      const r = resolvePose(p, rig);
      return { ...s, rig, pose: { ...s.pose, joints: r.joints, rootOffset: r.rootOffset } };
    });

  const setJointAxis = (axis: 0 | 1 | 2, v: number) =>
    update((s) => {
      const cur = s.pose.joints[activeJoint];
      const next: Vec3 = [cur[0], cur[1], cur[2]];
      next[axis] = v;
      return { ...s, pose: { ...s.pose, preset: 'custom', joints: { ...s.pose.joints, [activeJoint]: next } } };
    });

  const resetJoint = () =>
    update((s) => ({ ...s, pose: { ...s.pose, preset: 'custom', joints: { ...s.pose.joints, [activeJoint]: [0, 0, 0] as Vec3 } } }));

  const copyToOtherSide = () => {
    const other = MIRROR_JOINT[activeJoint];
    if (other === activeJoint) return;
    update((s) => {
      const v = s.pose.joints[activeJoint];
      const joints = { ...s.pose.joints, [other]: [v[0], -v[1] || 0, -v[2] || 0] as Vec3 };
      if (s.rig === 'R6') {
        // R6 limbs include half of the R15 child joint: mirror those too.
        for (const [child, parent] of Object.entries(R6_EQUIVALENT) as [JointId, JointId][]) {
          if (parent === activeJoint) {
            const c = s.pose.joints[child];
            joints[MIRROR_JOINT[child]] = [c[0], -c[1] || 0, -c[2] || 0];
          }
        }
      }
      return { ...s, pose: { ...s.pose, preset: 'custom', joints } };
    });
    toast(`Copied ${JOINT_LABELS[activeJoint]} to ${JOINT_LABELS[other]}`, 'info', 1600);
  };

  const mirrorPose = () =>
    update((s) => ({
      ...s,
      pose: {
        ...s.pose,
        preset: 'custom',
        joints: mirrorJoints(s.pose.joints, MIRROR_JOINT),
        bodyRotation: [s.pose.bodyRotation[0], -s.pose.bodyRotation[1] || 0, -s.pose.bodyRotation[2] || 0],
      },
    }));

  const resetPose = () => {
    const r = resolvePose(POSE_PRESETS[0], state.rig);
    update((s) => ({ ...s, pose: { preset: 'idle', joints: r.joints, rootOffset: r.rootOffset, bodyRotation: [0, 0, 0] } }));
  };

  const setBodyRot = (axis: 0 | 1 | 2, v: number) =>
    update((s) => {
      const b: Vec3 = [...s.pose.bodyRotation];
      b[axis] = v;
      return { ...s, pose: { ...s.pose, bodyRotation: b } };
    });

  const onPick = useCallback((j: JointId | null) => {
    if (!j) return;
    setJoint(j);
    setTab('pose');
  }, []);

  /* ---------------- appearance ---------------- */

  const setAppearance = (patch: Partial<StudioState['appearance']>) => update((s) => ({ ...s, appearance: { ...s.appearance, ...patch } }));
  const setColor = (key: keyof BodyColors, c: string) =>
    update((s) => ({ ...s, appearance: { ...s.appearance, colors: { ...s.appearance.colors, [key]: c } } }));
  const setSkin = (c: string) =>
    update((s) => {
      const col = s.appearance.colors;
      const armsAreSkin = col.arms.toLowerCase() === col.head.toLowerCase();
      return { ...s, appearance: { ...s.appearance, colors: { ...col, head: c, arms: armsAreSkin ? c : col.arms } } };
    });

  /* ---------------- commit ---------------- */

  const addToDocument = () => {
    if (!scene || busy) return;
    setBusy(true);
    // Let the busy overlay paint before the (synchronous) high-res render.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          const ok = commitRender(scene, {
            output: state.output,
            kind: 'rig',
            params: state as unknown as Record<string, unknown>,
            name: 'Roblox Character',
            replaceLayerId: editing?.id ?? null,
            newDocName: 'Roblox Character',
          });
          if (ok) {
            rememberState(state);
            close(true);
            return;
          }
        } catch (err) {
          console.error('Pose Studio render failed', err);
          toast(`Render failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 5000);
        }
        setBusy(false);
      }),
    );
  };

  const cancel = () => {
    rememberState(state);
    close();
  };

  const resetAll = () => {
    const d = defaultStudioState();
    setState({ ...d, output: state.output });
    lastFrameKey.current = null;
  };

  /* ---------------- render ---------------- */

  const presetName = posePreset(state.pose.preset)?.name ?? 'Custom pose';
  const editedJoints = new Set(jointList.filter((j) => state.pose.joints[j].some((v) => Math.abs(v) > 0.01)));

  const toolbar = (
    <>
      <div className="roblox-studio-pill">
        {QUICK_CAMERAS.map((id) => {
          const p = CAMERA_PRESETS.find((c) => c.id === id)!;
          return (
            <button key={id} className={state.camera.preset === id ? 'active' : undefined} onClick={() => update((s) => ({ ...s, camera: cameraFromPreset(id, s.camera) }))} title={`Camera: ${p.name}`}>
              {p.name}
            </button>
          );
        })}
      </div>
      <div className="roblox-studio-pill">
        {FRAMING_OPTIONS.map((f) => (
          <button
            key={f.value}
            className={state.camera.framing === f.value ? 'active' : undefined}
            title={f.title}
            onClick={() => update((s) => ({ ...s, camera: { ...s.camera, framing: f.value, pan: [0, 0, 0], distance: 1 } }))}
          >
            {f.label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <div className="roblox-studio-pill">
        <button className={thirds ? 'active' : undefined} title="Rule-of-thirds guides" onClick={() => setThirds(!thirds)}>
          <Grid3x3 size={13} />
        </button>
        <button title="Re-frame the character" onClick={() => reframe(true)}>
          <RotateCcw size={13} />
        </button>
      </div>
    </>
  );

  const status = (
    <>
      <span>
        Click a body part to select its joint · Selected: <span className="joint">{JOINT_LABELS[activeJoint]}</span>
      </span>
      <span>
        {state.rig} · {presetName} · {frame.width}×{frame.height}
      </span>
    </>
  );

  return (
    <Dialog
      title={editing ? `Pose Studio — editing “${editing.name}”` : 'Pose Studio'}
      width="92vw"
      onClose={cancel}
      footer={
        <div className="roblox-foot">
          <Button variant="ghost" size="small" icon={RotateCcw} onClick={resetAll} title="Reset pose, look, camera and lighting to defaults">
            Reset All
          </Button>
          {overflow ? (
            <span className="info roblox-foot-warn">
              Part of the character is outside the frame —{' '}
              <button type="button" className="roblox-link" onClick={() => reframe(true)}>
                Re-frame
              </button>{' '}
              or zoom out.
            </span>
          ) : (
            <span className="info">
              {!docSize
                ? `No document open — a ${frame.width}×${frame.height} document will be created`
                : editing
                  ? `Transparent render at ${frame.width}×${frame.height} → replaces “${editing.name}” (keeps its position, filters and effects)`
                  : `Transparent render at ${frame.width}×${frame.height} → new layer`}
            </span>
          )}
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" icon={Sparkles} onClick={addToDocument} disabled={!scene || busy}>
            {editing ? 'Update Layer' : 'Add to Document'}
          </Button>
        </div>
      }
    >
      <div className="roblox-studio">
        <StudioStage
          aspect={aspect}
          background={background}
          docImage={docImage}
          onScene={setScene}
          onPick={onPick}
          toolbar={toolbar}
          status={status}
          thirds={thirds}
          overlay={busy ? <div className="roblox-studio-busy">Rendering {frame.width}×{frame.height}…</div> : null}
        />
        <div className="roblox-studio-side">
          <Tabs value={tab} tabs={TABS} onChange={setTab} />
          <div className="roblox-studio-scroll">
            {tab === 'pose' && (
              <>
                <Group title="Rig">
                  <Seg
                    value={state.rig}
                    options={[
                      { value: 'R6', label: 'R6 (classic)', title: '6 blocky parts' },
                      { value: 'R15', label: 'R15', title: 'Upper/lower limbs, hands and feet' },
                    ]}
                    onChange={setRig}
                  />
                </Group>
                <Group title="Pose presets" actions={<IconButton size="sm" icon={RotateCcw} title="Reset pose" onClick={resetPose} />}>
                  <ChipGrid cols={2}>
                    {POSE_PRESETS.map((p) => (
                      <Chip key={p.id} active={state.pose.preset === p.id} onClick={() => applyPreset(p.id)}>
                        {p.name}
                      </Chip>
                    ))}
                  </ChipGrid>
                </Group>
                <Group
                  title="Joints"
                  actions={
                    <>
                      <IconButton size="sm" icon={FlipHorizontal2} title="Mirror the whole pose left ↔ right" onClick={mirrorPose} />
                    </>
                  }
                >
                  <div className="roblox-joint-grid">
                    {jointList.map((j) => (
                      <button
                        key={j}
                        type="button"
                        className={`roblox-chip${activeJoint === j ? ' active' : ''}${editedJoints.has(j) ? ' edited' : ''}`}
                        onClick={() => setJoint(j)}
                        title={JOINT_LABELS[j]}
                      >
                        <span className="roblox-chip-label">{JOINT_LABELS[j]}</span>
                      </button>
                    ))}
                  </div>
                  <SliderRow label="Bend (X)" value={jv[0]} min={-180} max={180} unit="°" onChange={(v) => setJointAxis(0, v)} hint="Forward / back swing" />
                  <SliderRow label="Twist (Y)" value={jv[1]} min={-180} max={180} unit="°" onChange={(v) => setJointAxis(1, v)} hint="Rotation around the limb / turn" />
                  <SliderRow label="Spread (Z)" value={jv[2]} min={-180} max={180} unit="°" onChange={(v) => setJointAxis(2, v)} hint="Sideways raise / tilt" />
                  <div className="ui-row" style={{ justifyContent: 'flex-end' }}>
                    {MIRROR_JOINT[activeJoint] !== activeJoint && (
                      <Button size="small" variant="ghost" onClick={copyToOtherSide} title="Copy this joint to the opposite side (mirrored)">
                        Copy to {JOINT_LABELS[MIRROR_JOINT[activeJoint]]}
                      </Button>
                    )}
                    <Button size="small" variant="ghost" onClick={resetJoint}>
                      Reset joint
                    </Button>
                  </div>
                </Group>
                <Group title="Whole body">
                  <SliderRow label="Turn" value={state.pose.bodyRotation[1]} min={-180} max={180} unit="°" onChange={(v) => setBodyRot(1, v)} />
                  <SliderRow label="Lean" value={state.pose.bodyRotation[0]} min={-90} max={90} unit="°" onChange={(v) => setBodyRot(0, v)} />
                  <SliderRow label="Tilt" value={state.pose.bodyRotation[2]} min={-90} max={90} unit="°" onChange={(v) => setBodyRot(2, v)} />
                  <SliderRow
                    label="Height"
                    value={state.pose.rootOffset[1]}
                    min={-3}
                    max={3}
                    step={0.05}
                    onChange={(v) => update((s) => ({ ...s, pose: { ...s.pose, rootOffset: [s.pose.rootOffset[0], v, s.pose.rootOffset[2]] } }))}
                    hint="Raise (jump) or lower (sit/kneel) the whole character"
                  />
                </Group>
              </>
            )}

            {tab === 'look' && (
              <>
                <Group title="Body colors">
                  <ChipGrid cols={2}>
                    {BODY_COLOR_PRESETS.map((p) => {
                      const c = state.appearance.colors;
                      const active = (Object.keys(p.colors) as (keyof BodyColors)[]).every((k) => p.colors[k].toLowerCase() === c[k].toLowerCase());
                      return (
                        <button key={p.id} type="button" className={`roblox-chip${active ? ' active' : ''}`} onClick={() => setAppearance({ colors: { ...p.colors } })}>
                          <span className="roblox-preset-colors">
                            <span style={{ background: p.colors.head }} />
                            <span style={{ background: p.colors.torso }} />
                            <span style={{ background: p.colors.arms }} />
                            <span style={{ background: p.colors.legs }} />
                          </span>
                          <span className="roblox-chip-label">{p.name}</span>
                        </button>
                      );
                    })}
                  </ChipGrid>
                  <div className="roblox-colors">
                    {PART_LABELS.map((p) => (
                      <label key={p.key}>
                        <ColorField value={state.appearance.colors[p.key]} onChange={(c) => setColor(p.key, c)} size={26} title={`${p.label} color`} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                  <Field label="Skin tone">
                    <SwatchRow colors={SKIN_TONES} value={state.appearance.colors.head} onPick={setSkin} />
                  </Field>
                </Group>
                <Group title="Hair">
                  <ChipGrid cols={3}>
                    {HAIR_STYLES.map((h) => (
                      <Chip key={h.value} active={state.appearance.hair === h.value} onClick={() => setAppearance({ hair: h.value })}>
                        {h.label}
                      </Chip>
                    ))}
                  </ChipGrid>
                  {state.appearance.hair !== 'none' && (
                    <>
                      <ColorRow label="Hair color" value={state.appearance.hairColor} onChange={(hairColor) => setAppearance({ hairColor })} />
                      <Field label="">
                        <SwatchRow colors={HAIR_COLORS} value={state.appearance.hairColor} onPick={(hairColor) => setAppearance({ hairColor })} />
                      </Field>
                    </>
                  )}
                </Group>
                <Group title="Face">
                  <Seg value={state.appearance.face} options={FACE_STYLES} onChange={(face) => setAppearance({ face })} />
                  <Hint>Blank faces (like most GFX) read best with a hair shadow — try “Eye Shadow”, or add the Top Shade filter later.</Hint>
                </Group>
                <Group title="Accessories">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {ACCESSORY_LABELS.map((a) => (
                      <Checkbox
                        key={a.key}
                        checked={state.appearance.accessories[a.key]}
                        label={a.label}
                        onChange={(v) => setAppearance({ accessories: { ...state.appearance.accessories, [a.key]: v } })}
                      />
                    ))}
                  </div>
                  <ColorRow label="Accent" value={state.appearance.accentColor} onChange={(accentColor) => setAppearance({ accentColor })} hint="Cape, shield, headphone and katana cord color" />
                </Group>
              </>
            )}

            {tab === 'camera' && (
              <CameraControls camera={state.camera} onChange={(camera) => update((s) => ({ ...s, camera }))} onReframe={() => reframe(true)} />
            )}

            {tab === 'light' && <LightingControls lighting={state.lighting} onChange={(lighting) => update((s) => ({ ...s, lighting }))} />}

            {tab === 'style' && (
              <>
                <ShadingControls shading={state.shading} onChange={(shading) => update((s) => ({ ...s, shading }))} />
                <OutputControls
                  output={state.output}
                  onChange={(output) => update((s) => ({ ...s, output }))}
                  frame={frame}
                  docSize={docSize}
                  background={background}
                  onBackground={setBackground}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Open Pose Studio (optionally re-editing a rig render layer). Resolves true when a layer was added/updated. */
export function openPoseStudio(opts: { layerId?: string | null } = {}) {
  // A large editor: a stray click on the backdrop must not close it (Esc / Cancel still do).
  return openDialog<unknown, PoseStudioProps>(PoseStudioDialog, { layerId: opts.layerId ?? null }, { closeOnBackdrop: false });
}
