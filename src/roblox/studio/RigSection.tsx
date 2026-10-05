/** Properties panel section for Pose Studio renders (raster layers with generator.kind === 'rig'). */
import { PersonStanding } from 'lucide-react';
import { Button } from '../../ui/controls';
import { useEditor } from '../../state/editor';
import type { ID } from '../../core/types';
import '../roblox.css';
import { CAMERA_PRESETS, LIGHTING_PRESETS, normalizeStudioState, posePreset } from './presets';
import { readPlacement } from './placement';
import { openModelImport, openPoseStudio } from './lazy';
import { cachedModelFiles } from './modelCache';

function useLayer(layerId: ID) {
  return useEditor((st) => {
    const s = st.activeDocId ? st.sessions[st.activeDocId] : null;
    return s?.doc.layers[layerId] ?? null;
  });
}

export function isRigLayer(layer: unknown): boolean {
  const l = layer as { type?: string; generator?: { kind?: string } | null } | null;
  return !!l && l.type === 'raster' && l.generator?.kind === 'rig';
}

const SHADING_NAMES: Record<string, string> = { toon: 'Toon', smooth: 'Smooth', flat: 'Silhouette' };

export function RigSection({ layerId }: { layerId: ID }) {
  const layer = useLayer(layerId);
  if (!layer || layer.type !== 'raster' || layer.generator?.kind !== 'rig') return null;
  const s = normalizeStudioState(layer.generator.params);
  const placement = readPlacement((layer.generator.params as Record<string, unknown>).placement);
  const rows: [string, string][] = [
    ['Rig', s.rig === 'R6' ? 'R6 (classic)' : 'R15'],
    ['Pose', posePreset(s.pose.preset)?.name ?? 'Custom'],
    ['Camera', CAMERA_PRESETS.find((c) => c.id === s.camera.preset)?.name ?? 'Custom'],
    ['Lighting', LIGHTING_PRESETS.find((l) => l.id === s.lighting.preset)?.name ?? 'Custom'],
    ['Shading', `${SHADING_NAMES[s.shading.mode] ?? s.shading.mode}${s.shading.outline ? ' + outline' : ''}`],
  ];
  if (placement) rows.push(['Rendered', `${placement.frameW}×${placement.frameH}`]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', rowGap: 3, fontSize: 'var(--fs-sm)' }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--text-muted)' }}>{k}</span>
            <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
          </div>
        ))}
      </div>
      <Button variant="primary" icon={PersonStanding} onClick={() => void openPoseStudio({ layerId })}>
        Edit in Pose Studio
      </Button>
      <div className="roblox-hint">Re-rendering keeps the layer's position, scale, filters and effects. Painted pixels on this layer are replaced.</div>
    </div>
  );
}

export function isModelLayer(layer: unknown): boolean {
  const l = layer as { type?: string; generator?: { kind?: string } | null } | null;
  return !!l && l.type === 'raster' && l.generator?.kind === 'model';
}

/** Properties section for imported-model renders (generator.kind === 'model'). */
export function ModelSection({ layerId }: { layerId: ID }) {
  const layer = useLayer(layerId);
  if (!layer || layer.type !== 'raster' || layer.generator?.kind !== 'model') return null;
  const p = layer.generator.params as Record<string, unknown>;
  const s = normalizeStudioState(p);
  const files = Array.isArray(p.files) ? (p.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
  const available = !!cachedModelFiles(p.modelKey);
  const rows: [string, string][] = [
    ['Model', typeof p.modelName === 'string' ? p.modelName : (files[0] ?? 'Model')],
    ['Camera', CAMERA_PRESETS.find((c) => c.id === s.camera.preset)?.name ?? 'Custom'],
    ['Lighting', LIGHTING_PRESETS.find((l) => l.id === s.lighting.preset)?.name ?? 'Custom'],
    ['Shading', `${SHADING_NAMES[s.shading.mode] ?? s.shading.mode}${s.shading.outline ? ' + outline' : ''}`],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', rowGap: 3, fontSize: 'var(--fs-sm)' }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ color: 'var(--text-muted)' }}>{k}</span>
            <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
          </div>
        ))}
      </div>
      <Button variant="primary" icon={PersonStanding} onClick={() => void openModelImport({ layerId })}>
        Edit Model Render
      </Button>
      {!available && <div className="roblox-hint">The model files are not loaded in this session — you will be asked to choose them again ({files.join(', ') || 'original files'}).</div>}
    </div>
  );
}
