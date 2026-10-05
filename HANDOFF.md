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
- **Dirty flag** (`src/state/editor.ts`): a saved state is a step id **and** its document
  (`SavedState`, `savedIndexOf`; `markSaved(id, at)`). Coalescing edits (nudge, slider scrub, opacity
  keys, Styler) never merge into the saved step (they push a new one, so the tab turns dirty); a save
  whose step changed under the same id during the encode leaves the tab dirty; a saved step in a
  discarded redo branch or trimmed off the front no longer matches anything. Autosave remembers the
  written step id + document too, so a change coalesced after an autosave is written next time.
- **Fonts in projects** (`src/io/projectFonts.ts`, container `fonts` entries): user-added font files
  used by text layers are embedded in .pgfx files and registered for the session on open when
  missing; still-missing families (e.g. system fonts) are named in a warning toast.
- **PSD** (`src/io/psdAdjustments.ts`): color balance, black & white, photo filter, channel mixer,
  gradient map, selective color and colorize hue/sat are native both ways; other adjustments are
  baked into pixel layers (mask/opacity/blend kept); `doc.background` exports as a bottom
  "Background Color" fill layer and is restored on import.
  - Baked adjustments (`src/io/psdBake.ts`): clipped ones are written at full alpha wherever the clip
    stack has coverage, which Photoshop's clipping reproduces exactly; unclipped ones over
    semi-transparent pixels (isolated groups, transparent documents) can't be exact with one pixel
    layer — they are listed as "baked approximately (soft edges)" in the export toast.
  - Gradient fill/overlay center offsets are written in Photoshop's convention (percent of the box,
    ±50 % = edge; ours is ±1 = edge). ag-psd stores scale/offset as whole percents: a fill that needs
    rounding stays an editable fill only if the rounded gradient renders within 2 levels, otherwise
    it is written as pixels ("gradient fills exported as pixels"); such overlays are baked.
  - (renderer, was a known gap) clip stacks used to add coverage over semi-transparent base pixels
    (50 % base + clipped red → alpha 192; Photoshop keeps the base's 128). They now keep the base's
    coverage like Photoshop (compositeClipStack on a normalized clip base, `src/render/clip.ts`);
    the `scripts/smoke.mjs` render checks cover it. Layer effects: see "Layer effects like Photoshop".
- **Free Transform on tab switch** (`src/viewport/transform/controller.ts commitTransformInOwnDoc`):
  applied in its own document (with a toast) instead of being dropped.
- **CI / installers**: Build installers is green since f6ce5d3 (Windows case-clash rename b4d8728 +
  electron-builder caches outside the repo). No GitHub Release exists yet, and the macOS/Linux jobs
  have never run (they only run on tags / manual dispatch). Maintainer steps (need the owner's
  go-ahead): run the workflow manually with *Create a GitHub Release* unticked to check macOS/Linux,
  then `git tag v0.1.0 && git push origin v0.1.0`, then confirm the Release lists the Setup .exe,
  portable .exe, .dmg and .AppImage. The release job now publishes when only macOS/Linux failed
  (Windows installer required, warnings for the missing ones). `release/Perseverance-Setup-0.1.0.exe`
  on disk is a local build of the current electron/ code (`WINEDEBUG=-all npx electron-builder --win
  nsis --x64 --publish never`, with embedded asar integrity), not a release artifact. README: sharing
  leads with sending the Setup .exe itself.

## Layer effects like Photoshop (src/render/engine.ts runEffects / FxCore)
- Above-stage effects clipped to the content (colour/gradient/pattern overlay, inner shadow/glow,
  satin, inside stroke, bevel) only recolour it and never add coverage, also over semi-transparent
  pixels: a 50%-alpha pixel with an opaque red Color Overlay renders [255,0,0,128] (it used to be
  [212,42,42,192]: each effect was clipped with destination-in and then drawn source-over).
- Their outputs are relative to the content's shape and are drawn unclipped (`drawAbove`): at
  full fill normal-blend pieces go `source-atop` onto the core (no readback); otherwise (blend
  mode, fill below 100%) they composite on the normalized core — core ÷ content alpha, i.e. opaque
  at full fill, the fill opacity below it — with plain blending, and the content's alpha is applied
  afterwards (`normalizeCore` in `src/render/clip.ts`, CPU readback: canvas-op un-premultiplies
  round differently on GPU canvases of different sizes). Below 100% fill clipped effects still
  reach the content's full coverage (0% fill + opaque overlay → the overlay at the content's alpha).
- Unclipped effects (centre stroke, emboss) still draw over the core as they are and extend beyond
  the content; clipped pieces after them (inside stroke after emboss) act on the content's share
  only (the excess is split off on the CPU and added back with 'lighter').
