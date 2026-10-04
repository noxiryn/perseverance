/**
 * StudioScene — owns the three.js renderer/scene/camera/lights for Pose Studio and the model
 * importer. Renders on demand (no animation loop). Call `dispose()` to free every GPU resource.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import { createCanvas, ctx2d } from '../../core/canvas';
import { applyPose, buildRig, type PartRole, type RigBuild } from './rig';
import { buildAccessories, buildFaceTexture, buildHairGeometry, type PartsFactory, type SurfaceKind } from './parts';
import type { Framing, JointId, LightSpec, ShadingMode, StudioCamera, StudioShading, StudioState, Vec3, ViewSettings } from './types';

const DEG = Math.PI / 180;

export interface FramingResult {
  target: Vec3;
  baseDistance: number;
}

type Disposable = { dispose(): void };

/** Height (studs) imported models are normalized to — same as a Roblox character. */
export const MODEL_HEIGHT = 5.4;

export class StudioScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  controls: OrbitControls | null = null;
  /** Called when the user orbits/zooms/pans with the mouse (values to merge into the camera state). */
  onCameraEdit: ((cam: Pick<StudioCamera, 'yaw' | 'pitch' | 'distance' | 'pan'>) => void) | null = null;
  /** Called whenever a frame was rendered (preview overlays). */
  onRender: (() => void) | null = null;

  private outline: OutlineEffect;
  private keyLight = new THREE.DirectionalLight(0xffffff, 2);
  private rimLight = new THREE.DirectionalLight(0xffffff, 1);
  private fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
  private ambient = new THREE.AmbientLight(0xffffff, 0.5);
  private lightTarget = new THREE.Object3D();
  private content = new THREE.Group();
  private rig: RigBuild | null = null;
  private structureKey = '';
  private buildResources = new Set<Disposable>();
  private gradientMaps = new Map<number, THREE.DataTexture>();
  private model: { pivot: THREE.Group; root: THREE.Object3D; originals: Map<THREE.Mesh, THREE.Material | THREE.Material[]>; key: string } | null = null;
  private modelResources = new Set<Disposable>();
  private cam: StudioCamera | null = null;
  private dragging = false;
  private frame = 0;
  private disposed = false;
  aspect = 1;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.outline = new OutlineEffect(this.renderer, { defaultThickness: 0.006, defaultColor: [0, 0, 0], defaultAlpha: 1, defaultKeepAlive: true });
    // OutlineEffect reads `this.autoClear` but never initializes it.
    (this.outline as unknown as { autoClear: boolean }).autoClear = true;
    this.scene.add(this.lightTarget, this.keyLight, this.rimLight, this.fillLight, this.ambient, this.content);
    this.lightTarget.position.set(0, 2.6, 0);
    for (const l of [this.keyLight, this.rimLight, this.fillLight]) l.target = this.lightTarget;
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /* ---------------------------------------------------------------- */
  /* Sizing / controls                                                 */
  /* ---------------------------------------------------------------- */

  setSize(cssW: number, cssH: number) {
    if (this.disposed) return;
    const w = Math.max(1, Math.round(cssW)),
      h = Math.max(1, Math.round(cssH));
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, true);
    this.aspect = w / h;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  attachControls() {
    if (this.controls) return;
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = false;
    c.minPolarAngle = 0.04;
    c.maxPolarAngle = Math.PI - 0.04;
    c.zoomSpeed = 0.8;
    c.panSpeed = 0.8;
    c.addEventListener('change', () => this.requestRender());
    c.addEventListener('start', () => (this.dragging = true));
    c.addEventListener('end', () => {
      this.dragging = false;
      this.emitCameraEdit();
    });
    this.controls = c;
  }

  private emitCameraEdit() {
    if (!this.cam || !this.controls || !this.onCameraEdit) return;
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    const dist = off.length();
    const yaw = Math.atan2(off.x, off.z) / DEG;
    const pitch = Math.asin(Math.max(-1, Math.min(1, off.y / Math.max(1e-6, dist)))) / DEG;
    const base = this.cam.target;
    this.onCameraEdit({
      yaw: Math.round(yaw * 10) / 10,
      pitch: Math.round(pitch * 10) / 10,
      distance: Math.round((dist / Math.max(0.01, this.cam.baseDistance)) * 1000) / 1000,
      pan: [t.x - base[0], t.y - base[1], t.z - base[2]],
    });
  }

  /* ---------------------------------------------------------------- */
  /* Materials                                                         */
  /* ---------------------------------------------------------------- */

  private gradientMap(steps: number): THREE.DataTexture {
    const n = Math.max(2, Math.min(6, Math.round(steps)));
    let t = this.gradientMaps.get(n);
    if (!t) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = Math.round(255 * (0.28 + 0.72 * Math.pow(i / (n - 1), 0.9)));
      t = new THREE.DataTexture(data, n, 1, THREE.RedFormat);
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.gradientMaps.set(n, t);
    }
    return t;
  }

  private makeMaterial(
    mode: ShadingMode,
    shading: StudioShading,
    kind: SurfaceKind | PartRole,
    color: string,
    opts: { doubleSide?: boolean; map?: THREE.Texture | null } = {},
  ): THREE.Material {
    const side = opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide;
    const faceted = kind === 'hair';
    let m: THREE.Material;
    if (mode === 'flat') {
      m = new THREE.MeshBasicMaterial({ color: shading.flatColor, side });
    } else if (mode === 'toon') {
      m = new THREE.MeshToonMaterial({
        color: opts.map ? '#ffffff' : color,
        map: opts.map ?? null,
        gradientMap: this.gradientMap(shading.toonSteps),
        side,
      });
      (m as THREE.MeshToonMaterial).flatShading = faceted;
    } else {
      const metal = kind === 'metal' || kind === 'gold';
      m = new THREE.MeshStandardMaterial({
        color: opts.map ? '#ffffff' : color,
        map: opts.map ?? null,
        roughness: metal ? 0.35 : kind === 'hair' ? 0.75 : 0.62,
        metalness: metal ? 0.45 : 0,
        flatShading: faceted,
        side,
      });
    }
    this.buildResources.add(m);
    return m;
  }

  /* ---------------------------------------------------------------- */
  /* Character                                                         */
  /* ---------------------------------------------------------------- */

  private clearContent() {
    this.content.clear();
    for (const r of this.buildResources) r.dispose();
    this.buildResources.clear();
    this.rig = null;
    this.structureKey = '';
  }

  private clearModel() {
    if (!this.model) return;
    this.content.remove(this.model.pivot);
    for (const r of this.modelResources) r.dispose();
    this.modelResources.clear();
    this.model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const orig = this.model!.originals.get(mesh) ?? mesh.material;
      for (const m of Array.isArray(orig) ? orig : [orig]) disposeMaterial(m);
    });
    this.model = null;
  }

  private buildCharacter(state: StudioState) {
    this.clearModel();
    this.clearContent();
    const { appearance: ap, shading } = state;
    const mode = shading.mode;
    const cache = new Map<string, THREE.Material>();
    const mat = (kind: SurfaceKind | PartRole, color: string, doubleSide = false) => {
      const key = `${kind}|${color}|${doubleSide}`;
      let m = cache.get(key);
      if (!m) cache.set(key, (m = this.makeMaterial(mode, shading, kind, color, { doubleSide })));
      return m;
    };
    const faceTex = mode === 'flat' ? null : buildFaceTexture(ap.face, ap.colors.head);
    if (faceTex) this.buildResources.add(faceTex);
    const track = <T extends Disposable>(g: T): T => {
      this.buildResources.add(g);
      return g;
    };
    const rig = buildRig(state.rig, {
      part: (role) => {
        const base = mat(role, ap.colors[role]);
        if (role === 'head' && faceTex) {
          const face = this.makeMaterial(mode, shading, 'head', ap.colors.head, { map: faceTex });
          return [base, base, base, base, face, base];
        }
        return base;
      },
      track,
    });
    const parts: PartsFactory = {
      material: (kind, color, o) => mat(kind, color, !!o?.doubleSide),
      track,
    };
    const hairGeo = buildHairGeometry(ap.hair);
    if (hairGeo) {
      track(hairGeo);
      const hair = new THREE.Mesh(hairGeo, mat('hair', ap.hairColor));
      hair.name = 'Hair';
      hair.userData.joint = 'neck';
      rig.attach.head.add(hair);
    }
    for (const a of buildAccessories(parts, ap.accessories, ap.accentColor)) {
      a.object.traverse((o) => {
        o.userData.joint = a.attach === 'head' ? 'neck' : a.attach === 'torso' ? (state.rig === 'R15' ? 'waist' : 'root') : undefined;
      });
      rig.attach[a.attach].add(a.object);
    }
    this.content.add(rig.figure);
    this.rig = rig;
  }

  /** Update the character from the full studio state (rebuilds meshes only when needed). */
  setCharacter(state: StudioState) {
    if (this.disposed) return;
    const s = state.shading;
    const key = JSON.stringify([state.rig, state.appearance, s.mode, s.toonSteps, s.mode === 'flat' ? s.flatColor : '']);
    if (key !== this.structureKey || !this.rig) {
      this.buildCharacter(state);
      this.structureKey = key;
    }
    applyPose(this.rig!, state.pose);
    this.applyView(state);
  }

  /* ---------------------------------------------------------------- */
  /* Imported model                                                    */
  /* ---------------------------------------------------------------- */

  /** Show an imported model (normalized to character height, centered, standing on y = 0). */
  setModel(root: THREE.Object3D) {
    this.clearContent();
    this.clearModel();
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = size.y > 1e-6 ? MODEL_HEIGHT / Math.max(size.y, size.x * 0.6, size.z * 0.6) : 1;
    const holder = new THREE.Group();
    holder.add(root);
    root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    holder.scale.setScalar(s);
    const pivot = new THREE.Group();
    pivot.add(holder);
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        originals.set(mesh, mesh.material);
        if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
      }
    });
    this.model = { pivot, root, originals, key: '' };
    this.content.add(pivot);
  }

  get hasModel() {
    return !!this.model;
  }

  /** Apply view settings + model rotation to the imported model. */
  setModelView(view: ViewSettings, rotationY: number) {
    if (!this.model || this.disposed) return;
    const s = view.shading;
    const key = JSON.stringify([s.mode, s.toonSteps, s.flatColor]);
    if (key !== this.model.key) {
      for (const r of this.modelResources) r.dispose();
      this.modelResources.clear();
      for (const [mesh, orig] of this.model.originals) {
        const list = Array.isArray(orig) ? orig : [orig];
        const next = list.map((m) => {
          if (s.mode === 'smooth') return m;
          const src = m as THREE.MeshStandardMaterial;
          let out: THREE.Material;
          if (s.mode === 'flat') out = new THREE.MeshBasicMaterial({ color: s.flatColor, side: src.side });
          else
            out = new THREE.MeshToonMaterial({
              color: src.color ? src.color.clone() : new THREE.Color('#cccccc'),
              map: src.map ?? null,
              gradientMap: this.gradientMap(s.toonSteps),
              side: src.side,
              transparent: src.transparent,
              alphaTest: src.alphaTest,
              opacity: src.opacity,
            });
          this.modelResources.add(out);
          return out;
        });
        mesh.material = Array.isArray(orig) ? next : next[0];
      }
      this.model.key = key;
    }
    this.model.pivot.rotation.y = rotationY * DEG;
    this.applyView(view);
  }

  /* ---------------------------------------------------------------- */
  /* Lights, outline, camera                                           */
  /* ---------------------------------------------------------------- */

  applyView(view: ViewSettings) {
    const L = view.lighting;
    const place = (light: THREE.DirectionalLight, s: LightSpec) => {
      const az = s.azimuth * DEG,
        el = s.elevation * DEG;
      light.position.set(Math.sin(az) * Math.cos(el) * 30, 2.6 + Math.sin(el) * 30, Math.cos(az) * Math.cos(el) * 30);
      light.color.set(s.color);
      light.intensity = Math.max(0, s.intensity);
      light.visible = s.intensity > 0.001;
    };
    place(this.keyLight, L.key);
    place(this.rimLight, L.rim);
    place(this.fillLight, L.fill);
    this.ambient.color.set(L.ambientColor);
    this.ambient.intensity = Math.max(0, L.ambient);

    const sh = view.shading;
    this.outline.enabled = sh.outline && sh.outlineThickness > 0;
    const params = {
      thickness: sh.outlineThickness * 0.0021,
      color: new THREE.Color(sh.outlineColor).toArray(),
      alpha: 1,
      visible: true,
      keepAlive: true,
    };
    this.content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.userData.outlineParameters = params;
    });
    this.setCamera(view.camera);
  }

  setCamera(cam: StudioCamera) {
    this.cam = cam;
    if (this.dragging) return;
    const t = new THREE.Vector3(cam.target[0] + cam.pan[0], cam.target[1] + cam.pan[1], cam.target[2] + cam.pan[2]);
    const dist = Math.max(0.5, cam.baseDistance * cam.distance);
    const yaw = cam.yaw * DEG,
      pitch = Math.max(-88, Math.min(88, cam.pitch)) * DEG;
    this.camera.position.set(
      t.x + Math.sin(yaw) * Math.cos(pitch) * dist,
      t.y + Math.sin(pitch) * dist,
      t.z + Math.cos(yaw) * Math.cos(pitch) * dist,
    );
    this.camera.fov = Math.max(5, Math.min(110, cam.fov));
    this.camera.near = Math.max(0.05, dist / 100);
    this.camera.far = dist * 20 + 100;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(t);
    if (this.controls) {
      this.controls.target.copy(t);
      this.controls.update();
    }
    this.requestRender();
  }

  /** Compute the framing target/distance for the current content, framing mode, fov and aspect. */
  computeFraming(framing: Framing, fov: number, aspect: number): FramingResult {
    this.content.updateMatrixWorld(true);
    let box = new THREE.Box3();
    if (this.rig) {
      for (const m of this.rig.meshes) box.expandByObject(m);
      if (framing === 'head') box = new THREE.Box3().setFromObject(this.rig.head).expandByScalar(0.25);
      else if (framing === 'waist') {
        const hipY = (this.rig.joints.root ?? this.rig.figure).getWorldPosition(new THREE.Vector3()).y - (this.rig.type === 'R6' ? 1 : 0.2);
        box.min.y = Math.max(box.min.y, hipY - 0.1);
      }
    } else if (this.model) {
      box.setFromObject(this.model.pivot);
      if (framing !== 'full') {
        const h = box.max.y - box.min.y;
        box.min.y = box.max.y - h * (framing === 'head' ? 0.28 : 0.6);
      }
    } else box.set(new THREE.Vector3(-2, 0, -1), new THREE.Vector3(2, 5.4, 1));
    if (box.isEmpty()) box.set(new THREE.Vector3(-2, 0, -1), new THREE.Vector3(2, 5.4, 1));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const half = Math.tan((Math.max(5, fov) * DEG) / 2);
    const horiz = Math.max(size.x, size.z);
    const margin = framing === 'head' ? 1.25 : 1.12;
    const dist = Math.max((size.y / 2) / half, (horiz / 2) / (half * Math.max(0.2, aspect))) * margin + horiz / 2;
    return { target: [c.x, c.y, c.z], baseDistance: Math.max(1, dist) };
  }

  /** Raycast the rig at client coordinates → joint id of the clicked body part. */
  pick(clientX: number, clientY: number): JointId | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObject(this.content, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.joint) o = o.parent;
      if (o?.userData.joint) return o.userData.joint as JointId;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  requestRender() {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    if (this.disposed) return;
    this.outline.render(this.scene, this.camera);
    this.onRender?.();
  }

  /** Max drawing-buffer dimension supported by the GPU. */
  maxRenderSize(): number {
    const gl = this.renderer.getContext();
    const rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    return Math.max(512, Math.min(rb || 4096, vp?.[0] || 4096, vp?.[1] || 4096, 8192));
  }

  /**
   * Render the current view at (w × h) with a transparent background. Supersamples (up to 2×)
   * when the GPU allows it for smooth toon edges.
   */
  renderToCanvas(w: number, h: number): HTMLCanvasElement {
    const max = this.maxRenderSize();
    const ss = Math.max(1, Math.min(2, Math.floor(max / Math.max(w, h))));
    const rw = Math.min(max, Math.round(w * ss)),
      rh = Math.min(max, Math.round(h * ss));
    const prev = this.renderer.getSize(new THREE.Vector2());
    const prevPR = this.renderer.getPixelRatio();
    const prevAspect = this.camera.aspect;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(rw, rh, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.outline.render(this.scene, this.camera);
    const out = createCanvas(w, h);
    const ctx = ctx2d(out);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.renderer.domElement, 0, 0, rw, rh, 0, 0, w, h);
    this.renderer.setPixelRatio(prevPR);
    this.renderer.setSize(prev.x, prev.y, false);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.render();
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Disposal                                                          */
  /* ---------------------------------------------------------------- */

  dispose() {
    if (this.disposed) return;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.controls?.dispose();
    this.clearModel();
    this.clearContent();
    for (const t of this.gradientMaps.values()) t.dispose();
    this.gradientMaps.clear();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) disposeMaterial(m);
      }
    });
    this.scene.clear();
    this.disposed = true;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

function disposeMaterial(m: THREE.Material | undefined) {
  if (!m) return;
  for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
  m.dispose();
}
