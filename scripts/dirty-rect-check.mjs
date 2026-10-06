#!/usr/bin/env node
/**
 * Dirty-rect (live painting) correctness check: incremental composites vs fresh full renders.
 *
 *   npx vite --port 5321 &
 *   node scripts/dirty-rect-check.mjs --url http://localhost:5321/ [--gpu] [--only a,b] [--frames 24] [--every 3]
 *        [--no-e2e | --e2e-only] [--no-edits]
 *   node scripts/dirty-rect-check.mjs --url http://localhost:5321/ --bench [--gpu] [--bench-frames 90] [--bench-only move,4K]
 *
 * Part 1 (renderer): for each scenario a document is built, rendered (warming every cache and the
 * live composite), then strokes are painted frame by frame straight into layer / mask bitmaps
 * (`bitmaps.touch(id, rect)` like the paint tools). After every frame the live composite
 * (renderDocumentLive, the viewport path) is updated incrementally; every `--every` frames it is
 * compared with a full render of a CLONE of the document (new layer ids: nothing cached, and the
 * original's caches stay untouched). Every few frames the shared renderDocument path and a 0.25×
 * render are refreshed too. After the strokes: live / shared / small vs a full render after
 * invalidateRenderCache(), then again after settling (approximate GPU work is re-rendered exactly).
 *
 * Part 1b (renderer, edit sequences; skip with --no-edits): structural edits as the store makes them
 * (a new immutable document per step) — clipping onto pass-through groups, Create / Release Clipping
 * Mask on layers of a clip stack (the layers clipped above change base), stroke size drags on
 * semi-transparent content, below-renders (histograms / PSD bakes) after patch edits inside styled
 * groups, inside effects on layers hanging off the canvas, moves of layers with smart filters. After
 * every step the live composite, renderDocument at 1× / 0.25× and the step's below-render are
 * compared with from-scratch renders of a clone; while dragging, smart filters must not run again.
 *
 * Part 2 (end-to-end, demo document): real brush / eraser / mask strokes through the paint tools
 * and the viewport at several zoom levels; the viewport's document canvas after the stroke (and
 * after the settle delay) is compared with a forced full re-render + full redraw.
 *
 * Pixels are compared premultiplied; a channel may differ by at most 1. With the software canvas
 * (default) every comparison must pass, except mid-stroke frames of work the renderer reports as
 * inexact everywhere (several effects sharing distance fields). With --gpu (accelerated canvas
 * through SwiftShader) mid-stroke frames may be approximate (GPU blurs / resampling of crops are
 * not bit-exact), so only the settled results must pass; mid-stroke maxima are reported.
 * Exit code 1 when a required comparison fails.
 *
 * --bench (performance, no correctness checks): the real brush tool at 200 px, driven by pointer
 * events through the viewport at fit zoom, on the demo's "Red Glow" (full-canvas raster under the
 * demo's adjustment layers), on its "Roblox Character" (layer effects, inside a group) and on a
 * one-layer 1920×1080 document. Reports the main-thread work per pointermove (the pointer handler
 * plus the animation-frame callbacks it causes: paint, composite, screen redraw) — mean, median,
 * p90, max —, the cost of the frame that re-renders approximate GPU work exactly after the stroke
 * (the settle; none on the software canvas) and the longest main-thread task within 1.5 s after
 * the stroke (any work). Works against older trees too (for before/after numbers).
 * Perf regression guards (the bench exits 1 past them; release review render-paint-diff-3 and
 * e2e-flows-3): painting on 1080p with 8 / 16 and 4K with 2 / 8 (and 5 with a 4 GB device's hard
 * cap) document-sized layers holding a blob with Drop Shadow + Stroke (renders cropped to their
 * content; no other layer may re-render during the stroke, mean frame time under the limit);
 * painting on 4K with 10 (6 with 4 GB) layers whose large content cannot be cropped — layer renders
 * alone past the cache's hard cap: each layer below may re-render once at the start of the stroke,
 * never afterwards; and Move-tool drags of the Crimson / Gothic template characters (no
 * smart-filter run at full size during the drag, mean time per pointermove under the limit).
 */
import { chromium } from 'playwright-core';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);
const url = args.url ?? 'http://localhost:5173/';
const gpu = args.gpu === 'true';
const opts = {
  only: args.only ? String(args.only).split(',') : null,
  frames: Number(args.frames ?? 24),
  every: Number(args.every ?? 3),
  gpu,
};

/* ------------------------------------------------------------------------------------------ */
/* Page side (serialized into the page; must be self-contained)                                 */
/* ------------------------------------------------------------------------------------------ */

