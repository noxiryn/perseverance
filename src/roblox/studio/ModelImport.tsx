/**
 * Model Import — load an avatar/model exported from Roblox Studio (.obj + .mtl + textures) or any
 * .glb/.gltf/.fbx, then frame, light and shade it with the Pose Studio controls (no posing) and
 * render it into the document as a raster layer (generator kind 'model').
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Grid3x3, RotateCcw, Sparkles } from 'lucide-react';
import { Button, Dialog, Tabs } from '../../ui/controls';
import { activeDoc } from '../../state/editor';
import { openDialog, toast } from '../../state/ui';
import { openFiles, type OpenedFile } from '../../platform';
import type { RasterLayer } from '../../core/types';
import '../roblox.css';
import { StudioStage } from './StudioStage';
import type { StudioScene } from './scene';
import { commitRender, frameSizeFor } from './output';
import { documentBackdrop } from './backdrop';
import { CAMERA_PRESETS, cameraFromPreset, defaultStudioState, normalizeStudioState } from './presets';
import type { Vec3, ViewSettings } from './types';
import { CameraControls, FRAMING_OPTIONS, LightingControls, OutputControls, ShadingControls, type PreviewBackground } from './ViewControls';
import { Group, Hint, SliderRow } from './ui';
import { MODEL_EXTENSIONS, cacheModelFiles, cachedModelFiles, filesFromDom, loadModel, pickMainFile, type LoadedModel, type ModelFile } from './loaders';

type Tab = 'model' | 'camera' | 'light' | 'style';
const TABS: { value: Tab; label: string }[] = [
  { value: 'model', label: 'Model' },
  { value: 'camera', label: 'Camera' },
  { value: 'light', label: 'Light' },
  { value: 'style', label: 'Render' },
];

export const STUDIO_EXPORT_HINT = 'Roblox Studio: select your avatar → right-click → Export Selection… (.obj)';

interface ImportState {
  view: ViewSettings;
  rotationY: number;
}

function defaultImportState(): ImportState {
  const d = defaultStudioState();
  return { view: { camera: { ...d.camera }, lighting: d.lighting, shading: d.shading, output: d.output }, rotationY: 0 };
}

function stateFromParams(params: unknown): ImportState {
  const s = normalizeStudioState(params);
  const p = (params ?? {}) as { rotationY?: unknown };
  return {
    view: { camera: s.camera, lighting: s.lighting, shading: s.shading, output: s.output },
    rotationY: typeof p.rotationY === 'number' ? p.rotationY : 0,
  };
}

let lastImportState: ImportState | null = null;

export interface ModelImportProps extends Record<string, unknown> {
  files?: ModelFile[] | null;
  layerId?: string | null;
}

export function ModelImportDialog({ close, files: initialFiles, layerId }: ModelImportProps & { close: (r?: unknown) => void }) {
  const [editing] = useState<RasterLayer | null>(() => {
    const l = layerId ? activeDoc()?.layers[layerId] : null;
    return l && l.type === 'raster' && l.generator?.kind === 'model' ? l : null;
  });
  const [state, setState] = useState<ImportState>(() =>
    editing ? stateFromParams(editing.generator!.params) : (lastImportState ?? defaultImportState()),
  );
  const [files, setFiles] = useState<ModelFile[]>(() => initialFiles ?? []);
  const [model, setModel] = useState<LoadedModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scene, setScene] = useState<StudioScene | null>(null);
  const [tab, setTab] = useState<Tab>('model');
  const [background, setBackground] = useState<PreviewBackground>(() => (activeDoc() ? 'doc' : 'dark'));
  const [thirds, setThirds] = useState(false);
  const [docImage] = useState(() => documentBackdrop(editing?.id));
  const [busy, setBusy] = useState(false);
  const docSize = useMemo(() => {
    const d = activeDoc();
    return d ? { width: d.width, height: d.height } : null;
  }, []);
  const frame = frameSizeFor(state.view.output);
  const aspect = frame.width / frame.height;
  const loadSeq = useRef(0);

  /* ---------------- loading ---------------- */

  useEffect(() => {
    if (!scene || !files.length) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    loadModel(files)
      .then((m) => {
        if (seq !== loadSeq.current) return;
        scene.setModel(m.root);
        setModel(m);
        if (m.missing.length) toast(`Missing ${m.missing.length} referenced file(s): ${m.missing.slice(0, 3).join(', ')}${m.missing.length > 3 ? '…' : ''}`, 'warning', 5000);
      })
      .catch((err: unknown) => {
        if (seq !== loadSeq.current) return;
        console.error('Model import failed', err);
        setModel(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq === loadSeq.current) setLoading(false);
      });
  }, [scene, files]);

  const chooseFiles = async () => {
    const picked = await openFiles({
      title: 'Import 3D model',
      multiple: true,
      filters: [
        { name: '3D models + materials + textures', extensions: MODEL_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.length) acceptFiles(picked.map((f) => ({ name: f.name, data: f.data })));
  };

  const acceptFiles = (list: ModelFile[]) => {
    if (!pickMainFile(list)) {
      setError('No 3D model in the selection. Pick the .obj (with its .mtl and textures), .glb, .gltf or .fbx file.');
      return;
    }
    setFiles(list);
  };

  const onDropFiles = useCallback(async (list: File[]) => {
    acceptFiles(await filesFromDom(list));
  }, []);

  /* ---------------- scene sync ---------------- */

  useEffect(() => {
    if (!scene || !model) return;
    scene.setModelView(state.view, state.rotationY);
  }, [scene, model, state]);

  useEffect(() => {
    if (!scene) return;
    scene.onCameraEdit = (cam) => setState((s) => ({ ...s, view: { ...s.view, camera: { ...s.view.camera, ...cam, preset: 'custom' } } }));
    return () => {
      scene.onCameraEdit = null;
    };
  }, [scene]);

  const reframe = useCallback(
    (force = false) => {
      if (!scene || !model) return;
      setState((s) => {
        scene.setModelView(s.view, s.rotationY);
        const f = scene.computeFraming(s.view.camera.framing, s.view.camera.fov, aspect);
        const c = s.view.camera;
        if (!force && Math.abs(f.baseDistance - c.baseDistance) < 1e-4 && f.target.every((v, i) => Math.abs(v - c.target[i]) < 1e-4)) return s;
        return { ...s, view: { ...s.view, camera: { ...c, target: f.target, baseDistance: f.baseDistance, ...(force ? { pan: [0, 0, 0] as Vec3 } : {}) } } };
      });
    },
    [scene, model, aspect],
  );
  const frameKey = model ? `${model.mainFile}|${state.view.camera.framing}|${state.view.camera.fov}|${aspect.toFixed(4)}` : '';
  const lastFrameKey = useRef<string>('');
  const keepStoredCamera = useRef(!!editing);
  useEffect(() => {
    if (!frameKey || lastFrameKey.current === frameKey) return;
    const first = !lastFrameKey.current;
    lastFrameKey.current = frameKey;
    if (first && keepStoredCamera.current) {
      keepStoredCamera.current = false;
      return;
    }
    reframe();
  }, [frameKey, reframe]);

  /* ---------------- commit ---------------- */

  const setView = (patch: Partial<ViewSettings>) => setState((s) => ({ ...s, view: { ...s.view, ...patch } }));

  const addToDocument = () => {
    if (!scene || !model || busy) return;
    setBusy(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          const modelKey = cacheModelFiles(files);
          const ok = commitRender(scene, {
            output: state.view.output,
            kind: 'model',
            params: { ...state.view, rotationY: state.rotationY, modelKey, modelName: model.name, files: files.map((f) => f.name) },
            name: model.name || 'Model',
            replaceLayerId: editing?.id ?? null,
            newDocName: model.name || 'Imported Model',
          });
          if (ok) {
            lastImportState = state;
            close(true);
            return;
          }
        } catch (err) {
          console.error('Model render failed', err);
          toast(`Render failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 5000);
        }
        setBusy(false);
      }),
    );
  };

  const cancel = () => {
    lastImportState = state;
    close();
  };

  /* ---------------- UI ---------------- */

  const toolbar = model ? (
    <>
      <div className="roblox-studio-pill">
        {['front', 'threeQuarterLeft', 'threeQuarterRight', 'lowHero', 'backShoulder'].map((id) => {
          const p = CAMERA_PRESETS.find((c) => c.id === id)!;
          return (
            <button
              key={id}
              className={state.view.camera.preset === id ? 'active' : undefined}
              onClick={() => setState((s) => ({ ...s, view: { ...s.view, camera: cameraFromPreset(id, s.view.camera) } }))}
            >
              {p.name}
            </button>
          );
        })}
      </div>
      <div className="roblox-studio-pill">
        {FRAMING_OPTIONS.map((f) => (
          <button
            key={f.value}
            title={f.title}
            className={state.view.camera.framing === f.value ? 'active' : undefined}
            onClick={() => setView({ camera: { ...state.view.camera, framing: f.value, pan: [0, 0, 0], distance: 1 } })}
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
        <button title="Re-frame the model" onClick={() => reframe(true)}>
          <RotateCcw size={13} />
        </button>
      </div>
    </>
  ) : null;

  const emptyOverlay =
    !model && !loading ? (
      <div className="roblox-studio-error roblox-studio-empty">
        <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          {error ? <div style={{ color: 'var(--danger)' }}>{error}</div> : <div style={{ color: 'var(--text-strong)', fontSize: 'var(--fs-md)' }}>Drop your model files here</div>}
          <div>.obj + .mtl + textures, .glb, .gltf (+ .bin) or .fbx — select all files together.</div>
          <Button variant="primary" icon={FolderOpen} onClick={chooseFiles}>
            Choose Files…
          </Button>
          <div className="roblox-hint">{STUDIO_EXPORT_HINT}</div>
        </div>
      </div>
    ) : loading ? (
      <div className="roblox-studio-busy">Loading model…</div>
    ) : busy ? (
      <div className="roblox-studio-busy">Rendering {frame.width}×{frame.height}…</div>
    ) : null;

  const mainName = pickMainFile(files)?.name;

  return (
    <Dialog
      title={editing ? `Import Model — editing “${editing.name}”` : 'Import 3D Model'}
      width="92vw"
      onClose={cancel}
      footer={
        <div className="roblox-foot">
          <Button variant="ghost" size="small" icon={FolderOpen} onClick={chooseFiles}>
            Choose Files…
          </Button>
          <span className="info">
            {model
              ? `${model.name} · ${model.meshCount} ${model.meshCount === 1 ? 'mesh' : 'meshes'} · ${model.triangles.toLocaleString()} triangles → ${frame.width}×${frame.height} transparent render`
              : STUDIO_EXPORT_HINT}
          </span>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" icon={Sparkles} onClick={addToDocument} disabled={!model || busy || loading}>
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
          toolbar={toolbar}
          thirds={thirds && !!model}
          overlay={emptyOverlay}
          onDropFiles={onDropFiles}
          status={
            model ? (
              <>
                <span>Drag to orbit · right-drag to pan · scroll to zoom · drop files to replace</span>
                <span>{frame.width}×{frame.height}</span>
              </>
            ) : null
          }
        />
        <div className="roblox-studio-side">
          <Tabs value={tab} tabs={TABS} onChange={setTab} />
          <div className="roblox-studio-scroll">
            {tab === 'model' && (
              <>
                <Group title="Files">
                  {files.length ? (
                    <div className="roblox-file-list">
                      {files.map((f) => (
                        <span key={f.name} className={f.name === mainName ? 'main' : undefined}>
                          {f.name === mainName ? '▸ ' : '  '}
                          {f.name}
                        </span>
                      ))}
                      {model?.missing.map((m) => (
                        <span key={`missing-${m}`} className="missing">
                          ⚠ missing {m}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="roblox-dropzone" onClick={chooseFiles}>
                      Choose or drop .obj/.mtl/.png, .glb, .gltf or .fbx files
                    </div>
                  )}
                  {error && model && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-sm)' }}>{error}</div>}
                  <Hint>
                    <b>{STUDIO_EXPORT_HINT}</b>. Select the .obj together with the .mtl and texture .png files it saved next to it.
                  </Hint>
                </Group>
                <Group title="Orientation">
                  <SliderRow label="Turn" value={state.rotationY} min={-180} max={180} unit="°" onChange={(rotationY) => setState((s) => ({ ...s, rotationY }))} hint="Rotate the model around its vertical axis" />
                  <Hint>The model is centered, scaled to character height and placed standing on the ground.</Hint>
                </Group>
              </>
            )}
            {tab === 'camera' && <CameraControls camera={state.view.camera} onChange={(camera) => setView({ camera })} onReframe={() => reframe(true)} />}
            {tab === 'light' && <LightingControls lighting={state.view.lighting} onChange={(lighting) => setView({ lighting })} />}
            {tab === 'style' && (
              <>
                <ShadingControls shading={state.view.shading} onChange={(shading) => setView({ shading })} />
                <OutputControls output={state.view.output} onChange={(output) => setView({ output })} frame={frame} docSize={docSize} background={background} onBackground={setBackground} />
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Open the importer; with no files it starts with a file picker / drop zone. */
export async function openModelImport(opts: { files?: OpenedFile[] | ModelFile[]; layerId?: string | null; pick?: boolean } = {}) {
  let files: ModelFile[] | null = opts.files ? opts.files.map((f) => ({ name: f.name, data: f.data })) : null;
  if (!files && opts.layerId) {
    const l = activeDoc()?.layers[opts.layerId];
    const key = l && l.type === 'raster' ? (l.generator?.params as Record<string, unknown> | undefined)?.modelKey : null;
    files = cachedModelFiles(key);
    if (!files) toast('The original model files are not loaded in this session — choose them again to re-render.', 'info', 4500);
  }
  if (!files && opts.pick) {
    const picked = await openFiles({
      title: 'Import 3D model',
      multiple: true,
      filters: [
        { name: '3D models + materials + textures', extensions: MODEL_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!picked.length) return undefined;
    files = picked.map((f) => ({ name: f.name, data: f.data }));
  }
  return openDialog<unknown, ModelImportProps>(ModelImportDialog, { files, layerId: opts.layerId ?? null });
}
