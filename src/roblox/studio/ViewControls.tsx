/**
 * Camera / lighting / shading / output controls shared by Pose Studio and the model importer.
 * Each control edits one sub-object of the studio state through an `onChange(next)` callback.
 */
import { RotateCcw } from 'lucide-react';
import { Button, Checkbox, ColorField, Field, IconButton, Select } from '../../ui/controls';
import { CAMERA_PRESETS, LIGHTING_PRESETS, cameraFromPreset, lightingFromPreset } from './presets';
import type { Framing, LightSpec, ShadingMode, StudioCamera, StudioLighting, StudioOutput, StudioShading } from './types';
import { Chip, ChipGrid, ColorRow, Group, Hint, Seg, SliderRow, SwatchRow } from './ui';
import { MAX_RENDER } from './placement';

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export const FRAMING_OPTIONS: { value: Framing; label: string; title: string }[] = [
  { value: 'head', label: 'Head', title: 'Close-up on the head (icons)' },
  { value: 'waist', label: 'Waist-up', title: 'Waist-up portrait' },
  { value: 'full', label: 'Full body', title: 'Whole character' },
];

export function CameraControls({
  camera,
  onChange,
  onReframe,
}: {
  camera: StudioCamera;
  onChange: (c: StudioCamera) => void;
  /** Recompute auto framing (and clear the pan). */
  onReframe: () => void;
}) {
  const set = (patch: Partial<StudioCamera>) => onChange({ ...camera, ...patch, preset: 'custom' });
  return (
    <>
      <Group title="Angle">
        <ChipGrid cols={2}>
          {CAMERA_PRESETS.map((p) => (
            <Chip key={p.id} active={camera.preset === p.id} onClick={() => onChange(cameraFromPreset(p.id, camera))}>
              {p.name}
            </Chip>
          ))}
        </ChipGrid>
      </Group>
      <Group
        title="Framing"
        actions={<IconButton size="sm" icon={RotateCcw} title="Re-frame the character (clears panning)" onClick={onReframe} />}
      >
        <Seg value={camera.framing} options={FRAMING_OPTIONS} onChange={(framing) => onChange({ ...camera, framing, pan: [0, 0, 0], distance: 1 })} />
        <SliderRow label="Orbit" value={camera.yaw} min={-180} max={180} unit="°" onChange={(yaw) => set({ yaw })} />
        <SliderRow label="Height" value={camera.pitch} min={-80} max={80} unit="°" onChange={(pitch) => set({ pitch })} hint="Negative = low angle looking up" />
        <SliderRow label="Distance" value={camera.distance} min={0.35} max={3} step={0.01} displayScale={100} unit="%" onChange={(distance) => set({ distance })} />
        <SliderRow label="Field of view" value={camera.fov} min={10} max={90} unit="°" onChange={(fov) => onChange({ ...camera, fov })} hint="Low = flat telephoto look, high = dramatic perspective" />
        <Hint>Drag the preview to orbit · right-drag to pan · scroll to zoom.</Hint>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Lighting                                                            */
/* ------------------------------------------------------------------ */

const LIGHT_SWATCHES = ['#ffffff', '#fff2e0', '#ffb35c', '#ff1a1a', '#8b7cf6', '#3cf2ff', '#ff2bd6', '#4fc98a'];

function LightEditor({ title, light, onChange }: { title: string; light: LightSpec; onChange: (l: LightSpec) => void }) {
  return (
    <Group
      title={title}
      actions={<ColorField value={light.color} onChange={(color) => onChange({ ...light, color })} size={16} title={`${title} color`} />}
    >
      <SwatchRow colors={LIGHT_SWATCHES} value={light.color} onPick={(color) => onChange({ ...light, color })} size={14} />
      <SliderRow label="Intensity" value={light.intensity} min={0} max={8} step={0.05} onChange={(intensity) => onChange({ ...light, intensity })} />
      <SliderRow label="Direction" value={light.azimuth} min={-180} max={180} unit="°" onChange={(azimuth) => onChange({ ...light, azimuth })} hint="0° = from the front, 90° = from the character's left, 180° = from behind" />
      <SliderRow label="Elevation" value={light.elevation} min={-30} max={90} unit="°" onChange={(elevation) => onChange({ ...light, elevation })} />
    </Group>
  );
}

export function LightingControls({ lighting, onChange }: { lighting: StudioLighting; onChange: (l: StudioLighting) => void }) {
  const set = (patch: Partial<StudioLighting>) => onChange({ ...lighting, ...patch, preset: 'custom' });
  return (
    <>
      <Group title="Lighting preset">
        <ChipGrid cols={2}>
          {LIGHTING_PRESETS.map((p) => (
            <Chip key={p.id} active={lighting.preset === p.id} swatch={p.swatch} onClick={() => onChange(lightingFromPreset(p.id))}>
              {p.name}
            </Chip>
          ))}
        </ChipGrid>
      </Group>
      <LightEditor title="Key light" light={lighting.key} onChange={(key) => set({ key })} />
      <LightEditor title="Rim light" light={lighting.rim} onChange={(rim) => set({ rim })} />
      <LightEditor title="Fill light" light={lighting.fill} onChange={(fill) => set({ fill })} />
      <Group title="Ambient">
        <SliderRow label="Intensity" value={lighting.ambient} min={0} max={3} step={0.01} onChange={(ambient) => set({ ambient })} />
        <ColorRow label="Color" value={lighting.ambientColor} onChange={(ambientColor) => set({ ambientColor })} />
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Shading                                                             */
/* ------------------------------------------------------------------ */

const SHADING_OPTIONS: { value: ShadingMode; label: string; title: string }[] = [
  { value: 'toon', label: 'Toon', title: 'Flat posterized cel shading (gothic poster look)' },
  { value: 'smooth', label: 'Smooth', title: 'Soft realistic shading' },
  { value: 'flat', label: 'Silhouette', title: 'Single flat color (noir silhouettes)' },
];

export function ShadingControls({ shading, onChange }: { shading: StudioShading; onChange: (s: StudioShading) => void }) {
  const set = (patch: Partial<StudioShading>) => onChange({ ...shading, ...patch });
  return (
    <Group title="Shading">
      <Seg value={shading.mode} options={SHADING_OPTIONS} onChange={(mode) => set({ mode })} />
      {shading.mode === 'toon' && (
        <SliderRow label="Tone steps" value={shading.toonSteps} min={2} max={6} step={1} onChange={(toonSteps) => set({ toonSteps })} hint="Number of flat light bands" />
      )}
      {shading.mode === 'flat' && <ColorRow label="Color" value={shading.flatColor} onChange={(flatColor) => set({ flatColor })} />}
      <Field label="">
        <Checkbox checked={shading.outline} onChange={(outline) => set({ outline })} label="Ink outline" />
      </Field>
      {shading.outline && (
        <>
          <SliderRow label="Thickness" value={shading.outlineThickness} min={0.5} max={14} step={0.5} onChange={(outlineThickness) => set({ outlineThickness })} />
          <ColorRow label="Color" value={shading.outlineColor} onChange={(outlineColor) => set({ outlineColor })} />
        </>
      )}
    </Group>
  );
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const SIZES = [512, 768, 1024, 1536, 2048, 3072, MAX_RENDER];

export function OutputControls({
  output,
  onChange,
  frame,
  docSize,
  background,
  onBackground,
}: {
  output: StudioOutput;
  onChange: (o: StudioOutput) => void;
  frame: { width: number; height: number };
  docSize: { width: number; height: number } | null;
  background: PreviewBackground;
  onBackground: (b: PreviewBackground) => void;
}) {
  const options = [
    { value: 'document', label: docSize ? `Document (${docSize.width}×${docSize.height})` : 'Default (1024×1024)' },
    ...SIZES.map((s) => ({ value: String(s), label: `${s} px (long side)` })),
  ];
  return (
    <Group title="Output">
      <Field label="Render size">
        <Select
          value={output.size === 'document' ? 'document' : String(output.size)}
          options={options}
          width="100%"
          onChange={(v) => onChange({ ...output, size: v === 'document' ? 'document' : Number(v) })}
        />
      </Field>
      <Hint>
        Renders <b>{frame.width}×{frame.height}</b> with a transparent background, cropped to the character and placed centered (re-edits keep the layer's position).
      </Hint>
      <Field label="Preview bg">
        <Seg value={background} options={BACKGROUND_OPTIONS} onChange={onBackground} />
      </Field>
    </Group>
  );
}

export type PreviewBackground = 'doc' | 'dark' | 'light' | 'checker';

export const BACKGROUND_OPTIONS: { value: PreviewBackground; label: string; title: string }[] = [
  { value: 'doc', label: 'Doc', title: 'Preview over the current document' },
  { value: 'dark', label: 'Dark', title: 'Dark backdrop' },
  { value: 'light', label: 'Light', title: 'Light backdrop' },
  { value: 'checker', label: 'Alpha', title: 'Transparency checkerboard' },
];

export function ResetButton({ onClick, label = 'Reset' }: { onClick: () => void; label?: string }) {
  return (
    <Button size="small" variant="ghost" icon={RotateCcw} onClick={onClick}>
      {label}
    </Button>
  );
}
