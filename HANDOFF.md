# Perseverance — build status & handoff

Use this file to resume work in a new session. Branch: `claude/roblox-thumbnail-designer-h3hqtq`.
Read `ARCHITECTURE.md` first: it is the contract (module ownership, shared APIs, ID catalog).

## Goal
A desktop app (Electron + Vite + React + TS) that works like Photoshop and is specialized for stylized Roblox
thumbnails, icons and GFX. Reference styles live in `docs/reference/` locally (git-ignored, so they
may be missing in a fresh clone): a gothic paper poster, a sunburst halftone icon, a noir newspaper
thumbnail, a crimson film thumbnail, and the target UI. It ships as a Windows installer
(NSIS `.exe`) that the user can share, plus mac/linux builds via CI.

## Status (last updated during the parallel module build)
Each module goes through implement → adversarial review → fix (see the workflow spec in
ARCHITECTURE.md §3 for each module's full feature list).

| Module | Dir | Stage reached |
|---|---|---|
| foundation (core, store, registries, controls, electron) | `src/core`, `src/state`, `src/registry`, `src/editor`, `src/ui/controls`, `electron/` | done |
| shell (chrome, menus, dock, palette, start screen) | `src/ui/shell`, `src/App.tsx` | **done** (implement + review + fix) |
| layers-panels (Layers/Properties/Effects/History/Navigator, Layer menu) | `src/panels` | **done** |
| paint (brush engine, paint tools, brushes panel) | `src/tools/paint` | **done** |
| adjustments | `src/filters/adjustments` | **done** |
| fonts-color (86 bundled fonts, swatches/color/fonts panels) | `src/fonts`, `src/presets` | **done** |
| renderer (compositor, text, shapes, layer styles) | `src/render` | **done** |
| viewport-select (canvas, selection/transform/crop tools, Select/View menus) | `src/viewport` | **done** |
| roblox (Pose Studio, remove bg, styler, safe zones, preview) | `src/roblox` | **done** |
| io (projects, export, PSD, clipboard, autosave, File/Edit/Image menus) | `src/io` | **done** |
| type-shape (type tool, character panel, shapes + presets) | `src/tools/type`, `src/tools/shape` | **done** |
| looks-templates (looks engine, templates, doc presets) | `src/looks`, `src/templates` | **done** |
| fx-filters (creative filters, filter dialog, gallery) | `src/filters/stylize`, `src/filters/ui` | **done** |
| assets (procedural asset library, Libraries panel) | `src/assets` | **done** |

If a module wasn't marked done, re-run its review + fix pass: have an agent audit the module
against its spec in ARCHITECTURE.md §3/§5, then fix what it finds. The code on disk is the
starting point; don't rewrite modules from scratch.

## Integration status (latest)
- Whole tree: `npx tsc -b` clean, `npx vitest run` 844 tests pass, `npx vite build` OK (dist ≈35 MB, mostly fonts).
- `scripts/smoke.mjs` against `vite preview`: SMOKE OK (23 templates, 14 panels, all tools dragged, 293 commands, 0 errors).
- `xvfb-run -a node scripts/electron-smoke.mjs`: the real Electron app boots from dist/ with the desktop bridge, 0 errors.
- Reference templates visually match the four reference styles.
- All 13 modules done. In progress: perf (dirty-rect painting, hot filter LUTs) + Electron hardening workflow.
- Next: final whole-app review → fixes → installer → README.

## Final review fixes — robustness & docs (docs/status/final-review.json)
- **Bitmap GC** (`src/state/editor.ts`): a closed document's pixels and pixels only used by dropped
  history entries (discarded redo branch, coalesced step, trimmed steps) are freed immediately;
  a throttled idle pass (~31 s after the first change, postponed while a dialog is open) frees
  other unreferenced bitmaps older than the 30 s grace. Pinned bitmaps are never freed. Tests:
  `src/state/editor.test.ts`.
- **Consistent saves** (`src/io/project.ts`, `pngCache.ts startEncodes`): every bitmap's PNG encode
  is started synchronously (canvas.toBlob snapshots at call time) before the first await; Save and
  autosave write the committed history step they mark as saved, so undo/redo/edits during a save
  can't mix states.
- **Fonts in projects** (`src/io/projectFonts.ts`, container `fonts` entries): user-added font files
  used by text layers are embedded in .pgfx files and registered for the session on open when
  missing; still-missing families (e.g. system fonts) are named in a warning toast.
- **PSD** (`src/io/psdAdjustments.ts`): color balance, black & white, photo filter, channel mixer,
  gradient map, selective color and colorize hue/sat are native both ways; other adjustments are
  baked into pixel layers (mask/opacity/blend kept); `doc.background` exports as a bottom
  "Background Color" fill layer and is restored on import.
- **Free Transform on tab switch** (`src/viewport/transform/controller.ts commitTransformInOwnDoc`):
  applied in its own document (with a toast) instead of being dropped.
- **CI / installers**: Build installers is green since f6ce5d3 (Windows case-clash rename b4d8728 +
  electron-builder caches outside the repo). No GitHub Release exists yet — push a tag (`v0.1.0`) to
  publish one. `release/Perseverance-Setup-0.1.0.exe` on disk predates the module work (stale).
  README install/sharing/build sections describe Releases vs. Actions artifacts.

## Remaining steps after the modules
1. **Integrate**: `npm run typecheck` (whole tree) + `npx vite build`; fix cross-module mismatches.
2. **Pending core requests** (from module reports):
   - viewport should read `getPref('checkerSize', 8)` from `src/ui/shell/prefs.ts` for the checkerboard.
   - (done) `isTypingTarget` text-only; (done) `desktop.setZoomFactor` bridge in preload.
   - assets (`src/assets/lib/fonts.ts`) imports @fontsource CSS directly → duplicate faces + .woff in dist;
     switch it to `ensureFont()` from `src/fonts/loader.ts`.
   - renderer: `invalidateRenderCache(layerId)` should also drop cached text layout (fonts loader currently
     imports `resetTextCaches` from `src/render/text.ts`); optionally pass a text sample to `ensureFont`.
   - type tool / store: expose "is on-canvas text editing active" + a way to refocus the text editor
     (fonts `apply.ts` currently peeks at the textarea class).
   - fx-filters `src/filters/ui/apply.ts resolveTarget`: allow editTarget==='mask' on adjustment/fill layers.
   - Optional: FilterDef custom params editor so Levels/Curves/Color Balance/Selective Color/Exposure can use
     openFilterDialog (adjustments currently uses its own AdjustmentDialog for those 5).
   - renderer: export `renderLayerParts(doc, layer)` (behind-effects + core separately; engine.ts has an internal
     `renderLayer`) so layers-panels' Rasterize Layer Style is exact for non-Normal blend layers.
   - (done) shell start screen / palette open templates via openTemplate(id) from src/templates (character
     selected); palette looks use currentTargetId().
   - (done, filter-perf) hue/saturation ~100 → ~35-45 ms and vignette ~45-270 → ~25-35 ms per 1080p pass (per-(max,min)
     tables, cached falloff rows + fixed-point blend); film grain ~5×, bloom ~2.5-3×, add noise / chromatic aberration /
     gaussian blur / halftone 1.2-1.8×, dithered gradient map 2-3×; a per-color cache speeds the costlier adjustments
     on rendered art. Outputs identical (vignette ±1); checked against the previous code in
     src/filters/{adjustments,stylize}/perf.test.ts (old implementations in perf.reference.ts). Renderer already
     exports invalidateTextLayout.
   - PERF (open): cel shade (~0.6-0.9 s), cutout (~1.0-1.5 s), vibrance / selective color / color balance (~40-90 ms) and
     the box-blur core stay above the 1080p targets with bit-exact JS; next step would be a Web Worker / WASM (CSP
     needs 'wasm-unsafe-eval') or tolerance-based algorithms.
   - Optional: editor store `beforeCommit` hook so Free Transform can commit itself before another command
     (viewport currently repairs history via transform/historySplit.ts).
   - Optional: FilterContext.contentRect so edge-sensitive filters (rim-light, toon) know the real layer box.
   - (done) viewport.fit accounts for rulers; Alt+wheel no longer focuses the menu bar; Dialog submits with the
     latest onSubmit after Enter blur-commit.
   - (done) FilterDef.hidden honored by palette / Properties smart-filter menu / adjustments / gallery; Dialog Enter
     on buttons/links/selects/search fields no longer submits.
   - Optional: FilterContext layer bounds (or edge-repeat padding) so smart blurs match destructive results at edges.
   - PERF: slow filters at 1080p (watercolor, ink-wash, screen-print, risograph ~1.5-2 s; only the shared blur / edge
     primitives were optimized, no measurable change) — consider a Web Worker.
   - (done) CommandDef.paletteHidden (edit.redoAlt hidden from the palette); ARCHITECTURE §5.3 Edit/Transform layout.
   - Optional: renderLayerToDoc option to skip fillOpacity (PSD export renders a copy with fill 1 today).
   - (done) NumberField `disabled` prop; (done) NumberField arrow keys keep the displayed text in sync.
   - renderer: export `warpPoint`/`isWarpActive`/`ITALIC_SKEW` from compositor.ts (type tool imports warpMath.ts directly).
   - viewport move tool: call `editTextLayer(layerId, {at})` from src/tools/type on double-click of a text layer
     (type module currently uses a window-level dblclick fallback).
   - (done) PERF dirty-rect fast path for live painting: paint passes each frame's dirty rect to
     `bitmaps.touch(id, rect)` (`dirtySince(id, v)`); the renderer updates the painted layer's cached render in place
     over that region (transform/mask/smart filters/effects reach), re-blends only that document region (layers below
     from a tiled cache, adjustments above over the region) into the live composite (`renderDocumentLive`, `since`/`seq`),
     and the viewport redraws only that screen area. Work that is inexact on GPU canvases (blurs/resampling of crops,
     several effects sharing distance fields) is re-rendered exactly ~350 ms after painting stops (`onRenderSettle`).
     200px brush, SwiftShader: 1-layer 1080p ≈50 → ≈5 ms/frame, demo ≈150 → ≈8-11 ms/frame.
     Check: `node scripts/dirty-rect-check.mjs --url http://localhost:<port>/ [--gpu]` (incremental vs from-scratch).
   - Optional follow-ups: exports could call `settleRenderCaches()` first (only matters within ~350 ms of a stroke on
     a GPU canvas); panels' thumbnails could also re-render on `onRenderSettle`.
   - macOS: Edit-menu roles intercept Cmd+C/V — canvas copy/paste on mac should also listen to DOM copy/paste events.
3. **End-to-end smoke test**: `npx vite --port 5300 &` then `node scripts/smoke.mjs --url http://localhost:5300`
   (exercises templates, every command, tool and panel; screenshots in `screenshots-tmp/`).
   Make sure the viewport element carries `data-viewport` so the smoke test drags on the canvas.
4. **Visual QA** against the reference images: render each of the 4 reference templates
   (`tpl-gothic-paper`, `tpl-sunburst-icon`, `tpl-noir-thumbnail`, `tpl-crimson-thumbnail`) and compare.
5. **Final review pass** (correctness, perf, Electron security) and fixes.
6. **Installer**:
   - Linux container needs Wine for NSIS: `dpkg --add-architecture i386 && apt-get update && apt-get install -y wine wine32:i386`,
     then `rm -rf ~/.wine && wineboot --init`.
   - `npm run build && WINEDEBUG=-all npx electron-builder --win nsis --x64 --publish never`
     → `release/Perseverance-Setup-<version>.exe`.
   - Or push a tag `v0.1.0`: `.github/workflows/release.yml` builds Windows/macOS/Linux and publishes a Release.
7. Update `README.md` to match the final feature set, commit and push.

## Useful tools
- `scripts/shot.mjs`: screenshot any URL with optional `--eval` setup script (Chromium at `/opt/pw-browsers/chromium`).
- Dev harness URLs: `?demo=1`, `?panel=<id>`, `?view=1`; `window.__app` exposes registries/stores.
- `scripts/make-icon.mjs`: regenerate `build/icon.png` from `build/icon.svg`.