async function rendererPart(opts) {
  const C = await import('/src/render/compositor.ts');
  const DEMO = await import('/src/dev/demo.ts');
  const PROBE = await import('/src/render/backendProbe.ts');
  const { bitmaps, documentUtils: D } = window.__app;
  // Normally probed at idle time; run it now so every scenario sees the final answer.
  const cropExact = PROBE.probeBackendNow();
  const settle = () => (C.settleRenderCaches ? C.settleRenderCaches() : false);

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function canvas(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    if (draw) draw(c.getContext('2d'), c);
    return c;
  }
  function premul(c) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      out[i] = (d[i] * a + 127) / 255;
      out[i + 1] = (d[i + 1] * a + 127) / 255;
      out[i + 2] = (d[i + 2] * a + 127) / 255;
      out[i + 3] = a;
    }
    return { d: out, w: c.width, h: c.height };
  }
  function diff(a, b) {
    if (a.w !== b.w || a.h !== b.h) return { max: 999, size: `${a.w}x${a.h} vs ${b.w}x${b.h}` };
    let max = 0,
      over = 0,
      at = null;
    for (let i = 0; i < a.d.length; i++) {
      const d = Math.abs(a.d[i] - b.d[i]);
      if (d > 1) over++;
      if (d > max) {
        max = d;
        at = [(i >> 2) % a.w, Math.floor((i >> 2) / a.w), i & 3, a.d[i], b.d[i]];
      }
    }
    return over ? { max, over, at } : { max };
  }
  const worst = (p, q) => (!p || q.max > p.max ? q : p);
  const worstOf = (p, q) => (!p ? q : !q ? p : q.max > p.max ? q : p);

  /** Copy of a document with new document and layer ids (same bitmaps): renders from scratch. */
  let cloneSeq = 0;
  function cloneDoc(doc) {
    const suf = `~ref${++cloneSeq}`;
    const map = (id) => id + suf;
    const layers = {};
    for (const [id, l] of Object.entries(doc.layers)) {
      const c = structuredClone(l);
      c.id = map(id);
      if (Array.isArray(c.childIds)) c.childIds = c.childIds.map(map);
      layers[map(id)] = c;
    }
    return { ...doc, id: doc.id + suf, layers, rootIds: doc.rootIds.map(map) };
  }

  const W = 1280,
    H = 800;
  function rasterCanvas(w, h, seed = 1) {
    const R = rng(seed);
    return canvas(w, h, (g) => {
      g.fillStyle = '#2a6fb0';
      g.beginPath();
      g.ellipse(w * 0.5, h * 0.5, w * 0.3, h * 0.32, 0.3, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 12; i++) {
        g.fillStyle = `hsla(${Math.floor(R() * 360)},70%,55%,${0.4 + R() * 0.6})`;
        g.fillRect(R() * w * 0.8, R() * h * 0.8, 40 + R() * 200, 30 + R() * 150);
      }
    });
  }
  function maskCanvas(w, h) {
    return canvas(w, h, (g) => {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#000';
      g.beginPath();
      g.arc(w * 0.35, h * 0.45, Math.min(w, h) * 0.18, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#777';
      g.fillRect(w * 0.6, h * 0.1, w * 0.25, h * 0.3);
    });
  }
  const newMask = (doc, extra = {}) => ({ bitmapId: bitmaps.add(maskCanvas(doc.width, doc.height)), enabled: true, density: 1, feather: 0, inverted: false, ...extra });
  function addRaster(doc, o = {}) {
    const w = o.w ?? doc.width,
      h = o.h ?? doc.height;
    const id = bitmaps.add(o.canvas ?? rasterCanvas(w, h, o.seed ?? 1));
    const l = D.makeRasterLayer({ name: o.name ?? 'L', bitmapId: id, width: w, height: h, transform: o.transform });
    Object.assign(l, o.props ?? {});
    if (o.mask) l.mask = newMask(doc, o.mask);
    D.insertLayerDraft(doc, l, { parentId: o.parent ?? null });
    return l;
  }
  function addAdj(doc, filterId, params, extra = {}, parent = null) {
    const a = D.makeAdjustmentLayer({ filterId, params });
    Object.assign(a, extra);
    if (extra.mask) a.mask = newMask(doc, extra.mask);
    D.insertLayerDraft(doc, a, { parentId: parent });
    return a;
  }
  function addText(doc, x, y, content, size = 90) {
    const t = D.makeTextLayer({ x, y, text: { content, fontFamily: 'Anton', fontSize: size, fill: { type: 'solid', color: '#f5f5f5' } } });
    D.insertLayerDraft(doc, t, { parentId: null });
    return t;
  }
  function addGroup(doc, props = {}, parent = null) {
    const g = D.makeGroupLayer({ name: 'G' });
    Object.assign(g, props);
    if (props.mask) g.mask = newMask(doc, props.mask);
    D.insertLayerDraft(doc, g, { parentId: parent });
    return g;
  }
  let fxSeq = 0;
  const fx = (effectId, params) => ({ id: `e${++fxSeq}`, effectId, enabled: true, params });

  /** Random-walk stroke of soft dabs (gray levels on masks), touched with each dab's rect. */
  function stroker(bitmapId, seed, o = {}) {
    const R = rng(seed);
    const c = bitmaps.get(bitmapId);
    let x = c.width * (0.2 + R() * 0.6),
      y = c.height * (0.2 + R() * 0.6);
    let ang = R() * Math.PI * 2;
    return () => {
      const g = c.getContext('2d');
      const n = 1 + Math.floor(R() * 3);
      for (let i = 0; i < n; i++) {
        ang += (R() - 0.5) * 0.9;
        x = Math.min(c.width + 30, Math.max(-30, x + Math.cos(ang) * 14));
        y = Math.min(c.height + 30, Math.max(-30, y + Math.sin(ang) * 14));
        const r = (o.size ?? 40) * (0.5 + R());
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        let col;
        if (o.mask) {
          const v = R() < 0.5 ? 0 : R() < 0.5 ? 255 : Math.floor(R() * 255);
          col = `rgb(${v},${v},${v})`;
        } else col = `hsl(${Math.floor(R() * 360)},80%,${30 + Math.floor(R() * 40)}%)`;
        grad.addColorStop(0, col);
        grad.addColorStop(0.7, col);
        grad.addColorStop(1, o.mask ? col.replace('rgb', 'rgba').replace(')', ',0)') : 'rgba(0,0,0,0)');
        g.save();
        g.globalCompositeOperation = !o.mask && o.erase && R() < 0.3 ? 'destination-out' : 'source-over';
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.restore();
        bitmaps.touch(bitmapId, { x: x - r - 1, y: y - r - 1, width: 2 * r + 2, height: 2 * r + 2 });
      }
    };
  }

  const statKeys = ['regionUpdates', 'liveRegionRenders', 'liveFullRenders', 'docRegionRenders', 'layerRenders', 'approxUpdates', 'inexactUpdates', 'settles'];
  const statSnap = () => {
    const info = C.renderCacheInfo();
    return Object.fromEntries(statKeys.map((k) => [k, info[k] ?? 0]));
  };

  async function scenario(name, build, so = {}) {
    if (opts.only && !opts.only.includes(name)) return null;
    let doc = build();
    const list = typeof so.strokes === 'function' ? so.strokes(doc) : so.strokes ?? [{}];
    const strokes = list.map((s, i) => {
      const target = s.target ?? doc.__paint;
      return { ...s, target, paint: stroker(target, 7 + i * 13 + name.length, s) };
    });
    C.invalidateRenderCache();
    const scale = 0.25;
    const t0 = performance.now();
    C.renderDocumentLive(doc);
    C.renderDocument(doc);
    C.renderDocument(doc, { scale });
    // A structure change that keeps some layer objects (e.g. Canvas Size: fill layers and groups
    // stay as they are), compared right away, before any stroke.
    let mutated = null;
    if (so.mutate) {
      doc = so.mutate(doc);
      const ref1 = premul(C.renderDocument(cloneDoc(doc)));
      mutated = worstOf(worstOf(diff(premul(C.renderDocumentLive(doc).canvas), ref1), diff(premul(C.renderDocument(doc)), ref1)), diff(premul(C.renderDocument(doc, { scale })), premul(C.renderDocument(cloneDoc(doc), { scale }))));
    }
    const s0 = statSnap();
    const frames = so.frames ?? opts.frames;
    let liveMs = 0,
      n = 0,
      frame = null;
    for (const st of strokes) {
      for (let f = 0; f < frames; f++) {
        st.paint();
        const t = performance.now();
        const live = C.renderDocumentLive(doc);
        liveMs += performance.now() - t;
        n++;
        if (n % opts.every === 0) frame = worst(frame, diff(premul(live.canvas), premul(C.renderDocument(cloneDoc(doc)))));
        if (f % 7 === 6) C.renderDocument(doc);
        if (f % 4 === 1) C.renderDocument(doc, { scale });
      }
    }
    const s1 = statSnap();
    const live = premul(C.renderDocumentLive(doc).canvas);
    const shared = premul(C.renderDocument(doc));
    const small = premul(C.renderDocument(doc, { scale }));
    const ref = premul(C.renderDocument(cloneDoc(doc)));
    const refSmall = premul(C.renderDocument(cloneDoc(doc), { scale }));
    // Settle (exact re-render of approximate work), then compare with a full render from scratch.
    const settled = settle();
    const liveS = premul(C.renderDocumentLive(doc).canvas);
    const sharedS = premul(C.renderDocument(doc));
    C.invalidateRenderCache();
    const full = premul(C.renderDocument(doc));
    const stats = {};
    for (const k of statKeys) stats[k] = s1[k] - s0[k];
    return {
      name,
      ...(mutated ? { mutated } : {}),
      frame: frame ?? { max: 0 },
      live: diff(live, ref),
      shared: diff(shared, ref),
      small: diff(small, refSmall),
      settled: { did: settled, live: diff(liveS, full), shared: diff(sharedS, full) },
      refVsFull: diff(ref, full),
      stats,
      msPerFrame: +(liveMs / Math.max(1, n)).toFixed(2),
      ms: Math.round(performance.now() - t0),
    };
  }

  const doc0 = (bg = '#ffffff', w = W, h = H) => D.createDocument({ name: 'T', width: w, height: h, background: bg });
  const results = [];
  const run = async (...a) => {
    try {
      const r = await scenario(...a);
      if (r) {
        results.push(r);
        console.log('[dirty-rect] ' + JSON.stringify(r));
      }
    } catch (e) {
      results.push({ name: a[0], error: String(e && e.stack ? e.stack : e) });
    }
  };

  await run('plain', () => {
    const d = doc0();
    d.__paint = addRaster(d).bitmapId;
    return d;
  });
  await run('plain-1080p', () => {
    const d = doc0('#ffffff', 1920, 1080);
    d.__paint = addRaster(d).bitmapId;
    return d;
  }, { strokes: [{ size: 100 }] });
  await run('plain-transparent', () => {
    const d = doc0(null);
    addRaster(d, { seed: 3, name: 'under' });
    d.__paint = addRaster(d, { seed: 4 }).bitmapId;
    return d;
  });
  await run('fx-shadow-stroke', () => {
    const d = doc0();
    d.__paint = addRaster(d, { props: { effects: [fx('drop-shadow', { distance: 18, size: 24, opacity: 0.8 }), fx('stroke', { size: 4, color: '#ffffff' })] } }).bitmapId;
    return d;
  }, { strokes: [{ erase: true }] });
  // render-paint-diff-3: a document-sized layer holding a small blob (Layer ▸ New Layer + a few
  // dabs) with Drop Shadow + Stroke renders cropped to its content: strokes wander out of the crop
  // (rendered again with a larger one) and erase; a layer with effects that starts empty.
  await run('fx-blob-crop', () => {
    const d = doc0();
    addRaster(d, { seed: 5 });
    const blob = canvas(W, H, (g) => {
      g.fillStyle = '#c04080';
      g.beginPath();
      g.ellipse(W * 0.45, H * 0.5, 60, 80, 0.4, 0, Math.PI * 2);
      g.fill();
    });
    d.__paint = addRaster(d, { canvas: blob, props: { effects: [fx('drop-shadow', { distance: 18, size: 24, opacity: 0.8 }), fx('stroke', { size: 4, color: '#ffffff' })] } }).bitmapId;
    return d;
  }, { strokes: [{}, { erase: true }] });
  await run('fx-empty-crop', () => {
    const d = doc0();
    addRaster(d, { seed: 6 });
    d.__paint = addRaster(d, { canvas: canvas(W, H), props: { effects: [fx('outer-glow', { size: 20 }), fx('stroke', { size: 6, position: 'center', color: '#20c0ff' })] } }).bitmapId;
    return d;
  }, { strokes: [{ size: 18 }] });
  await run('fx-inner-multi', () => {
    const d = doc0();
    const effects = [
      fx('inner-shadow', { distance: 8, size: 12 }),
      fx('inner-glow', { size: 14, choke: 0.2 }),
      fx('stroke', { size: 6, position: 'inside', color: '#ff0' }),
      fx('bevel', { size: 10, soften: 2 }),
      fx('satin', {}),
    ];
    d.__paint = addRaster(d, { props: { opacity: 0.85, fillOpacity: 0.6, effects } }).bitmapId;
    return d;
  }, { strokes: [{ erase: true }], frames: 12 });
  await run('fx-outer', () => {
    const d = doc0();
    const effects = [
      fx('outer-glow', { size: 30, spread: 0.3 }),
      fx('long-shadow', { length: 70 }),
      fx('stroke', { size: 5, position: 'center', color: '#0a0' }),
      fx('color-overlay', { color: '#ff3366', opacity: 0.4, blendMode: 'multiply' }),
      fx('gradient-overlay', { opacity: 0.5 }),
      fx('pattern-overlay', { assetId: 'paper-texture', opacity: 0.6 }),
    ];
    d.__paint = addRaster(d, { props: { effects } }).bitmapId;
    return d;
  }, { strokes: [{ erase: true }] });
  await run('under-adjustments', () => {
    const d = doc0();
    d.__paint = addRaster(d).bitmapId;
    addAdj(d, 'hue-saturation', { hue: 40, saturation: 30 });
    addAdj(d, 'levels', { inBlack: 20, gamma: 1.4 });
    addAdj(d, 'gradient-map', { dither: true });
    addAdj(d, 'vignette', { amount: 0.6 });
    return d;
  });
  await run('under-masked-adjustments', () => {
    const d = doc0();
    d.__paint = addRaster(d).bitmapId;
    addAdj(d, 'brightness-contrast', { brightness: 60, contrast: 40 }, { mask: { feather: 15 } });
    addAdj(d, 'hue-saturation', { hue: -60 }, { opacity: 0.6, blendMode: 'multiply' });
    return d;
  });
  await run('clipped', () => {
    const d = doc0();
    addRaster(d, { name: 'base', canvas: canvas(W, H, (g) => ((g.fillStyle = '#333'), g.beginPath(), g.arc(W / 2, H / 2, 300, 0, 7), g.fill())) });
    const k = addRaster(d, { name: 'clipped', seed: 5, props: { clipped: true, blendMode: 'overlay' } });
    addAdj(d, 'hue-saturation', { hue: 90 }, { clipped: true });
    d.__paint = k.bitmapId;
    d.__base = d.layers[d.rootIds[0]].bitmapId;
    return d;
  }, { strokes: (d) => [{ target: d.__paint }, { target: d.__base, erase: true }] });
  await run('clipped-soft', () => {
    // Soft-edged base (radial alpha falloff) at 70% fill under a mask; clipped layers with a drop
    // shadow (behind pieces), multiply, and an adjustment with a blend mode. Transparent document.
    const d = doc0(null);
    const soft = canvas(W, H, (g) => {
      const rg = g.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, 360);
      rg.addColorStop(0, 'rgba(200,120,60,1)');
      rg.addColorStop(1, 'rgba(200,120,60,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, W, H);
    });
    const base = addRaster(d, { name: 'base', canvas: soft, props: { fillOpacity: 0.7 }, mask: { feather: 0 } });
    const k = addRaster(d, { name: 'clip-fx', seed: 6, props: { clipped: true, effects: [fx('drop-shadow', { distance: 14, size: 10 })] } });
    addRaster(d, { name: 'clip-mul', seed: 8, props: { clipped: true, blendMode: 'multiply', opacity: 0.8 } });
    addAdj(d, 'hue-saturation', { hue: -50, saturation: 20 }, { clipped: true, blendMode: 'color' });
    d.__paint = k.bitmapId;
    d.__base = base.bitmapId;
    return d;
  }, { strokes: (d) => [{ target: d.__paint }, { target: d.__base, erase: true }] });
  await run('clipped-group-base', () => {
    const d = doc0();
    const g = addGroup(d, { blendMode: 'normal' });
    const a = addRaster(d, { parent: g.id, name: 'g1', canvas: canvas(W, H, (c) => ((c.fillStyle = 'rgba(40,160,90,0.6)'), c.beginPath(), c.arc(W * 0.4, H * 0.5, 260, 0, 7), c.fill())) });
    addRaster(d, { parent: g.id, name: 'g2', seed: 11, props: { opacity: 0.5 } });
    addRaster(d, { name: 'clip', seed: 12, props: { clipped: true, blendMode: 'screen' } });
    d.__paint = a.bitmapId;
    return d;
  });
  await run('clipped-fx-base', () => {
    // Base whose above-stage effects reach beyond its shape (centered stroke) / add coverage over
    // soft edges (overlay): clipped layers only get the shape's share of the coverage.
    const d = doc0();
    const base = addRaster(d, { name: 'base', seed: 13, props: { effects: [fx('color-overlay', { color: '#ffcc00', opacity: 0.5 }), fx('stroke', { size: 6, position: 'center', color: '#ff00aa' })] } });
    addRaster(d, { name: 'clip', seed: 14, props: { clipped: true } });
    d.__paint = base.bitmapId;
    return d;
  }, { strokes: [{ erase: true }] });
  await run('adjustment-blend-soft', () => {
    // Adjustments with blend modes over semi-transparent pixels (transparent document): the result
    // keeps the backdrop's alpha, blended on the CPU (canvas blending rounds ties differently on a
    // crop than on the whole surface).
    const d = doc0(null);
    const soft = canvas(W, H, (g) => {
      const rg = g.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, 380);
      rg.addColorStop(0, 'rgba(90,160,220,1)');
      rg.addColorStop(1, 'rgba(90,160,220,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, W, H);
    });
    d.__paint = addRaster(d, { name: 'soft', canvas: soft }).bitmapId;
    addAdj(d, 'hue-saturation', { hue: -50, saturation: 20 }, { blendMode: 'color' });
    addAdj(d, 'levels', { inBlack: 30, gamma: 0.8 }, { blendMode: 'soft-light', opacity: 0.6, mask: { feather: 0 } });
    return d;
  }, { strokes: [{ erase: true }] });
  await run('masked', () => {
    const d = doc0();
    d.__paint = addRaster(d, { mask: { feather: 0 } }).bitmapId;
    return d;
  });
  await run('masked-feather-fx', () => {
    const d = doc0();
    d.__paint = addRaster(d, { mask: { feather: 25, density: 0.8, inverted: true }, props: { effects: [fx('stroke', { size: 3 })] } }).bitmapId;
    return d;
  });
  await run('paint-mask', () => {
    const d = doc0();
    const l = addRaster(d, { mask: { feather: 0 }, props: { effects: [fx('drop-shadow', { distance: 10, size: 16 })] } });
    d.__paint = l.mask.bitmapId;
    return d;
  }, { strokes: [{ mask: true, size: 60 }] });
  await run('paint-mask-feather', () => {
    const d = doc0();
    d.__paint = addRaster(d, { mask: { feather: 12 } }).mask.bitmapId;
    return d;
  }, { strokes: [{ mask: true, size: 60 }] });
  await run('paint-mask-group-adjustment', () => {
    const d = doc0();
    const g = addGroup(d, { blendMode: 'multiply', mask: { feather: 4 } });
    addRaster(d, { parent: g.id, seed: 9 });
    const a = addAdj(d, 'hue-saturation', { hue: 120, saturation: 50 }, { mask: { feather: 0 } });
    d.__g = g.mask.bitmapId;
    d.__a = a.mask.bitmapId;
    return d;
  }, { strokes: (d) => [{ target: d.__g, mask: true, size: 60 }, { target: d.__a, mask: true, size: 60 }] });
  await run('rotated-scaled', () => {
    const d = doc0();
    const l = addRaster(d, { w: 800, h: 600, transform: { x: 200, y: 100, rotation: 25, scaleX: 0.8, scaleY: 1.3, skewX: 10 }, mask: { feather: 3 }, props: { effects: [fx('stroke', { size: 4, color: '#f0f' })] } });
    d.__paint = l.bitmapId;
    return d;
  });
  await run('scaled-up', () => {
    const d = doc0();
    d.__paint = addRaster(d, { w: 500, h: 400, transform: { x: 150, y: 60, scaleX: 1.7, scaleY: 1.7 } }).bitmapId;
    return d;
  });
  await run('offset-fractional', () => {
    const d = doc0();
    d.__paint = addRaster(d, { w: 900, h: 600, transform: { x: 100.4, y: 50.7 } }).bitmapId;
    return d;
  });
  await run('group-multiply', () => {
    const d = doc0();
    D.insertLayerDraft(d, D.makeFillLayer({ fill: { type: 'solid', color: '#88aacc' } }), { parentId: null });
    const g = addGroup(d, { blendMode: 'multiply' });
    addRaster(d, { parent: g.id, seed: 2 });
    d.__paint = addRaster(d, { parent: g.id, seed: 3, props: { blendMode: 'screen' } }).bitmapId;
    addText(d, 80, 600, 'ABOVE TEXT');
    return d;
  });
  await run('group-passthrough-masked', () => {
    const d = doc0();
    addRaster(d, { seed: 11 });
    const g = addGroup(d, { opacity: 0.6, mask: { feather: 20 } });
    d.__paint = addRaster(d, { parent: g.id, seed: 12 }).bitmapId;
    addAdj(d, 'invert', {}, {}, g.id);
    return d;
  });
  await run('group-effects-filters', () => {
    const d = doc0();
    const g = addGroup(d, { blendMode: 'normal', effects: [fx('drop-shadow', { distance: 12, size: 18 }), fx('stroke', { size: 3 })], filters: [D.makeFilterInstance('hue-saturation', { hue: 30 })] });
    const g2 = addGroup(d, { blendMode: 'normal' }, g.id);
    d.__paint = addRaster(d, { parent: g2.id, w: 700, h: 500, transform: { x: 300, y: 150 } }).bitmapId;
    return d;
  });
  await run('smart-filters-local', () => {
    const d = doc0();
    const l = addRaster(d);
    l.filters = [D.makeFilterInstance('hue-saturation', { hue: 50, saturation: 20 }), { ...D.makeFilterInstance('gradient-map', { dither: true }), opacity: 0.7 }];
    d.__paint = l.bitmapId;
    return d;
  });
  await run('smart-filter-blur', () => {
    const d = doc0();
    const l = addRaster(d);
    l.filters = [D.makeFilterInstance('gaussian-blur', { radius: 6 })];
    d.__paint = l.bitmapId;
    return d;
  }, { frames: 8 });
  await run('layers-around', () => {
    const d = doc0();
    D.insertLayerDraft(d, D.makeFillLayer({ fill: { type: 'gradient', gradient: { kind: 'linear', angle: 30, scale: 1, stops: [{ offset: 0, color: '#203040' }, { offset: 1, color: '#c0a080' }] } } }), { parentId: null });
    addRaster(d, { seed: 21 });
    addAdj(d, 'hue-saturation', { hue: 25, saturation: -20 });
    d.__paint = addRaster(d, { seed: 22, props: { blendMode: 'overlay' } }).bitmapId;
    addText(d, 60, 560, 'TITLE');
    addAdj(d, 'vignette', { amount: 0.5 });
    return d;
  });
  /** Canvas Size-like change: new document size, rasters moved (new objects), fills/groups kept. */
  const resizeDoc = (dw, dh, dx, dy) => (d) => {
    const layers = { ...d.layers };
    for (const [id, l] of Object.entries(layers)) if (l.type === 'raster' || l.type === 'text') layers[id] = { ...l, transform: { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy } };
    return { ...d, width: d.width + dw, height: d.height + dh, layers };
  };
  const resizeBuild = () => {
    const d = doc0();
    D.insertLayerDraft(d, D.makeFillLayer({ fill: { type: 'gradient', gradient: { kind: 'radial', angle: 0, scale: 1, stops: [{ offset: 0, color: '#f0e0a0' }, { offset: 1, color: '#402060' }] } } }), { parentId: null });
    const g = addGroup(d, { blendMode: 'normal' });
    D.insertLayerDraft(d, D.makeFillLayer({ fill: { type: 'gradient', gradient: { kind: 'linear', angle: 60, scale: 1, stops: [{ offset: 0, color: 'rgba(255,0,0,0.6)' }, { offset: 1, color: 'rgba(0,0,255,0)' }] } } }), { parentId: g.id });
    d.__paint = addRaster(d, { w: 700, h: 500, transform: { x: 200, y: 120 }, mask: { feather: 6 }, props: { effects: [fx('drop-shadow', { distance: 10, size: 14 })] } }).bitmapId;
    addAdj(d, 'vignette', { amount: 0.5 });
    return d;
  };
  await run('doc-resize', resizeBuild, { mutate: resizeDoc(240, 120, 120, 60), frames: 12 });
  await run('doc-resize-1px', resizeBuild, { mutate: resizeDoc(1, 1, 0, 0), frames: 6 });
  await run('demo', () => {
    const d = DEMO.buildDemoDocument(1920, 1080);
    const ls = Object.values(d.layers);
    d.__glow = ls.find((l) => l.name === 'Red Glow').bitmapId;
    d.__char = ls.find((l) => l.name === 'Roblox Character').bitmapId;
    return d;
  }, { strokes: (d) => [{ target: d.__glow, size: 100 }, { target: d.__char, erase: true }], frames: 20 });
  return { rows: results, cropExact };
}

