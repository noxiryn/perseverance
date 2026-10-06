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
  - Baked adjustments (`src/io/psdBake.ts`): clipped ones filter the clip stack exactly as the
    compositor builds it (`renderClipBackdrop` in `src/render/compositor.ts`: the base's colour made
    opaque — content + above-stage effects, WITHOUT its behind-stage effects (drop shadow, outer glow,
    outside stroke), which are drawn below the stack — plus the clipped layers below) and are written
    at full alpha wherever that stack has coverage, which Photoshop's clipping reproduces exactly, soft
    base edges included (`finishClippedBake`). Unclipped ones over semi-transparent pixels (isolated
    groups, transparent documents) can't be exact with one pixel layer, nor can clipped ones over a
    base at a lower Fill or with an above-stage effect reaching beyond its content (centered stroke);
    those are listed as "baked approximately" in the export toast (the error is computed per pixel).
  - Clip bases with styles: baking a base's styles into its own pixels would make them the clip's
    shape in Photoshop (clipped layers painting over its shadow / stroke / glow — e.g. max 226 levels
    for a clipped texture over a stroked, shadowed character). With "Bake layer styles" (the default),
    and for a clip base with a style Photoshop lacks, the behind-stage pieces are written as pixel
    layers of their own below the base ("<name>'s Styles", each with its blend mode, at the base's
    opacity, knocked out under the content as rendered — like Photoshop's Create Layers), and the base
    keeps its content (Fill / mask still Photoshop's) or, with above-stage effects, its core pixels.
    Where that can't reproduce the render (above-stage effects with a reduced Fill, an enabled mask, or
    coverage beyond the content — e.g. an overlay over soft edges) the styles stay editable Photoshop
    effects instead, unless one has no Photoshop equivalent (long shadow, pattern overlay): then they
    are baked into the base as before and the toast says the clip now includes them. All three cases
    are named in the export toast.
  - Gradient fill/overlay center offsets are written in Photoshop's convention (percent of the box,
    ±50 % = edge; ours is ±1 = edge). ag-psd stores scale/offset as whole percents: a fill that needs
    rounding stays an editable fill only if the rounded gradient renders within 2 levels, otherwise
    it is written as pixels ("gradient fills exported as pixels"); such overlays are baked.
  - Clip stacks now use Photoshop's semantics (renderer, see below), so clipped layers look the same
    in Photoshop over soft base edges too, and a clipped baked adjustment re-imports exactly. Runtime
    round trip (buildPsd → writePsd → readPsd → psdToDocument → render) of the character of six
    templates whose characters carry stroke + drop shadow / outer glow (youtube-story, versus,
    simulator-bright, anime-action, update-banner, crimson), alone in a transparent document, with a
    clipped duotone (baked) — or a clipped multiply texture at 70 % + the duotone at 60 %:
    - "Bake layer styles" (default): before (HEAD af6cd38) 27 000–115 000 pixels off per case, by up
      to 13–61 levels (the baked base's effects became the clip); now max 1–3 levels (rounding).
    - Editable styles: before, soft edges off by up to 5–53 levels, not flagged; now the bake adds
      nothing — the only differences left are the editable effects' own Photoshop mapping, identical
      without the adjustment (crimson's outer glow: 1 599 px off by up to 40; youtube-story: 7 px).
    A whole template (versus + clipped texture + duotone, bake styles) re-imports with max 0. Tests:
    `src/io/psdClip.test.ts` (buildPsd → psdToDocument → render on the software canvas: soft base,
    base with drop shadow + outside stroke, with opacities / a clipped layer below, a lower Fill and
    a centered stroke flagged approximate, bake-mode split / editable fallback, an unsupported style
    split off; the behind-effects cases fail on the previous psd.ts), `src/io/psdBake.test.ts` (the
    per-pixel error formula against a simulation of both composites).
- **Clipping masks** (`src/render/clip.ts`, `compositeClipStack` / `clipBaseFor` in `engine.ts`):
  a clip stack's coverage is its base's — clipped layers never add coverage (50 % base + clipped red
  used to come out at alpha 192, now 128 like Photoshop) — and each clipped layer blends "atop":
  Co = αs·B(Cb, Cs) + (1 − αs)·Cb, αo = αb. Canvas 2D can't blend atop, so the stack is composited
  over the base made opaque (its core un-premultiplied by the coverage, computed on the CPU once per
  base render and cached per core/shape canvas; live painting recomputes only the changed area,
  zero-copy raster bases follow `bitmaps.dirtySince`), with plain source-over blending, then the
  base's alpha is applied with destination-in. 0 % fill bases still clip (Photoshop); where an
  above-stage effect of the base reaches beyond its content (centered stroke, emboss, overlays over
  soft edges), clipped layers get only the content's share of the coverage. Adjustment layers with a
  blend mode keep the backdrop's alpha too (they squared it over soft pixels); their blend is computed
  on the CPU (`src/render/blendMath.ts`, W3C formulas, LUTs for separable modes, a result memo for
  hue/saturation/color/luminosity): canvas blending rounds exact ties differently depending on the
  surfaces (GPU vs CPU, opaque vs not), so an incremental composite of a crop and a full render
  differed by 1–2 levels on GPU canvases (also before this change, for any adjustment over soft
  pixels). Every path goes through `compositeClipStack` (full / live / below-cache composites,
  thumbnails, renderLayerToDoc, merged copies); PSD bakes read the same stack before the coverage is
  applied (`buildClipStack` via `clipStackBackdrop` / `renderClipBackdrop`). Tests: `src/render/clip.test.ts` runs the
  real compositor on a test-only software canvas (`src/render/softCanvas.ts`, jsdom has none),
  `src/render/blendMath.test.ts`; `dirty-rect-check.mjs` gained `clipped-soft`, `clipped-group-base`,
  `clipped-fx-base` and `adjustment-blend-soft` (all pass, software and --gpu). None of the 23
  templates uses clipping or blend-mode adjustments: their renders are bit-identical before/after.
  With clipped shading/rim/hue-sat layers added to 7 template characters, only the characters' soft
  outlines change (0.1–0.85 % of values; the old dark halo from the added coverage is gone). Cost:
  a hue/saturation/color/luminosity adjustment blend over a noisy 1080p area ≈ 0.1 s per full
  re-render on the CPU (≈ 25–50 ms over gradients/flat art; separable modes ≈ 10–15 ms).
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

## Desktop hardening (electron/, checked with scripts/electron-desktop-check.mjs — 52 checks)
- Security: sandbox + contextIsolation, no Node in the renderer, IPC sender-frame + type checks.
  Desktop bridge file grants: `readFile`/`writeFile` only accept user-chosen paths (persisted in
  userData); any other path is refused before it is opened (no FIFOs/devices, no UNC paths). The page
  itself can only load file:// URLs inside its own `dist/` folder: Electron's file:// privileges (the
  GrantFileProtocolExtraPrivileges fuse) would otherwise let it fetch()/XHR/<img> any local file, so a
  session webRequest filter cancels every other file:// request (logged as "blocked file request").
  That filter only sees requests from the page itself: Dedicated/Shared Worker requests never reach it
  (and on file:// CSP 'self' matches every local file), so the CSP has `worker-src 'none'` — the app
  uses no workers; keep it 'none' (never blob:, and 'self' only after an app:// migration). The page is
  loaded with `loadURL(lib.fileUrlOf(index.html))`, not `loadFile` (which left '%' unescaped: an install
  folder like `C:\Users\100%Real\…` gave a blank window with IPC refused); a failed page load shows a
  native error naming main.log (Try Again / Quit). Save dialog: the page's `defaultPath` is kept only
  when it is a granted file, else cut to a file name (no UNC/absolute paths from the page: Windows probes
  them before the user acts), and only pgfx/png/jpg/jpeg/webp/psd filters (none left → refused).
  External links: `openExternal` / `window.open` hand only https www.roblox.com / roblox.com and the
  project's GitHub page to the browser (lib.isExternalUrl); navigations of the window are blocked and
  never handed on. VITE_DEV_SERVER_URL is ignored by a packaged app (and unpackaged only honoured for
  localhost). Permissions limited to local
  fonts/clipboard/fullscreen, CSP clean in the packaged app with network access only to
  `*.roblox.com` / `*.rbxcdn.com`, electron-builder fuses (no RunAsNode / NODE_OPTIONS / inspect, app
  only from asar, embedded asar integrity validation on Windows/macOS), `build.publish: null` (no updater;
  local builds without a GitHub remote no longer exit 1 when a GH_TOKEN is set). Packaged-only checks:
  `scripts/electron-packaged-check.mjs --bin release/linux-unpacked/perseverance`. Possible later step: serve the
  app from a privileged `app://` scheme and turn the file:// privileges fuse off (changes the page
  origin, so localStorage prefs / recent files would need a migration; keep the '%' install-folder test).
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
   - (done, wasm-blur) WebAssembly fast path for the hot CPU loops, bit-identical to the JavaScript it replaces:
     src/core/wasm/ (runtime.ts: loader + stack allocator over one growable linear memory; boxStream.ts: util.ts's
     streaming box passes; blurWasm.generated.ts: the module, base64-inlined so nothing is fetched). Kernels: util.ts
     box passes (rows 1-4 channels, two rows per call, f64x2 vertical steps, premultiplied / opaque-RGB row I/O),
     blurImage's reduced-resolution path, the exact small-σ gaussian (σ < 1, 3/5/7 taps), core/blur.ts
     boxBlurImageData (selection feather; i32x4) and blurChannel, the separable median networks (u8x16), and bloom's
     full-size loops (bright-pass downsample, row lerps, row sum + screen). Source of truth: scripts/gen-wasm.mjs (a
     tiny assembler + the hand-written kernels; no toolchain) — regenerate with `npm run wasm` (`node
     scripts/gen-wasm.mjs`; `--check` exits 1 when the generated file is stale; a vitest test fails too; both ignore
     CRLF vs LF, and .gitattributes pins the generated file to LF for Windows checkouts). Every kernel does the JS's
     float64/float32 operations in the same order (Uint8ClampedArray rounding = nearest-even + clamp); the JS path
     stays and runs whenever WebAssembly is unavailable or refused (no 'wasm-unsafe-eval' in the CSP, old engine,
     instantiation error, a refused memory grow) — identical output either way. `blurBackend()` / `blurBackendInfo()`
     (core/blur.ts, also `window.__app`) say which one runs and why; `setBlurBackend('js')` forces JS
     (tests/benchmarks). Memory grows on demand (a 4K image: a few MB to ~350 MB depending on the filter — bloom with
     radius ≤ 4 ~349 MB, the σ < 1 gaussian ~285 MB, most others ≤ 64 MB; capped at 1 GiB, beyond which that operation
     runs in JavaScript), is reused, and is handed back (instance recreated) once no operation has needed more than
     192 MB for 2 s — a burst of 4K runs (live preview) doesn't regrow it each time. CSP: index.html script-src is
     `'self' 'wasm-unsafe-eval'` (WebAssembly compilation only; eval / new Function stay blocked — desktopMain.test.ts
     compares CSP keywords as whole tokens and still forbids plain 'unsafe-eval'); electron/main.cjs sets no CSP
     header of its own and its file:// filter is unaffected (no fetch). Tests: src/core/wasm/blurWasm.test.ts (JS vs
     WASM bit for bit on random inputs: sizes 1×1 … 3840×n, radius 0/1/> width, fractional radii, 1-6 channels, every
     small-σ kernel size, bloom variants, memory growth under a view of the module's memory, refused allocations, the
     generated file being current); perf.test.ts (vs the pre-optimization reference) now runs on the WASM path.
     Runtime checks: all 23 templates render pixel-identical with WASM and forced JS; with 'wasm-unsafe-eval' stripped
     from the CSP the page falls back to JS (CompileError) with identical filter output; in the packaged Electron app
     the module compiles in page context, no CSP violations / console errors, eval and new Function still throw
     EvalError. Timings (ms):
     1920×1080, headless Chromium (same method as above: crimson template render / noisy synthetic image, median
     of 7, JS and WASM alternated in one page; JS = this tree with setBlurBackend('js'), i.e. the code as before;
     noisy shared 4-core box, ±10 %):
       filter                     JS (before)       WASM
       gaussian blur r4           121 / 158         34 / 41
       gaussian blur r20           78 / 72          30 / 28
       bloom                      183 / 208         90 / 120
       halftone                   103 / 167         93 / 114
       cutout                     537 / 704        385 / 531
       cel shade                  373 / 423        307 / 365
       unsharp mask               182 / 213         99 / 97
       watercolor                1152 / 913        840 / 775
       screen print / risograph   ~800              ~720-770
       ink wash, sharpen          unchanged (no CPU blur in their hot path)
       chromatic aberration       103 / 117        unchanged (no blur: bilinear taps + compositing)
       drop shadow / outer glow    ~65              unchanged (layer effects blur with the canvas filter)
     Primitives at 1920×1080: boxBlurImageData r6 (selection feather) 289 → 63 ms, blurPlane σ 0.9 53 → 15,
     blurImage σ 0.9 270 → 69, blurChannel r4 61 → 18. 3840×2160 (median of 3, identical bytes): gaussian blur
     r0.8 1327 → 305, r5 745 → 174, r60 258 → 116, bloom 1129 → 494 (radius 10: 2043 → 792). Inside the packaged
     Electron app (xvfb): gaussian blur r4 172 → 39, r20 90 → 30, bloom 186 → 106, unsharp mask 169 → 57.
   - PERF (open): still above the spec targets: hue/sat, vibrance, selective color, channel mixer (25-50 ms vs < 25),
     vignette (~26 vs < 20), bloom (~90-120: what is left is its per-pixel arithmetic, now WebAssembly but scalar),
     cel shade (~300-365: celFinish, distance fields, edge passes — not blur), cutout (~390-530: quantization, mode
     filter, OKLab), noisy-image halftone (~115: screening) and chromatic aberration (~120); watercolor / ink wash /
     screen print / risograph 0.7-1.1 s. These are filter-specific loops (no shared blur left to speed up); the
     same generator can take more of them (each needs its own JS-vs-WASM test), or a Worker behind an async filter
     API. Not ported: src/render/effects/math.ts `blurField` (bevel/emboss soften; same arithmetic as blurChannel,
     so it could call the bc_h / bc_v kernels).
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
