/**
 * The 3D preview area of Pose Studio / Model Import. Owns the StudioScene lifecycle: creates it on
 * mount (inside the effect, so React StrictMode's double mount never leaks a context), sizes the
 * WebGL canvas to the output aspect ratio (what you see is what gets rendered), forwards clicks on
 * body parts and disposes every GPU resource on unmount.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { StudioScene } from './scene';
import type { JointId } from './types';
import type { PreviewBackground } from './ViewControls';

export function StudioStage({
  aspect,
  background,
  docImage,
  onScene,
  onPick,
  toolbar,
  status,
  overlay,
  thirds,
  onDropFiles,
}: {
  /** Output width / height. */
  aspect: number;
  background: PreviewBackground;
  /** Data URL of the document composite (for the 'doc' backdrop). */
  docImage: string | null;
  /** Receives the scene once created (and null on unmount). Must be stable (e.g. a state setter). */
  onScene: (s: StudioScene | null) => void;
  onPick?: (joint: JointId | null) => void;
  toolbar?: ReactNode;
  status?: ReactNode;
  overlay?: ReactNode;
  thirds?: boolean;
  onDropFiles?: (files: File[]) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<StudioScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    let scene: StudioScene;
    try {
      scene = new StudioScene();
    } catch (err) {
      console.error('Pose Studio: WebGL unavailable', err);
      setError('3D preview unavailable — WebGL could not be initialized on this device. Update your graphics drivers or enable hardware acceleration.');
      return;
    }
    sceneRef.current = scene;
    frameRef.current?.appendChild(scene.canvas);
    scene.canvas.tabIndex = -1;
    scene.attachControls();
    onScene(scene);
    return () => {
      onScene(null);
      sceneRef.current = null;
      scene.dispose();
    };
  }, [onScene]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      let w = r.width;
      let h = w / aspect;
      if (h > r.height) {
        h = r.height;
        w = h * aspect;
      }
      setBox({ w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useEffect(() => {
    if (box.w > 0) sceneRef.current?.setSize(box.w, box.h);
  }, [box]);

  // Click (not drag) on a body part → pick its joint.
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 0) down.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || !onPickRef.current || !sceneRef.current) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || performance.now() - d.t > 500) return;
    onPickRef.current(sceneRef.current.pick(e.clientX, e.clientY));
  };

  const frameBg = background === 'doc' && docImage ? { backgroundImage: `url(${docImage})`, backgroundSize: '100% 100%' } : undefined;
  const bgClass = background === 'doc' ? (docImage ? '' : 'bg-dark') : `bg-${background}`;

  return (
    <div
      className="roblox-studio-view"
      onDragOver={
        onDropFiles
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragging(true);
            }
          : undefined
      }
      onDragLeave={onDropFiles ? () => setDragging(false) : undefined}
      onDrop={
        onDropFiles
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragging(false);
              const files = [...e.dataTransfer.files];
              if (files.length) onDropFiles(files);
            }
          : undefined
      }
    >
      {toolbar && <div className="roblox-studio-toolbar">{toolbar}</div>}
      <div className="roblox-studio-stage" ref={stageRef}>
        <div
          ref={frameRef}
          className={`roblox-studio-frame ${bgClass}`}
          style={{ width: box.w, height: box.h, ...frameBg }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {thirds && <div className="roblox-studio-thirds" />}
        </div>
      </div>
      {overlay}
      {onDropFiles && <div className={`roblox-studio-drop${dragging ? ' dragging' : ''}`} />}
      {status && <div className="roblox-studio-status">{status}</div>}
      {error && <div className="roblox-studio-error">{error}</div>}
    </div>
  );
}