/**
 * Part 1b (renderer, structural edits): sequences of document edits as the store makes them (a new
 * immutable document per step: clipping toggles, effect size drags, moves, patch edits). After every
 * step the live composite (viewport path), renderDocument at 1× and 0.25× (and the step's
 * `below` render, the Levels/Curves histogram / PSD bake path) are compared with from-scratch renders
 * of a clone. Release review findings: render-paint-diff-1 (clipping onto pass-through groups),
 * -2 (stroke size on semi-transparent content), -4 (below renders after an edit inside a styled
 * group), -5 (inside effects at the canvas edge), e2e-flows-3 (moving layers with smart filters: the
 * filters must not run again, and the result must stay exact).
 */
async function editsPart(opts) {
  const C = await import('/src/render/compositor.ts');
  const { bitmaps, documentUtils: D, filters: FILTERS } = window.__app;
  const settle = () => (C.settleRenderCaches ? C.settleRenderCaches() : false);
  function canvas(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    if (draw) draw(c.getContext('2d'), c);
    return c;
  }
  function premul(c) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      out[i] = (d[i] * a + 127) / 255;
      out[i + 1] = (d[i + 1] * a + 127) / 255;
      out[i + 2] = (d[i + 2] * a + 127) / 255;
      out[i + 3] = a;
    }
    return { d: out, w: c.width, h: c.height };
  }
  function diff(a, b) {
    if (a.w !== b.w || a.h !== b.h) return { max: 999, size: `${a.w}x${a.h} vs ${b.w}x${b.h}` };
    let max = 0,
      over = 0;
    for (let i = 0; i < a.d.length; i++) {
      const d = Math.abs(a.d[i] - b.d[i]);
      if (d > 1) over++;
      if (d > max) max = d;
    }
    return over ? { max, over } : { max };
  }
  const worst = (p, q) => (!p ? q : !q ? p : q.max > p.max ? q : p);
  let cloneSeq = 0;
  /** Copy with new document / layer ids (same bitmaps): renders from scratch. */
  function cloneDoc(doc) {
    const suf = `~edit${++cloneSeq}`;
    const map = (id) => id + suf;
    const layers = {};
    for (const [id, l] of Object.entries(doc.layers)) {
      const c = structuredClone(l);
      c.id = map(id);
      if (Array.isArray(c.childIds)) c.childIds = c.childIds.map(map);
      layers[map(id)] = c;
    }
    return { doc: { ...doc, id: doc.id + suf, layers, rootIds: doc.rootIds.map(map) }, map };
  }
  /** A new document with one layer replaced (what an undoable store edit produces). */
  const edit = (d, id, patch) => ({ ...d, layers: { ...d.layers, [id]: { ...d.layers[id], ...patch } } });
  const moveTo = (d, id, x, y) => edit(d, id, { transform: { ...d.layers[id].transform, x, y } });
  function addRaster(doc, c, o = {}) {
    const l = D.makeRasterLayer({ name: o.name ?? 'L', bitmapId: bitmaps.add(c), width: c.width, height: c.height, transform: o.transform });
    Object.assign(l, o.props ?? {});
    D.insertLayerDraft(doc, l, { parentId: o.parent ?? null });
    return l;
  }
  function addGroup(doc, props = {}, parent = null) {
    const g = D.makeGroupLayer({ name: 'G' });
    Object.assign(g, props);
    D.insertLayerDraft(doc, g, { parentId: parent });
    return g;
  }
  function addAdj(doc, filterId, params, parent = null) {
    const a = D.makeAdjustmentLayer({ filterId, params });
    D.insertLayerDraft(doc, a, { parentId: parent });
    return a;
  }
  let fxSeq = 0;
  const fx = (effectId, params) => ({ id: `x${++fxSeq}`, effectId, enabled: true, params });
  const photo = (w, h) =>
    canvas(w, h, (g) => {
      const lg = g.createLinearGradient(0, 0, w, h);
      lg.addColorStop(0, '#d8a060');
      lg.addColorStop(0.5, '#3070c0');
      lg.addColorStop(1, '#40c070');
      g.fillStyle = lg;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9; i++) {
        g.fillStyle = `hsl(${i * 40},70%,${30 + (i % 3) * 15}%)`;
        g.fillRect((i * 0.11 * w) % w, (i * 0.17 * h) % h, w * 0.18, h * 0.15);
      }
    });
  const blob = (w, h, color, alpha = 1, feather = 1) =>
    canvas(w, h, (g) => {
      const rg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45 * (1 - 0.3 * (feather > 1)), w / 2, h / 2, Math.min(w, h) * 0.45);
      rg.addColorStop(0, color);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = alpha;
      g.fillStyle = rg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffffff';
      g.fillRect(w * 0.3, h * 0.2, w * 0.1, h * 0.5);
    });
  /** Count smart-filter runs (layer filter stacks) on images at least `minPx` big (not thumbnails). */
  const filterRuns = { n: 0, on: false, minPx: 0 };
  const wrapped = [];
  for (const def of FILTERS.list()) {
    const orig = def.apply;
    def.apply = function (img, p, ctx) {
      if (filterRuns.on && img.width * img.height >= filterRuns.minPx && /applyFilterInstanceToCanvas/.test(new Error().stack ?? '')) filterRuns.n++;
      return orig.call(this, img, p, ctx);
    };
    wrapped.push([def, orig]);
  }

  /**
   * Run steps; each step: { label, doc: (d) => d', below?, background?, live?: false, moveNoFilters? }.
   * `moveNoFilters`: the live composite of this step must not run smart filters at full size.
   */
  async function scenario(name, build, steps, so = {}) {
    if (opts.only && !opts.only.includes(name)) return null;
    C.invalidateRenderCache();
    let d = build();
    const t0 = performance.now();
    C.renderDocumentLive(d);
    C.renderDocument(d);
    C.renderDocument(d, { scale: 0.25 });
    const rows = [];
    let reruns = 0;
    for (const st of steps) {
      d = st.doc ? st.doc(d) : d;
      const i0 = C.renderCacheInfo();
      filterRuns.n = 0;
      filterRuns.on = !!st.moveNoFilters;
      filterRuns.minPx = st.moveNoFilters ? 64 * 64 : 0;
      const live = premul(C.renderDocumentLive(d).canvas);
      filterRuns.on = false;
      if (st.moveNoFilters) reruns += filterRuns.n;
      const i1 = C.renderCacheInfo();
      const cl = cloneDoc(d);
      const ref = premul(C.renderDocument(cl.doc));
      const r = { label: st.label, live: diff(live, ref), shared: diff(premul(C.renderDocument(d)), ref), small: diff(premul(C.renderDocument(d, { scale: 0.25 })), premul(C.renderDocument(cl.doc, { scale: 0.25 }))) };
      if (st.below) {
        for (const o of [{ background: true }, { background: false }, { background: true, scale: 0.5 }]) {
          const got = premul(C.renderDocument(d, { ...o, below: st.below(d) }));
          const want = premul(C.renderDocument(cl.doc, { ...o, below: cl.map(st.below(d)) }));
          r.below = worst(r.below, diff(got, want));
        }
      }
      // Approximate live work (GPU crops, or work approximate on every canvas such as a doc-anchored
      // smart filter shifted while dragging) may differ until it is settled.
      r.inexact = (i1.inexactUpdates ?? 0) - (i0.inexactUpdates ?? 0);
      r.approx = (i1.approxUpdates ?? 0) - (i0.approxUpdates ?? 0);
      rows.push(r);
    }
    const settled = settle();
    const live = premul(C.renderDocumentLive(d).canvas);
    C.invalidateRenderCache();
    const full = premul(C.renderDocument(d));
    let extra = null;
    if (so.extra) extra = so.extra(d);
    return { name, rows, settled: { did: settled, live: diff(live, full) }, reruns, extra, ms: Math.round(performance.now() - t0) };
  }

  const W = 1280,
    H = 800;
  const doc0 = (w = W, h = H, bg = '#ffffff') => D.createDocument({ name: 'E', width: w, height: h, background: bg });
  const results = [];
  const run = async (...a) => {
    try {
      const r = await scenario(...a);
      if (r) {
        results.push(r);
        console.log('[edits] ' + JSON.stringify(r));
      }
    } catch (e) {
      results.push({ name: a[0], error: String(e && e.stack ? e.stack : e) });
    }
  };

  // render-paint-diff-1: Create / Release Clipping Mask onto a pass-through group (Multiply child
  // hanging past an opaque sibling, optionally an adjustment inside), eye toggle of the only
  // clipped layer, clipping the group itself; undo / redo = the previous immutable documents.
  for (const withAdj of [false, true]) {
    const ids = {};
    const hist = [];
    const keep = (label, f) => ({ label, doc: (d) => (hist.push(d), f(d)) });
    await run(
      `clip-passthrough${withAdj ? '-adjustment' : ''}`,
      () => {
        const d = doc0();
        addRaster(d, photo(W, H), { name: 'Photo' });
        const g = addGroup(d, { blendMode: 'pass-through' });
        addRaster(d, blob(500, 420, '#3050c0'), { parent: g.id, name: 'Body', transform: { x: 300, y: 200 } });
        addRaster(d, blob(760, 300, '#c03030'), { parent: g.id, name: 'Shade', transform: { x: 200, y: 380 }, props: { blendMode: 'multiply' } });
        if (withAdj) addAdj(d, 'invert', {}, g.id);
        const t = addRaster(d, canvas(260, 180, (k) => ((k.fillStyle = '#f0e020'), k.fillRect(0, 0, 260, 180))), { name: 'Texture', transform: { x: 820, y: 520 } });
        ids.g = g.id;
        ids.t = t.id;
        return d;
      },
      [
        keep('clip texture', (d) => edit(d, ids.t, { clipped: true })),
        keep('hide clipped', (d) => edit(d, ids.t, { visible: false })),
        keep('show clipped', (d) => edit(d, ids.t, { visible: true })),
        keep('release', (d) => edit(d, ids.t, { clipped: false })),
        keep('clip group', (d) => edit(d, ids.g, { clipped: true })),
        { label: 'undo clip group', doc: () => hist[4] },
        { label: 'undo release', doc: () => hist[3] },
        { label: 'undo clip', doc: () => hist[0] },
        { label: 'redo clip', doc: () => hist[1] },
        { label: 'redo all', doc: () => edit(hist[4], ids.g, { clipped: true }) },
      ],
    );
  }

  // render-paint-diff-1 (other entry points): Create / Release Clipping Mask on a layer of a clip
  // stack changes the base of the layers clipped above it — clipping a layer that has a layer
  // clipped to it, releasing the middle layer of a three-layer stack, clipping a hidden base, and
  // clipping a pass-through group that is the base of a shown clipped layer. The clipped layers
  // stay under the incremental thresholds (the plan must see the base change).
  for (const asGroup of [false, true]) {
    const ids = {};
    const hist = [];
    const keep = (label, f) => ({ label, doc: (d) => (hist.push(d), f(d)) });
    const steps = [
      keep('clip shading to body', (d) => edit(d, ids.s, { clipped: true })),
      keep('clip body (shading → photo)', (d) => edit(d, ids.b, { clipped: true })),
      keep('release body (middle of the stack)', (d) => edit(d, ids.b, { clipped: false })),
    ];
    if (!asGroup)
      steps.push(
        keep('hide body', (d) => edit(d, ids.b, { visible: false })),
        keep('clip hidden body', (d) => edit(d, ids.b, { clipped: true })),
        keep('show body', (d) => edit(d, ids.b, { visible: true })),
      );
    const n = steps.length;
    for (let k = n - 1; k >= 0; k--) steps.push({ label: `undo → ${k}`, doc: () => hist[k] });
    for (let k = 1; k < n; k++) steps.push({ label: `redo → ${k}`, doc: () => hist[k] });
    await run(`clip-base-change${asGroup ? '-group' : ''}`, () => {
      const d = doc0();
      addRaster(d, photo(W, H), { name: 'Photo' });
      if (asGroup) {
        const g = addGroup(d, { blendMode: 'pass-through' });
        addRaster(d, blob(360, 300, '#e0c0a0'), { parent: g.id, name: 'Body', transform: { x: 420, y: 260 } });
        addRaster(d, blob(200, 300, '#ff3030'), { parent: g.id, name: 'Shade', transform: { x: 500, y: 300 }, props: { blendMode: 'multiply' } });
        ids.b = g.id;
      } else ids.b = addRaster(d, blob(360, 300, '#e0c0a0'), { name: 'Body', transform: { x: 420, y: 260 } }).id;
      ids.s = addRaster(d, canvas(900, 560, (k) => ((k.fillStyle = '#c02020'), k.fillRect(0, 0, 900, 560))), { name: 'Shading', transform: { x: 160, y: 100 } }).id;
      return d;
    }, steps);
  }

  // render-paint-diff-2: inside / center Stroke size edits and drags on semi-transparent content.
  for (const position of ['inside', 'center']) {
    const ids = {};
    const stroke = (size) => [fx('stroke', { size, position, color: '#10e040' })];
    const steps = [{ label: 'size 14 → 2', doc: (d) => edit(d, ids.l, { effects: stroke(2) }) }];
    for (let s = 3; s <= 14; s++) steps.push({ label: `drag ${s}`, doc: (d) => edit(d, ids.l, { effects: stroke(s) }) });
    for (let s = 12; s >= 1; s -= 2) steps.push({ label: `drag ${s}`, doc: (d) => edit(d, ids.l, { effects: stroke(s) }) });
    await run(`stroke-size-soft-${position}`, () => {
      const d = doc0();
      addRaster(d, photo(W, H), { name: 'Photo' });
      const c = canvas(900, 600, (g) => {
        g.fillStyle = 'rgba(220,30,30,0.7)';
        g.fillRect(60, 60, 380, 420);
        g.fillStyle = 'rgba(40,60,220,0.85)';
        g.beginPath();
        g.arc(640, 300, 190, 0, 7);
        g.fill();
        g.filter = 'blur(8px)';
        g.fillStyle = 'rgba(250,200,40,0.9)';
        g.fillRect(200, 470, 500, 90);
      });
      ids.l = addRaster(d, c, { name: 'Soft', transform: { x: 180, y: 100 }, props: { effects: stroke(14) } }).id;
      return d;
    }, steps);
  }

  // render-paint-diff-4: the below-render of an adjustment inside a styled group, after a patch edit
  // (brush / fill) on a layer of that group.
  for (const [label, props] of [
    ['effect', { blendMode: 'pass-through', effects: [fx('drop-shadow', { distance: 14, size: 12 })] }],
    ['normal', { blendMode: 'normal' }],
    ['normal-80', { blendMode: 'normal', opacity: 0.8 }],
  ]) {
    const ids = {};
    const patch = (x, y, color) => (d) => {
      const c = bitmaps.get(d.layers[ids.p].bitmapId);
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(x, y, 70, 60);
      bitmaps.touch(d.layers[ids.p].bitmapId, { x, y, width: 70, height: 60 });
      return d;
    };
    await run(`below-styled-group-${label}`, () => {
      const d = doc0();
      addRaster(d, photo(W, H), { name: 'BG' });
      const g = addGroup(d, props);
      ids.p = addRaster(d, photo(700, 500), { parent: g.id, name: 'Photo', transform: { x: 260, y: 150 } }).id;
      ids.lv = addAdj(d, 'levels', { inBlack: 20, gamma: 1.3 }, g.id).id;
      return d;
    }, [
      { label: 'initial', below: () => ids.lv },
      { label: 'patch', doc: patch(40, 50, '#101010'), below: () => ids.lv },
      { label: 'patch 2', doc: patch(400, 300, '#f0f0f0'), below: () => ids.lv },
    ]);
  }

  // render-paint-diff-5: inside stroke / inner bevel / satin on a layer hanging off the canvas must
  // render like the same layer on a larger canvas, cropped (no fake edge along the border); moving it
  // across the edge (translation reuse) stays exact.
  for (const [label, effects] of [
    ['inside-stroke', [fx('stroke', { size: 8, position: 'inside', color: '#10e040' })]],
    ['inner-bevel', [fx('bevel', { size: 14 })]],
    ['satin', [fx('satin', { size: 16 })]],
  ]) {
    let cardId = null;
    /** Background independent of the canvas size (so a larger canvas, cropped, is the reference). */
    const make = (w, h, x, y) => {
      const d = doc0(w, h);
      addRaster(d, canvas(w, h, (g) => {
        g.fillStyle = '#707070';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#a0a0a0';
        for (let i = 0; i < w; i += 64) g.fillRect(i, 0, 24, h);
      }), { name: 'BG' });
      const id = addRaster(d, canvas(420, 320, (g) => ((g.fillStyle = '#3060c0'), g.fillRect(0, 0, 420, 320), (g.fillStyle = 'rgba(240,120,40,0.6)'), g.fillRect(60, 40, 300, 240))), { name: 'Card', transform: { x, y }, props: { effects } }).id;
      return { d, id };
    };
    const steps = [560, 600, 640, 700].map((y) => ({ label: `move to y=${y}`, doc: (d) => moveTo(d, cardId, 400, y) }));
    steps.push({ label: 'off the right', doc: (d) => moveTo(d, cardId, 1000, 700) });
    await run(
      `inside-fx-edge-${label}`,
      () => {
        const m = make(W, H, 400, 120);
        cardId = m.id;
        return m.d;
      },
      steps,
      {
        extra: (d) => {
          const t = d.layers[cardId].transform;
          const big = C.renderDocument(make(W + 400, H + 400, t.x, t.y).d);
          const want = canvas(W, H, (g) => g.drawImage(big, 0, 0));
          return diff(premul(C.renderDocument(d)), premul(want));
        },
      },
    );
  }

  // e2e-flows-3: moving a layer with smart filters (template characters: gradient-map + halftone,
  // cel-shade, a glow). Whole-pixel moves reuse the filtered render; exact renders stay exact; a
  // doc-anchored filter (halftone) is only shifted in the live composite and settled afterwards.
  for (const [label, list] of [
    ['local', [['hue-saturation', { hue: 30, saturation: 20 }], ['gradient-map', { dither: true }]]],
    ['cel-shade', [['cel-shade', {}]]],
    ['halftone', [['gradient-map', {}], ['halftone', {}]]],
  ]) {
    const ids = {};
    const steps = [];
    let x = 300,
      y = 120;
    for (let i = 0; i < 6; i++) {
      x += 13;
      y += 3;
      const [mx, my] = [x, y];
      steps.push({ label: `drag ${mx},${my}`, doc: (d) => moveTo(d, ids.l, mx, my), moveNoFilters: true });
    }
    // across the bottom / left edge and back
    for (const [mx, my] of [
      [380, 420],
      [380, 520],
      [-90, 520],
      [420, 160],
    ])
      steps.push({ label: `move ${mx},${my}`, doc: (d) => moveTo(d, ids.l, mx, my) });
    await run(`move-smart-filters-${label}`, () => {
      const d = doc0();
      addRaster(d, photo(W, H), { name: 'BG' });
      const l = addRaster(d, blob(460, 560, '#e0a070'), { name: 'Character', transform: { x, y }, props: { effects: [fx('outer-glow', { size: 18, opacity: 0.7 })] } });
      l.filters = list.map(([id, p]) => D.makeFilterInstance(id, p));
      ids.l = l.id;
      return d;
    }, steps);
  }

  for (const [def, orig] of wrapped) def.apply = orig;
  return results;
}