- Cached effect outputs (`FxEntry`) now hold the unclipped pieces; reuse and in-place region updates
  (`updateRenderRegion`) go through the same `drawAbove` path, so partial == full.
- Opaque interior pixels are unchanged within rounding; only semi-transparent content changes.
  Cost: one CPU readback of the content rect per layer render when a clipped effect has a blend
  mode or the fill is below 100% (none for normal-blend effects at full fill).
- Checks: `scripts/smoke.mjs` render checks (overlay on a 50% pixel: normal, 50% opacity, multiply,
  50% / 0% fill), dirty-rect scenarios `fx-soft-atop`, `fx-soft-fill`, `fx-soft-mixed` (plus the
  clip scenarios `clipped-fill` / `clipped-mixed`), `src/render/clip.test.ts`.
- Pre-existing (not from this change): two distance-field effects (stroke + bevel, two strokes)
  on soft-edged content give live mid-stroke frames that are off by up to ~250 levels until the
  settle (`fx-soft-mixed` shows it; the same numbers before this change).

## Desktop hardening (electron/, checked with scripts/electron-desktop-check.mjs — 52 checks)
- Security: sandbox + contextIsolation, no Node in the renderer, IPC sender-frame + type checks.
  Desktop bridge file grants: `readFile`/`writeFile` only accept user-chosen paths (persisted in
  userData); any other path is refused before it is opened (no FIFOs/devices, no UNC paths). The page
  itself can only load file:// URLs inside its own `dist/` folder: Electron's file:// privileges (the
  GrantFileProtocolExtraPrivileges fuse) would otherwise let it fetch()/XHR/<img> any local file, so a
  session webRequest filter cancels every other file:// request (logged as "blocked file request").
  http(s)-only external links, navigation/popups blocked, permissions limited to local
  fonts/clipboard/fullscreen, CSP clean in the packaged app with network access only to
  `*.roblox.com` / `*.rbxcdn.com`, electron-builder fuses (no RunAsNode / NODE_OPTIONS / inspect, app
  only from asar, embedded asar integrity validation on Windows/macOS). Possible later step: serve the
  app from a privileged `app://` scheme and turn the file:// privileges fuse off (changes the page
  origin, so localStorage prefs / recent files would need a migration).
- Behaviour: single instance + .pgfx association (argv and cwd forwarded; files wait for the page to
  load — a cold start with a file argument used to spin the main process at 100% CPU and never load),
  macOS open-file, close guard with ack timeout / "Quit Anyway" / repeated-close way out / forced
  destroy after 5 s, Windows session end never blocked, window bounds restored, Save As adds `.pgfx`.
  A project that is already open switches to its tab instead of opening a second copy, whichever way
  it is opened (Explorer double-click, File ▸ Open, Open Recent: io `focusOpenProject`). Saves keep the
  replaced file's permissions and refuse read-only files (POSIX rename would replace them silently).
  Save in place falls back to Save As (with a short reason) for a read-only/locked file, a folder or
  drive that is gone (USB stick removed), or a full disk.
