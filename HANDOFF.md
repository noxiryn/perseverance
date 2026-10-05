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
   - PERF: hue/saturation (src/filters/adjustments/defs/color.ts) ~100 ms and vignette (fx-filters) ~120-160 ms per
     1080p pass dominate full composites — LUT / per-row precompute. Renderer already exports invalidateTextLayout.
   - Optional: editor store `beforeCommit` hook so Free Transform can commit itself before another command
     (viewport currently repairs history via transform/historySplit.ts).
   - Optional: FilterContext.contentRect so edge-sensitive filters (rim-light, toon) know the real layer box.
   - (done) viewport.fit accounts for rulers; Alt+wheel no longer focuses the menu bar; Dialog submits with the
     latest onSubmit after Enter blur-commit.
   - (done) FilterDef.hidden honored by palette / Properties smart-filter menu / adjustments / gallery; Dialog Enter
     on buttons/links/selects/search fields no longer submits.
   - Optional: FilterContext layer bounds (or edge-repeat padding) so smart blurs match destructive results at edges.
   - PERF: slow filters at 1080p (watercolor, ink-wash, screen-print, risograph ~1s) — consider a Web Worker.
   - (done) CommandDef.paletteHidden (edit.redoAlt hidden from the palette); ARCHITECTURE §5.3 Edit/Transform layout.
   - Optional: renderLayerToDoc option to skip fillOpacity (PSD export renders a copy with fill 1 today).
   - (done) NumberField `disabled` prop; (done) NumberField arrow keys keep the displayed text in sync.
   - renderer: export `warpPoint`/`isWarpActive`/`ITALIC_SKEW` from compositor.ts (type tool imports warpMath.ts directly).
   - viewport move tool: call `editTextLayer(layerId, {at})` from src/tools/type on double-click of a text layer
     (type module currently uses a window-level dblclick fallback).
   - PERF (paint/viewport/renderer/bitmaps): dirty-rect fast path for live painting — `bitmaps.touch(id, rect?)`
     (or `viewport.requestRender(docRect?)`) + cache composites below/above the active layer during a stroke, so a
     brush frame re-blends only the stroke region (today every frame re-composites the whole doc: ~30-200 ms).
     Paint already computes per-frame dirty rects in CompositeSession.flush / PixelSession.flush.
   - macOS: Edit-menu roles intercept Cmd+C/V — canvas copy/paste on mac should also listen to DOM copy/paste events.
3. **End-to-end smoke test**: `npx vite --port 5300 &` then `node scripts/smoke.mjs --url http://localhost:5300`
   (exercises templates, every command, tool and panel; screenshots in `screenshots-tmp/`).
   Make sure the viewport element carries `data-viewport` so the smoke test drags on the canvas.
4. **Visual QA** against the reference images: render each of the 4 reference templates
   (`tpl-gothic-paper`, `tpl-sunburst-icon`, `tpl-noir-thumbnail`, `tpl-crimson-thumbnail`) and compare.
5. **Final review pass** (correctness, perf, Electron security) and fixes.
6. **Installer**:
   - Linux container needs Wine for NSIS: `apt-get install -y wine wine32:i386` (with `dpkg --add-architecture i386`), then
     `rm -rf ~/.wine && wineboot --init`.
   - `npm run build && WINEDEBUG=-all npx electron-builder --win nsis --x64 --publish never`
     → `release/Perseverance-Setup-<version>.exe`.
   - Or push a tag `v0.1.0`: `.github/workflows/release.yml` builds Windows/macOS/Linux and publishes a Release.
7. Update `README.md` to match the final feature set, commit and push.

## Useful tools
- `scripts/shot.mjs`: screenshot any URL with optional `--eval` setup script (Chromium at `/opt/pw-browsers/chromium`).
- Dev harness URLs: `?demo=1`, `?panel=<id>`, `?view=1`; `window.__app` exposes registries/stores.
- `scripts/make-icon.mjs`: regenerate `build/icon.png` from `build/icon.svg`.