/** End-to-end through the real paint tools and the viewport (demo document). */
async function e2ePart(opts) {
  const app = window.__app;
  const { useEditor, bitmaps } = app;
  const C = await import('/src/render/compositor.ts');
  const { viewport: VP } = await import('/src/editor/viewport.ts');
  const raf = window.requestAnimationFrame.bind(window);
  const frame = () => new Promise((r) => raf(() => r()));
  const frames = async (n) => {
    for (let i = 0; i < n; i++) await frame();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => useEditor.getState();
  let docId = st().activeDocId;
  if (!docId) docId = app.openDemoDocument();
  await sleep(500);
  const doc = () => st().sessions[docId].doc;
  const glow = Object.values(doc().layers).find((l) => l.name === 'Red Glow');
  const char = Object.values(doc().layers).find((l) => l.name === 'Roblox Character');
  st().setTool('brush');
  st().setToolOption('brush', 'size', 140);
  st().setToolOption('brush', 'hardness', 0.5);
  st().setToolOption('brush', 'smoothing', 0);
  const ov = document.querySelector('.viewport-overlay');
  const dc = document.querySelector('.viewport-doc');
  // Read the document canvas through a CPU copy: getImageData on the canvas itself would make
  // Chrome move it off the GPU, and later draws (drop shadow, minification) would then differ.
  const grab = document.createElement('canvas');
  const screen = () => {
    grab.width = dc.width;
    grab.height = dc.height;
    const g = grab.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, grab.width, grab.height);
    g.drawImage(dc, 0, 0);
    return g.getImageData(0, 0, grab.width, grab.height).data;
  };
  function cmp(a, b) {
    if (a.length !== b.length) return { max: 999 };
    let max = 0,
      n = 0;
    for (let i = 0; i < a.length; i += 4) {
      // Premultiplied comparison (the document canvas is opaque inside the document).
      const aa = a[i + 3],
        ba = b[i + 3];
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(Math.round((a[i + c] * aa) / 255) - Math.round((b[i + c] * ba) / 255));
        if (d > max) max = d;
        if (d > 1) n++;
      }
      const d = Math.abs(aa - ba);
      if (d > max) max = d;
      if (d > 1) n++;
    }
    return n ? { max, n } : { max };
  }
  function toClient(x, y) {
    const box = ov.getBoundingClientRect();
    const v = st().sessions[docId].view;
    const d = doc();
    const z = v.zoom;
    return { clientX: box.left + box.width / 2 + v.panX - (d.width * z) / 2 + x * z, clientY: box.top + box.height / 2 + v.panY - (d.height * z) / 2 + y * z };
  }
  const fire = (type, x, y, buttons) => ov.dispatchEvent(new PointerEvent(type, { ...toClient(x, y), button: 0, buttons, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
  async function stroke(points) {
    fire('pointerdown', points[0][0], points[0][1], 1);
    await frame();
    for (const [x, y] of points.slice(1)) {
      fire('pointermove', x, y, 1);
      await frame();
    }
    fire('pointerup', points[points.length - 1][0], points[points.length - 1][1], 0);
    await frames(4);
  }
  const path = (x0, y0, x1, y1, n, wobble = 40) =>
    Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + Math.sin(t * 9) * wobble];
    });
  /** Screen right after the stroke and after the settle delay vs a forced full re-render. */
  let cloneN = 0;
  const cloneDoc = (d) => {
    const suf = `~e2e${++cloneN}`;
    const map = (id) => id + suf;
    const layers = {};
    for (const [id, l] of Object.entries(d.layers)) {
      const c = structuredClone(l);
      c.id = map(id);
      if (Array.isArray(c.childIds)) c.childIds = c.childIds.map(map);
      layers[map(id)] = c;
    }
    return { ...d, id: d.id + suf, layers, rootIds: d.rootIds.map(map) };
  };
  const pixels = (c) => {
    grab.width = c.width;
    grab.height = c.height;
    const g2 = grab.getContext('2d', { willReadFrequently: true });
    g2.clearRect(0, 0, c.width, c.height);
    g2.drawImage(c, 0, 0);
    return g2.getImageData(0, 0, c.width, c.height).data;
  };
  /**
   * Durable outputs right after a stroke (no settle yet): renderDocument (exports, merges…) and
   * the active layer's / document thumbnails must equal from-scratch renders on every backend.
   */
  function durable() {
    const d = doc();
    const id = st().sessions[docId].activeLayerId;
    const out = [cmp(pixels(C.renderDocument(d)), pixels(C.renderDocument(cloneDoc(d))))];
    if (C.renderThumbnail) {
      out.push(cmp(pixels(C.renderThumbnail(d, null, 160)), pixels(C.renderThumbnail(cloneDoc(d), null, 160))));
      if (id && d.layers[id]) {
        const cd = cloneDoc(d);
        out.push(cmp(pixels(C.renderThumbnail(d, id, 96)), pixels(C.renderThumbnail(cd, `${id}~e2e${cloneN}`, 96))));
      }
    }
    return out.reduce((a, b) => (b.max > a.max ? b : a));
  }
  async function check(label, afterSettle) {
    await frames(3);
    const now = screen();
    const dur = durable();
    await sleep(900); // settle delay (approximate GPU work is re-rendered exactly)
    await frames(3);
    const settled = screen();
    // Extra comparisons on the settled state (before the caches are dropped below).
    const extra = afterSettle ? afterSettle() : [];
    C.invalidateRenderCache();
    VP.requestRender();
    await frames(4);
    const full = screen();
    return { label, now: cmp(now, full), durable: dur, settled: [cmp(settled, full), ...extra].reduce((a, b) => (b.max > a.max ? b : a)) };
  }
  const results = [];
  const views = [
    ['fit', () => st().setView({ zoom: 0, panX: 0, panY: 0 })],
    ['zoom1', () => st().setView({ zoom: 1, panX: -200, panY: 0 })],
    ['zoom2.5', () => st().setView({ zoom: 2.5, panX: -900, panY: 300 })],
    ['zoom0.37', () => st().setView({ zoom: 0.37, panX: 0, panY: 0 })],
  ];
  for (const [name, set] of views) {
    set();
    await frames(4);
    st().setTool('brush');
    st().setActiveLayer(glow.id);
    st().setEditTarget('content');
    st().setPrimaryColor('#22cc44');
    await stroke(path(700, 300, 1300, 500, 30));
    results.push(await check(`${name}: brush on Red Glow`));
    st().setActiveLayer(char.id);
    st().setPrimaryColor('#ffcc00');
    await stroke(path(1100, 500, 1500, 700, 25));
    results.push(await check(`${name}: brush on character (fx, in group)`));
    st().undo();
    results.push(await check(`${name}: undo`));
    st().redo();
    results.push(await check(`${name}: redo`));
  }
  st().setView({ zoom: 0, panX: 0, panY: 0 });
  await frames(3);
  const mc = document.createElement('canvas');
  mc.width = doc().width;
  mc.height = doc().height;
  const g = mc.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, mc.width, mc.height);
  const maskId = bitmaps.add(mc);
  st().commit('Add mask', (d) => {
    d.layers[glow.id].mask = { bitmapId: maskId, enabled: true, density: 1, feather: 6, inverted: false };
  });
  st().setActiveLayer(glow.id);
  st().setEditTarget('mask');
  st().setPrimaryColor('#000000');
  await frames(3);
  await stroke(path(900, 350, 1400, 450, 25));
  results.push(await check('fit: brush on mask (feather 6)'));
  st().setEditTarget('content');
  st().setTool('eraser');
  st().setToolOption('eraser', 'size', 90);
  await stroke(path(600, 600, 1200, 400, 25));
  results.push(await check('fit: eraser on Red Glow'));

  // Canvas Size keeps fill layers and groups as they are (only the document size changes): their
  // renders for the old size must not be reused — by the viewport nor by renderDocument (export).
  const IO = await import('/src/io/imageOps.ts');
  /** Viewport check plus renderDocument (full and 1/4 scale) vs a from-scratch render of a clone. */
  const checkDoc = (label) =>
    check(label, () => {
      const d = doc();
      return [cmp(pixels(C.renderDocument(d)), pixels(C.renderDocument(cloneDoc(d)))), cmp(pixels(C.renderDocument(d, { scale: 0.25 })), pixels(C.renderDocument(cloneDoc(d), { scale: 0.25 })))];
    });
  st().setTool('brush');
  st().setPrimaryColor('#3355ff');
  C.renderDocument(doc(), { scale: 0.25 });
  IO.canvasSize(doc().width + 480, doc().height + 320, 4, '#ffffff');
  st().setView({ zoom: 0, panX: 0, panY: 0 });
  results.push(await checkDoc('canvas size +480x320 (centered)'));
  st().undo();
  results.push(await checkDoc('canvas size: undo'));
  st().redo();
  results.push(await checkDoc('canvas size: redo'));
  st().setActiveLayer(glow.id);
  await stroke(path(500, 400, 1500, 900, 25));
  results.push(await checkDoc('canvas size: brush after resize'));
  st().undo();
  st().undo();
  IO.canvasSize(doc().width - 1, doc().height - 1, 0, null);
  results.push(await checkDoc('canvas size -1px (top-left)'));
  st().undo();
  results.push(await checkDoc('canvas size -1px: undo'));

  // Move tool drags of a layer with smart filters (release review e2e-flows-3): while dragging, the
  // filtered render is shifted instead of re-running the filters (a doc-anchored filter such as a
  // halftone grid only on screen: approximate until the settle). The screen after the settle and
  // renderDocument / thumbnails right after the drag must equal from-scratch renders.
  const D = app.documentUtils;
  st().setView({ zoom: 0, panX: 0, panY: 0 });
  st().setActiveLayer(char.id);
  st().setEditTarget('content');
  for (const [label, list] of [
    ['gradient-map + cel-shade', [['gradient-map', { dither: true }], ['cel-shade', {}]]],
    ['+ halftone (doc-anchored)', [['gradient-map', { dither: true }], ['cel-shade', {}], ['halftone', {}]]],
  ]) {
    st().commit('Smart filters', (d) => {
      d.layers[char.id].filters = list.map(([id, p]) => D.makeFilterInstance(id, p));
    });
    st().setTool('move');
    await frames(6);
    await sleep(500);
    const b = C.getLayerBounds(doc(), char.id);
    let x = b.x + b.width / 2,
      y = b.y + b.height / 2;
    const i0 = C.renderCacheInfo();
    const tx0 = doc().layers[char.id].transform.x;
    let runs = 0;
    const wrapped = [];
    for (const def of app.filters.list()) {
      const orig = def.apply;
      def.apply = function (img, p, ctx) {
        // smart filters (layer filter stacks), not adjustment layers re-applied over the dirty area
        if (img.width * img.height >= 64 * 64 && /applyFilterInstanceToCanvas/.test(new Error().stack ?? '')) runs++;
        return orig.call(this, img, p, ctx);
      };
      wrapped.push([def, orig]);
    }
    let dragRuns = 0;
    try {
      fire('pointerdown', x, y, 1);
      await frame();
      for (let i = 0; i < 14; i++) {
        x += i < 7 ? 6 : -4;
        y += 3;
        fire('pointermove', x, y, 1);
        await frame();
      }
      dragRuns = runs;
      fire('pointerup', x, y, 0);
      await frames(2);
    } finally {
      for (const [def, orig] of wrapped) def.apply = orig;
    }
    const i1 = C.renderCacheInfo();
    const r = await check(`move tool drag: ${label}`);
    // Approximate on every canvas (shifted doc-anchored filters, a crop cut by the canvas edge): the
    // screen right after the drag may differ until the settle.
    r.approxOk = (i1.inexactUpdates ?? 0) > (i0.inexactUpdates ?? 0);
    r.dragRuns = dragRuns;
    // the drag really moved the layer
    if (doc().layers[char.id].transform.x === tx0) r.dragRuns = r.dragRuns || -1;
    results.push(r);
  }
  return results;
}

