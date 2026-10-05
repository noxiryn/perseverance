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
| paint (brush engine, paint tools, brushes panel) | `src/tools/paint` | fixing review findings |
| adjustments | `src/filters/adjustments` | **done** |
| fonts-color (86 bundled fonts, swatches/color/fonts panels) | `src/fonts`, `src/presets` | **done** |
| renderer (compositor, text, shapes, layer styles) | `src/render` | in review |
| viewport-select (canvas, selection/transform/crop tools, Select/View menus) | `src/viewport` | in review |
| roblox (Pose Studio, remove bg, styler, safe zones, preview) | `src/roblox` | in review |
| io (projects, export, PSD, clipboard, autosave, File/Edit/Image menus) | `src/io` | in review |
| type-shape (type tool, character panel, shapes + presets) | `src/tools/type`, `src/tools/shape` | in review |
| looks-templates (looks engine, templates, doc presets) | `src/looks`, `src/templates` | in review |
| fx-filters (creative filters, filter dialog, gallery) | `src/filters/stylize`, `src/filters/ui` | implementing |
| assets (procedural asset library, Libraries panel) | `src/assets` | implementing |

If a module wasn't marked done, re-run its review + fix pass: have an agent audit the module
against its spec in ARCHITECTURE.md §3/§5, then fix what it finds. The code on disk is the
starting point; don't rewrite modules from scratch.

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
   - (done) NumberField `disabled` prop.
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