- Before → after (same check script against the f6ce5d3 electron/ files): 7/17 checks passed before the
  run wedged (a file forwarded while the page loaded spun the main process; no close timeout, no access
  policy, no Save As extension fix, no window state, no crash prompts) → 46/46. Review round 2: the
  previous code fails the new checks (page fetch of file:///etc/hostname and of unchosen files allowed;
  FIFOs named .pgfx blocked the main process' file I/O; unresponsive → Reload left a blank window) → 52/52.
- Crash resilience: crash prompt (Reload / Quit); unresponsive prompt (Wait / Reload / Quit) where
  Reload kills the hung renderer and reloads once its process is gone, with a safety net (crash prompt
  when the editor is not back within 15 s). A crash or reload drops a pending Cmd+Q, so a later window
  close on macOS doesn't quit the app. Main-process log in `userData/logs/main.log` (uncaught
  exceptions, renderer console errors, crashes, blocked requests).

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
   - (partly done, filter-perf) 1080p filter speedups. Every optimized filter is bit-identical to its previous
     implementation (src/filters/{adjustments,stylize}/perf.test.ts vs the old code in perf.reference.ts, incl. every
     8-bit color for hue/sat, vibrance, color balance, selective color, and every ordering for the median networks).
     Headless Chromium, crimson template / noisy synthetic image, median ms old → new: hue/sat 78 → 32 / 112 → 40,
     vibrance 36 → 30 / 61 → 50, selective color 50 → 29 / 53 → 54, color balance 42 → 25 / 52 → 52, dithered
     gradient map 58 → 16, curves/levels/exposure 12 → 10 (B&W, photo filter, channel mixer, split toning unchanged at
     17-29), vignette 30 → 26 (roundness < 0: 139 → 32; per-row evaluation, no cache, any region costs only its
     pixels), film grain 394 → 84, add noise 58 → 34, chromatic aberration 285 → 144 / 287 → 163, gaussian blur r4
     248 → 135 / 246 → 175, r20 130 → 87, bloom 589 → 213 / 647 → 254, halftone 231 → 117 / 212 → 185, cel shade
     450 → 409, cutout 826 → 548. Hue/sat, vibrance, color balance and selective color keep a per-parameter-set color
     memo between calls (adjustments/math.ts colorMemo: 4 × 2 MB LRU; re-rendering an unchanged layer, e.g. painting
     below it, is mostly lookups: ~20-29 ms); noisy images drop to the plain loop after a probe.
   - PERF (open): still above the spec targets with exact JS: hue/sat, vibrance, selective color, channel mixer
     (25-50 ms vs < 25), vignette (~26 vs < 20), bloom (~210), cel shade (~400), cutout (~550), and noisy-image
     gaussian blur / halftone / chromatic aberration (165-185); watercolor / ink wash / screen print / risograph
     0.8-1.2 s (only shared primitives got faster). The box-blur core runs at ~8 cycles per element (scalar limit).
     Next step: WASM SIMD (a prototype box blur was 3-4× faster and bit-identical) — needs 'wasm-unsafe-eval' in
     index.html's CSP, which src/platform/desktopMain.test.ts currently rejects (any 'unsafe-eval' substring) — or a
     Worker behind an async filter API.
   - Optional: editor store `beforeCommit` hook so Free Transform can commit itself before another command
     (viewport currently repairs history via transform/historySplit.ts).
   - Optional: FilterContext.contentRect so edge-sensitive filters (rim-light, toon) know the real layer box.
   - (done) viewport.fit accounts for rulers; Alt+wheel no longer focuses the menu bar; Dialog submits with the
     latest onSubmit after Enter blur-commit.
   - (done) FilterDef.hidden honored by palette / Properties smart-filter menu / adjustments / gallery; Dialog Enter
     on buttons/links/selects/search fields no longer submits.
   - Optional: FilterContext layer bounds (or edge-repeat padding) so smart blurs match destructive results at edges.
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
     and the viewport redraws only that screen area. Render signatures include the output AND document size
     (`geometrySig`), so Canvas Size / Crop / Trim never reuse renders made for the old size.
     Exactness: only the LIVE composite may hold approximate pixels. A one-time idle probe (`canvasCropExact()`,
     src/render/backendProbe.ts) checks whether crops/clipped draws match whole draws: on the software canvas they do
     and nothing is ever approximate or settled; on GPU canvases blur/resample/gradient work on crops (and several
     effects sharing distance fields, on every backend) is approximate — ~350 ms after painting stops (at idle) the
     approximate layer renders are dropped and the live composite re-composites just that area exactly
     (`onRenderSettle`). renderDocument / renderLayerToDoc / thumbnails / exports are exact at all times (they skip
     approximate renders and only do region work that is exact on the backend), so no settle call is needed anywhere.
     Correctness check: `node scripts/dirty-rect-check.mjs --url http://localhost:<port>/ [--gpu]`.
     Benchmark: `node scripts/dirty-rect-check.mjs --url http://localhost:<port>/ --bench [--gpu]` (real brush, 200 px,
     fit zoom; main-thread ms per pointermove = handler + frames; "before" = this tree with the paint-perf files
     reverted to f08283b; noisy shared 4-core box, ranges over 2 runs, GPU "before" 1 run):
       software canvas            before (mean/p90)   now (mean/p90)   settle frame after the stroke
         demo Red Glow            54–57 / 74–79       5.7–6.0 / 7.5–8.6   none (previous round: none)
         demo Roblox Character    85–88 / 104–109     22–25 / 28–34       none (previous round: 170 ms)
         1-layer 1080p            20–22.5 / 23–28     3.5–4.0 / 4.5–5     none
       GPU canvas (SwiftShader)
         demo Red Glow            199 / 280           71–88 / 94–122      none
         demo Roblox Character    378 / 520           117–128 / 151–188   ≈220 ms (previous round: ≈330 ms)
         1-layer 1080p            4.5 / 8.4           1.6–1.9 / 2.1–2.4   none
     On SwiftShader the main-thread time is almost all synchronous GPU readbacks (getImageData waits for the
     emulated GPU to finish the frame): one per frame for a CPU adjustment above the painted layer (the demo's
     Vignette) and one for distance-field effects (stroke/bevel; it was two). Removing the adjustment readback needs
     either GPU (WebGL) adjustments or a CPU-backed paint pipeline (painted bitmap, below cache and the layers above
     kept on CPU canvases) — not done. Hardware GPUs should make these syncs far cheaper (not measured here).
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