/** Brush frame-time benchmark through the real paint tools and viewport (see --bench). */
async function benchPart(opts) {
  const app = window.__app;
  const { useEditor, bitmaps, documentUtils: D } = app;
  const st = () => useEditor.getState();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const origRaf = window.requestAnimationFrame.bind(window);
  const nextFrame = () => new Promise((r) => origRaf(() => r()));
  let C = null;
  try {
    C = await import('/src/render/compositor.ts');
  } catch {
    C = null;
  }
  let CACHE = null;
  try {
    CACHE = await import('/src/render/cache.ts');
  } catch {
    CACHE = null;
  }
  const info = () => (C && C.renderCacheInfo ? C.renderCacheInfo() : {});
  const longTasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push({ t: e.startTime, d: e.duration });
    }).observe({ type: 'longtask', buffered: false });
  } catch {
    /* no longtask support */
  }
  const stats = (a) => {
    const s = [...a].sort((p, q) => p - q);
    const mean = s.reduce((p, q) => p + q, 0) / Math.max(1, s.length);
    const at = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))] ?? 0;
    return { mean: +mean.toFixed(1), p50: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), max: +(s[s.length - 1] ?? 0).toFixed(1) };
  };

  function open1080() {
    const doc = D.createDocument({ name: 'Bench 1080p', width: 1920, height: 1080, background: '#ffffff' });
    const c = document.createElement('canvas');
    c.width = 1920;
    c.height = 1080;
    const g = c.getContext('2d');
    g.fillStyle = '#3366aa';
    g.fillRect(200, 150, 1500, 800);
    const l = D.makeRasterLayer({ name: 'Paint', bitmapId: bitmaps.add(c), width: 1920, height: 1080 });
    D.insertLayerDraft(doc, l, { parentId: null });
    return st().openDocument(doc, { label: 'Bench' });
  }
  /**
   * Render-cache working set larger than the slot budget (release review render-paint-diff-3): N
   * document-sized layers (Layer ▸ New ▸ Layer, a painted blob, Drop Shadow + Stroke — ≈ 6M px of
   * renders each at 1080p, ≈ 4× at 4K) under an empty paint layer. Past the old fixed 64M px budget
   * every brush frame re-rendered every layer (≈ 1.1 s per frame at 1080p with 8 such layers).
   */
  function openFx(w, h, n) {
    const doc = D.createDocument({ name: `Bench ${w}×${h} ×${n} fx`, width: w, height: h, background: '#ffffff' });
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${i * 40},70%,50%)`;
      g.beginPath();
      g.ellipse(w * (n > 1 ? 0.1 + (0.8 * i) / (n - 1) : 0.5), h * (0.35 + 0.3 * (i % 2)), w * 0.06, h * 0.18, 0, 0, 7);
      g.fill();
      const l = D.makeRasterLayer({ name: `FX ${i + 1}`, bitmapId: bitmaps.add(c), width: w, height: h });
      l.effects = [
        { id: `ds${i}`, effectId: 'drop-shadow', enabled: true, params: { distance: 12, size: 10 } },
        { id: `st${i}`, effectId: 'stroke', enabled: true, params: { size: 5, position: 'outside', color: '#ffffff' } },
      ];
      D.insertLayerDraft(doc, l, { parentId: null });
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const l = D.makeRasterLayer({ name: 'Paint', bitmapId: bitmaps.add(c), width: w, height: h });
    D.insertLayerDraft(doc, l, { parentId: null });
    return st().openDocument(doc, { label: 'Bench' });
  }
  /**
   * Past the render cache's hard cap: N document-sized layers whose content covers most of the
   * canvas (renders cannot be cropped to a small part of it) with Drop Shadow + Stroke — ≈ 25M px
   * of renders each at 4K — under an empty paint layer. The layer renders alone exceed the cap:
   * the brush frame must degrade gracefully (the layers below are composited into the below cache
   * once, at the start of the stroke, and never re-rendered again during it).
   */
  function openLarge(w, h, n) {
    const doc = D.createDocument({ name: `Bench ${w}×${h} ×${n} large fx`, width: w, height: h, background: '#ffffff' });
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${i * 33},60%,${40 + (i % 3) * 10}%)`;
      g.beginPath();
      g.ellipse(w * 0.5 + (i - n / 2) * 8, h * 0.5, w * 0.46, h * 0.44, 0, 0, 7);
      g.fill();
      const l = D.makeRasterLayer({ name: `Large ${i + 1}`, bitmapId: bitmaps.add(c), width: w, height: h });
      l.opacity = 0.9;
      l.effects = [
        { id: `ds${i}`, effectId: 'drop-shadow', enabled: true, params: { distance: 12, size: 10 } },
        { id: `st${i}`, effectId: 'stroke', enabled: true, params: { size: 5, position: 'outside', color: '#ffffff' } },
      ];
      D.insertLayerDraft(doc, l, { parentId: null });
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const l = D.makeRasterLayer({ name: 'Paint', bitmapId: bitmaps.add(c), width: w, height: h });
    D.insertLayerDraft(doc, l, { parentId: null });
    return st().openDocument(doc, { label: 'Bench' });
  }
  let demoId = null;
  // `guard`: perf regression limits (the run fails past them): mean ms per pointermove on the
  // software / GPU canvas (frames 6+), and layers re-rendered from scratch during the stroke (the
  // painted layer is updated in place; nothing else may re-render — past the hard cap each layer
  // below may be re-rendered once, at the start of the stroke). `mem`: navigator.deviceMemory
  // the render cache's hard cap is set for during the case (GB; see hardCapFor).
  const cases = [
    { name: 'demo: Red Glow (raster under adjustments)', open: () => demoId ?? (demoId = app.openDemoDocument()), layer: 'Red Glow' },
    { name: 'demo: Roblox Character (effects, in group)', open: () => demoId ?? (demoId = app.openDemoDocument()), layer: 'Roblox Character' },
    { name: '1080p: one raster layer', open: open1080, layer: 'Paint' },
    { name: '1080p: 8 full-canvas layers with Drop Shadow + Stroke', open: () => openFx(1920, 1080, 8), layer: 'Paint', guard: { sw: 30, gpu: 120, renders: 0 } },
    { name: '4K: 2 full-canvas layers with Drop Shadow + Stroke', open: () => openFx(3840, 2160, 2), layer: 'Paint', guard: { sw: 30, gpu: 120, renders: 0 } },
    // ≈ 100M px of renders before renders were cropped to their content (the working set must stay cached).
    { name: '1080p: 16 full-canvas layers with Drop Shadow + Stroke', open: () => openFx(1920, 1080, 16), layer: 'Paint', guard: { sw: 30, gpu: 120, renders: 0 } },
    // Past the old hard caps (≈ 200M px, ≈ 125M px with 4 GB) before renders were cropped to their content.
    { name: '4K: 8 full-canvas layers with Drop Shadow + Stroke', open: () => openFx(3840, 2160, 8), layer: 'Paint', guard: { sw: 30, gpu: 120, renders: 0 } },
    { name: '4K: 5 full-canvas layers with Drop Shadow + Stroke, 4 GB of memory', open: () => openFx(3840, 2160, 5), layer: 'Paint', mem: 4, guard: { sw: 30, gpu: 120, renders: 0 } },
    // Layer renders alone past the hard cap (≈ 250M px; ≈ 150M px with 4 GB): graceful degradation.
    { name: '4K: 10 large-content layers with Drop Shadow + Stroke (past the hard cap)', open: () => openLarge(3840, 2160, 10), layer: 'Paint', guard: { sw: 30, gpu: 120, renders: 10 } },
    { name: '4K: 6 large-content layers with Drop Shadow + Stroke, 4 GB of memory (past the hard cap)', open: () => openLarge(3840, 2160, 6), layer: 'Paint', mem: 4, guard: { sw: 30, gpu: 120, renders: 6 } },
  ];
  const results = [];
  /** --bench-only a,b: only the cases whose name contains one of these strings. */
  const wanted = (name) => !opts.benchOnly || opts.benchOnly.some((w) => name.includes(w));
  const hardCap0 = CACHE?.slots?.hardCap;
  for (const cs of cases) {
    if (!wanted(cs.name)) continue;
    // A smaller device's hard cap (no-op against trees without one).
    if (cs.mem && CACHE?.hardCapFor && hardCap0 !== undefined) CACHE.slots.hardCap = CACHE.hardCapFor(CACHE.slots.budget, cs.mem);
    const docId = cs.open();
    if (st().activeDocId !== docId) st().setActiveDoc(docId);
    await sleep(800);
    const doc = st().sessions[docId].doc;
    const layer = Object.values(doc.layers).find((l) => l.name === cs.layer);
    st().setActiveLayer(layer.id);
    st().setEditTarget?.('content');
    st().setTool('brush');
    st().setToolOption('brush', 'size', 200);
    st().setToolOption('brush', 'hardness', 0.8);
    st().setToolOption('brush', 'smoothing', 0);
    st().setPrimaryColor('#22cc44');
    st().setView({ zoom: 0, panX: 0, panY: 0 });
    for (let i = 0; i < 6; i++) await nextFrame();
    await sleep(1500); // idle: the backend probe runs, caches settle
    const ov = document.querySelector('.viewport-overlay');
    const v = st().sessions[docId].view;
    const box = ov.getBoundingClientRect();
    const z = v.zoom;
    const toClient = (x, y) => ({ clientX: box.left + box.width / 2 + v.panX - (doc.width * z) / 2 + x * z, clientY: box.top + box.height / 2 + v.panY - (doc.height * z) / 2 + y * z });
    const fire = (type, x, y, buttons) => ov.dispatchEvent(new PointerEvent(type, { ...toClient(x, y), button: 0, buttons, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
    // Zig-zag over the layer's content.
    let b = { x: 300, y: 250, width: 1300, height: 600 };
    if (C && C.getLayerBounds) {
      const lb = C.getLayerBounds(doc, layer.id);
      if (lb && lb.width < doc.width * 0.9) b = { x: lb.x + lb.width * 0.2, y: lb.y + lb.height * 0.15, width: lb.width * 0.6, height: lb.height * 0.7 };
    }
    let work = 0;
    const cbs = [];
    window.requestAnimationFrame = (cb) =>
      origRaf((t) => {
        const s0 = performance.now();
        try {
          cb(t);
        } finally {
          const d = performance.now() - s0;
          work += d;
          cbs.push({ t: s0, d });
        }
      });
    // The settle (approximate GPU work re-rendered exactly) and the frame that redraws it.
    let tSettle = -1;
    let settleCall = 0;
    const unSettle = C && C.onRenderSettle ? C.onRenderSettle(() => (tSettle = performance.now())) : null;
    const i0 = info();
    // Layer renders stored during the stroke for layers OTHER than the painted one: they never
    // change, so any is a re-render after an eviction (cache thrash).
    let others = 0;
    const otherKeys = new Set();
    const names = Object.fromEntries(Object.values(doc.layers).map((l) => [l.id, l.name]));
    const slotSet = CACHE?.slots?.set;
    if (slotSet)
      CACHE.slots.set = function (key, ...rest) {
        if (typeof key === 'string' && key.startsWith('L|') && !key.startsWith(`L|${layer.id}|`)) {
          others++;
          const [, id, scale, flags] = key.split('|');
          otherKeys.add(`${names[id] ?? id}@${scale}/${flags}`);
        }
        return slotSet.call(this, key, ...rest);
      };
    const per = [];
    let x = b.x,
      y = b.y,
      dir = 1;
    try {
      fire('pointerdown', x, y, 1);
      await nextFrame();
      await nextFrame();
      for (let i = 0; i < opts.benchFrames; i++) {
        x += 18 * dir;
        if (x > b.x + b.width || x < b.x) {
          dir = -dir;
          y = y + 50 > b.y + b.height ? b.y : y + 50;
        }
        work = 0;
        const t0 = performance.now();
        fire('pointermove', x, y, 1);
        const handler = performance.now() - t0;
        await nextFrame();
        per.push(handler + work);
      }
      const othersStroke = slotSet ? others : null;
      const othersWhich = [...otherKeys].slice(0, 6);
      longTasks.length = 0;
      const tUp = performance.now();
      fire('pointerup', x, y, 0);
      for (let i = 0; i < 3; i++) await nextFrame();
      await sleep(1500);
      if (tSettle >= 0) settleCall = cbs.filter((c) => c.t >= tSettle && c.t < tSettle + 500).reduce((m, c) => Math.max(m, c.d), 0);
      const after = longTasks.filter((e) => e.t >= tUp);
      const i1 = info();
      results.push({
        name: cs.name,
        guard: cs.guard ?? null,
        layerRenders: othersStroke,
        otherKeys: othersWhich,
        slotMpx: i1.slotPixels !== undefined ? +(i1.slotPixels / 1e6).toFixed(1) : null,
        frames: per.length,
        work: stats(per.slice(5)),
        afterTask: after.length ? +Math.max(...after.map((e) => e.d)).toFixed(0) : 0,
        settleFrame: tSettle >= 0 ? +settleCall.toFixed(0) : null,
        settles: (i1.settles ?? 0) - (i0.settles ?? 0),
        regionUpdates: (i1.regionUpdates ?? 0) - (i0.regionUpdates ?? 0),
        cropExact: i1.cropExact,
      });
    } finally {
      window.requestAnimationFrame = origRaf;
      unSettle?.();
      if (slotSet) CACHE.slots.set = slotSet;
    }
    st().undo();
    await sleep(300);
    // Bench documents of their own are closed again (their renders leave the cache).
    if (docId !== demoId && st().closeDocument) st().closeDocument(docId);
    await sleep(300);
    if (hardCap0 !== undefined) CACHE.slots.hardCap = hardCap0;
    // Their renders go now (the next case starts from a cache holding nothing of them).
    C?.invalidateRenderCache?.();
  }

  // Move-tool drags of template characters with smart filters (release review e2e-flows-3): every
  // pointermove used to re-run the character's smart filters (and its glow) at full resolution.
  // `renders` here = smart-filter runs at full size during the drag (moved renders must be reused;
  // a doc-anchored filter such as the halftone grid is shifted on screen and settled afterwards).
  // No time limit on GPU canvases: there (SwiftShader) a move is dominated by synchronous readbacks
  // for the templates' adjustment layers re-applied over the changed area, and very noisy.
  const TPL = await import('/src/templates/open.ts').catch(() => null);
  const moveCases = TPL?.openTemplate
    ? [
        { name: 'move drag: Crimson template character (gradient-map + halftone, glow)', tpl: 'tpl-crimson-thumbnail', guard: { sw: 130, gpu: null, renders: 0 } },
        { name: 'move drag: Gothic template character (cel-shade)', tpl: 'tpl-gothic-paper', guard: { sw: 50, gpu: null, renders: 0 } },
      ]
    : [];
  for (const cs of moveCases) {
    if (!wanted(cs.name)) continue;
    const docId = await TPL.openTemplate(cs.tpl);
    if (!docId) continue;
    if (st().activeDocId !== docId) st().setActiveDoc(docId);
    // The viewport is loaded lazily (a first document on a cold dev server takes a while).
    for (let i = 0; i < 150 && !document.querySelector('.viewport-overlay'); i++) await sleep(200);
    st().setView({ zoom: 0, panX: 0, panY: 0 });
    st().setTool('move');
    for (let i = 0; i < 6; i++) await nextFrame();
    await sleep(2500); // fonts, idle work, the backend probe
    await document.fonts?.ready;
    const doc = st().sessions[docId].doc;
    const layerId = st().sessions[docId].activeLayerId;
    st().setActiveLayer(layerId);
    for (let i = 0; i < 3; i++) await nextFrame();
    const tx0 = doc.layers[layerId].transform.x;
    const lb = C.getLayerBounds(doc, layerId);
    const ov = document.querySelector('.viewport-overlay');
    const v = st().sessions[docId].view;
    const box = ov.getBoundingClientRect();
    const z = v.zoom;
    const toClient = (x, y) => ({ clientX: box.left + box.width / 2 + v.panX - (doc.width * z) / 2 + x * z, clientY: box.top + box.height / 2 + v.panY - (doc.height * z) / 2 + y * z });
    const fire = (type, x, y, buttons) => ov.dispatchEvent(new PointerEvent(type, { ...toClient(x, y), button: 0, buttons, pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true }));
    let runs = 0;
    const wrapped = [];
    for (const def of app.filters.list()) {
      const orig = def.apply;
      def.apply = function (img, p, ctx) {
        if (img.width * img.height >= 64 * 64 && /applyFilterInstanceToCanvas/.test(new Error().stack ?? '')) runs++;
        return orig.call(this, img, p, ctx);
      };
      wrapped.push([def, orig]);
    }
    let work = 0;
    window.requestAnimationFrame = (cb) =>
      origRaf((t) => {
        const s0 = performance.now();
        try {
          cb(t);
        } finally {
          work += performance.now() - s0;
        }
      });
    const per = [];
    let x = lb.x + lb.width / 2,
      y = lb.y + lb.height / 2;
    let dragRuns = 0;
    try {
      fire('pointerdown', x, y, 1);
      await nextFrame();
      await nextFrame();
      runs = 0;
      const n = Math.max(12, Math.min(60, Math.round(opts.benchFrames / 2)));
      for (let i = 0; i < n; i++) {
        x += (Math.floor(i / 10) % 2 ? -1 : 1) * 6;
        y += i % 2 ? 2 : -2;
        work = 0;
        const t0 = performance.now();
        fire('pointermove', x, y, 1);
        const handler = performance.now() - t0;
        await nextFrame();
        per.push(handler + work);
      }
      dragRuns = runs;
      fire('pointerup', x, y, 0);
      for (let i = 0; i < 3; i++) await nextFrame();
      await sleep(1200);
    } finally {
      window.requestAnimationFrame = origRaf;
      for (const [def, orig] of wrapped) def.apply = orig;
    }
    // A drag that did not move the layer measures nothing: reported as a failure.
    const moved = st().sessions[docId].doc.layers[layerId].transform.x !== tx0;
    results.push({ name: cs.name, guard: cs.guard, layerRenders: dragRuns, notMoved: !moved, slotMpx: +(info().slotPixels / 1e6).toFixed(1), frames: per.length, work: stats(per.slice(3)), afterTask: 0, settleFrame: null, regionUpdates: '-' });
    st().undo();
    await sleep(300);
    if (st().closeDocument) st().closeDocument(docId);
    await sleep(300);
  }
  return results;
}

/* ------------------------------------------------------------------------------------------ */
/* Node side                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: gpu
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-accelerated-2d-canvas']
    : ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];
let failed = false;
const ok = (d) => d && d.max <= 1;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(1_800_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  console.log(`dirty-rect check — ${gpu ? 'GPU (accelerated canvas)' : 'software canvas'}`);
  if (args.bench === 'true') {
    const res = await page.evaluate(benchPart, { benchFrames: Number(args['bench-frames'] ?? 90), benchOnly: args['bench-only'] ? String(args['bench-only']).split(',') : null });
    console.log('\nbrush 200 px / move drags, fit zoom: main-thread ms per pointermove     mean   p50    p90    max    settle frame  longest task*  region updates  other renders† cache Mpx');
    let benchFailed = false;
    for (const r of res) {
      // Perf regression guard (render-cache working set over budget, see openFx).
      let verdict = '';
      if (r.guard) {
        const limit = gpu ? r.guard.gpu : r.guard.sw;
        const bad = [];
        if (r.notMoved) bad.push('the drag did not move the layer');
        if (limit !== null && r.work.mean > limit) bad.push(`mean ${r.work.mean} ms > ${limit} ms`);
        if (r.layerRenders !== null && r.layerRenders > r.guard.renders) bad.push(r.name.startsWith('move') ? `${r.layerRenders} smart-filter runs during the drag` : `${r.layerRenders} re-renders of other layers during the stroke (${(r.otherKeys ?? []).join(', ')})`);
        verdict = bad.length ? `  ✗ ${bad.join(', ')}` : '  ok';
        if (bad.length) benchFailed = true;
      }
      console.log(
        `  ${r.name.padEnd(68)}${String(r.work.mean).padEnd(7)}${String(r.work.p50).padEnd(7)}${String(r.work.p90).padEnd(7)}${String(r.work.max).padEnd(7)}${(r.settleFrame !== null && r.settleFrame !== undefined ? `${r.settleFrame} ms` : '-').padEnd(14)}${(r.afterTask ? `${r.afterTask} ms` : '-').padEnd(15)}${String(r.regionUpdates ?? '-').padEnd(16)}${String(r.layerRenders ?? '-').padEnd(15)}${r.slotMpx ?? '-'}${verdict}`,
      );
    }
    console.log('  settle frame: the frame re-rendering approximate GPU work exactly after the stroke (- = nothing to settle)');
    console.log('  * longest main-thread task within 1.5 s after the stroke (any work: history, thumbnails, settle…)');
    console.log('  † brush: renders of layers other than the painted one stored during the stroke (re-renders after cache evictions);');
    console.log('    move drag: smart-filter runs at full size during the drag (the moved render must be reused)');
    if (res[0]?.cropExact !== undefined) console.log(`  (canvas backend crop-exact: ${res[0].cropExact})`);
    await browser.close();
    const realB = errors.filter((e) => !/Failed to load resource/.test(e));
    if (realB.length) console.log('\nPAGE ERRORS:\n' + realB.slice(0, 20).join('\n'));
    console.log(benchFailed || realB.length ? '\nBENCH FAILED' : '\nBENCH OK');
    process.exit(realB.length || benchFailed ? 1 : 0);
  }
  const part1 = args['e2e-only'] === 'true' ? { rows: [], cropExact: null } : await page.evaluate(rendererPart, opts);
  const rows = part1.rows;
  if (part1.cropExact !== null) {
    console.log(`canvas backend: ${part1.cropExact ? 'crop-exact (region work is exact, nothing to settle)' : 'not crop-exact (GPU: approximate live work is settled)'}`);
    // The software canvas must be detected as exact (else every stroke would be settled for nothing).
    if (!gpu && !part1.cropExact) {
      console.log('✗ software canvas not detected as crop-exact');
      failed = true;
    }
  }
  const fmt = (d) => (d ? (d.max <= 1 ? `ok(${d.max})` : `FAIL max ${d.max} ×${d.over ?? '?'}`) : '-');
  console.log('\nscenario                      frame*      live        shared      small       settled     ms/frame  region/full renders, approx (inexact) updates, settles');
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.name.padEnd(30)}ERROR ${r.error.split('\n')[0]}`);
      failed = true;
      continue;
    }
    // renderDocument (shared, small) is exact on every backend at all times: only live composites
    // may hold approximate pixels, and only on GPU canvases or for inexact work (shared fields).
    const live = [r.live, r.frame];
    const softApprox = !gpu && r.stats.approxUpdates > r.stats.inexactUpdates;
    const pass =
      ok(r.settled.live) && ok(r.settled.shared) && ok(r.refVsFull) && ok(r.shared) && ok(r.small) && (!r.mutated || ok(r.mutated)) && !softApprox && (gpu || r.stats.inexactUpdates > 0 || live.every(ok));
    if (softApprox) console.log(`✗ ${r.name}: ${r.stats.approxUpdates - r.stats.inexactUpdates} approximate update(s) on the software canvas`);
    if (!pass) failed = true;
    console.log(
      `${(pass ? '  ' : '✗ ') + r.name.padEnd(28)}${(r.mutated && !ok(r.mutated) ? `RESIZE ${fmt(r.mutated)} ` : '') + fmt(r.frame).padEnd(12)}${fmt(r.live).padEnd(12)}${fmt(r.shared).padEnd(12)}${fmt(r.small).padEnd(12)}${fmt(worstOf(r.settled.live, r.settled.shared)).padEnd(12)}${String(r.msPerFrame).padEnd(10)}${r.stats.regionUpdates}/${r.stats.layerRenders}, ${r.stats.approxUpdates} (${r.stats.inexactUpdates}), ${r.stats.settles}`,
    );
  }
  console.log('* frame = worst per-frame mismatch of the live composite vs a from-scratch render of a document clone');
  if (args['e2e-only'] !== 'true' && args['no-edits'] !== 'true') {
    const edits = await page.evaluate(editsPart, opts);
    console.log('\nedit sequences (a new document per step)   steps  live*       shared      small       below       settled     extra      filter re-runs†  ms');
    for (const r of edits) {
      if (r.error) {
        console.log(`✗ ${r.name.padEnd(40)}ERROR ${r.error.split('\n')[0]}`);
        failed = true;
        continue;
      }
      let live = null,
        shared = null,
        small = null,
        below = null;
      const bad = [];
      for (const s of r.rows) {
        // Exact renders (renderDocument at any scale, below renders) at every step on every backend;
        // the live composite at every step on the software canvas unless the step did work that is
        // approximate everywhere (reported as inexact), else after the settle.
        if (!ok(s.shared) || !ok(s.small) || (s.below && !ok(s.below))) bad.push(`${s.label}: exact render off`);
        const liveRequired = !gpu && !s.inexact;
        if (liveRequired && !ok(s.live)) bad.push(`${s.label}: live off`);
        if (!gpu && s.approx > s.inexact) bad.push(`${s.label}: ${s.approx - s.inexact} approximate update(s) on the software canvas`);
        live = worstOf(live, liveRequired ? s.live : null);
        shared = worstOf(shared, s.shared);
        small = worstOf(small, s.small);
        below = worstOf(below, s.below ?? null);
      }
      if (!ok(r.settled.live)) bad.push('settled live off');
      if (r.extra && !ok(r.extra)) bad.push('extra reference off');
      if (r.reruns) bad.push(`${r.reruns} smart-filter run(s) while dragging`);
      const pass = !bad.length;
      if (!pass) failed = true;
      console.log(
        `${(pass ? '  ' : '✗ ') + r.name.padEnd(41)}${String(r.rows.length).padEnd(7)}${[live, shared, small, below, r.settled.live].map((d) => `${fmt(d).padEnd(11)} `).join('')}${fmt(r.extra).padEnd(10)} ${String(r.reruns).padEnd(17)}${r.ms}`,
      );
      if (!pass) console.log(`    ${bad.slice(0, 6).join('; ')}`);
    }
    console.log('* live: worst over the steps where the live composite must be exact (software canvas, no work approximate everywhere)');
    console.log('† smart filters run at full size by the live composite while a layer is dragged (must be 0: moved renders are reused)');
  }
  if (args['no-e2e'] !== 'true') {
    await page.goto(url.includes('?') ? `${url}&demo=1` : `${url}?demo=1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const e2e = await page.evaluate(e2ePart, opts);
    console.log('\nend-to-end (paint tools + viewport, demo document)    after stroke   durable**      after settle');
    for (const r of e2e) {
      // dragRuns: smart filters run at full size while a layer was dragged (moved renders must be reused).
      const pass = ok(r.settled) && ok(r.durable) && (gpu || r.approxOk || ok(r.now)) && !r.dragRuns;
      if (!pass) failed = true;
      const f = (d, fail = 'FAIL ') => (d.max <= 1 ? `ok(${d.max})` : `${fail}max ${d.max} ×${d.n}`);
      console.log(`${(pass ? '  ' : '✗ ') + r.label.padEnd(52)}${f(r.now, '').padEnd(15)}${f(r.durable).padEnd(15)}${f(r.settled)}${r.dragRuns > 0 ? `   ✗ ${r.dragRuns} smart-filter runs while dragging` : r.dragRuns < 0 ? '   ✗ the drag did not move the layer' : ''}`);
    }
    console.log('** renderDocument + document / layer thumbnails right after the stroke (before any settle) vs from-scratch renders');
  }
} finally {
  await browser.close();
}
const real = errors.filter((e) => !/Failed to load resource/.test(e));
if (real.length) {
  console.log('\nPAGE ERRORS:\n' + real.slice(0, 20).join('\n'));
  failed = true;
}
console.log(failed ? '\nDIRTY-RECT CHECK FAILED' : '\nDIRTY-RECT CHECK OK');
process.exit(failed ? 1 : 0);

function worstOf(a, b) {
  return !a ? b : !b ? a : b.max > a.max ? b : a;
}
