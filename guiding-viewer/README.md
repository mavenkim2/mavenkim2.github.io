# Guiding Field Visualization

The viewer lives entirely in this blog checkout. Local preview and GitHub Pages use the same HTML, JavaScript, CSS, catalog, and snapshots. Edit files here directly. UI text uses IBM Plex Sans loaded from Google Fonts (with a sans-serif fallback when offline).

## Run locally

From PowerShell:

```powershell
cd C:\Users\maven\workspace\mavenkim2.github.io\guiding-viewer
.\run.cmd
```

Or double-click `run.cmd`. It finds Node.js on PATH (or the bundled Codex copy), starts the local server, and opens your browser. The catalog's default pool snapshot loads automatically. No package installation, build step, or renderer checkout is required. Leave the console running; Ctrl+C stops the server. If port 8765 is occupied it selects the next available port and prints the URL.

With Node.js on PATH, the equivalent command is:

```powershell
node .\serve.mjs --open
```

Optional arguments: `--port 8766`, or `--snapshot "C:\path\to\snapshot.json"` to open an external snapshot instead of the catalog default. Forward these through `run.cmd` too. Local files can also be opened or dropped into the viewer as JSON or gzip JSON. Use the HTTP URL printed by the server rather than opening `index.html` directly. A WebGPU-enabled browser is required.

## Publish

Commit and push changes in this blog repository through its usual GitHub Pages publishing process. No copying, packaging, or second viewer source is needed. The site URL is:

https://mavenkim2.github.io/guiding-viewer/

The existing Jekyll blog copies this static folder. Keep `index.html` without YAML front matter so the blog layout is not applied. GitHub Pages serves the static files; the Node server is only for local development.

## Add published snapshots

1. Place a guiding export (`.json` or `.json.gz`) in `snapshots/`.
2. Add an entry to `snapshots.json`:

```json
{
  "version": 1,
  "default": "pbrt-pool-rgb-64spp",
  "snapshots": [
    {
      "id": "pbrt-pool-rgb-64spp",
      "name": "PBRT pool · RGB · 64 spp",
      "url": "snapshots/pbrt-pool-rgb-64spp.json.gz"
    }
  ]
}
```

3. Commit and push the file and catalog changes.

The Published snapshots list is generated from the catalog; visitors download only the snapshot they select. Omit `default` to let them choose before downloading. IDs must be unique and use letters, numbers, hyphens, or underscores. URLs are relative to the catalog and must be hosted on the same origin. A selected snapshot can be shared using `?snapshot=ID`. These are exported guiding JSON files, not renderer text logs.

## RGB export

Build the renderer with `YBI_ENABLE_PATH_GUIDING=ON` and `YBI_ENABLE_GUIDING_RGB_STATS=ON` to record RGB means. Export once at the end of a render using `--export-guiding file.json`. RGB snapshots automatically select RGB coloring, with luminance-based Reinhard tone mapping, uniform gamut fitting, and sRGB encoding. Exposure defaults to 0 EV. Scalar snapshots remain supported through the heatmap.

## Controls and snapshot format

Click the viewport to focus keyboard input. WASD moves along the current forward/right axes; Q/E moves along world up. Hold the right mouse button to look (sensitivity 0.002 radians/pixel, pitch clamped to ±1.55). Shift multiplies speed by four, and the wheel scales speed by 1.2 per step, clamped to 0.01–1000 world units/second. Diagonal motion is normalized, matching `src/input/camera_controller.cpp`. F frames the field. Choose Y/Z up to match your scene. Escape releases keyboard focus.

Cells always render using their observed training-position bounds, as filled, two-sided AABBs with the cell's mean radiance color applied uniformly over every face. Cells without finite observed bounds are hidden. Optional outlines and cross markers at VMM pivots are off by default. Color by mean radiance, sample count, depth, or component count. Click a cell, or enter its ID, to inspect statistics, observed bounds, and its VMM as a 3D spherical density heatmap centered at the pivot. The sphere replaces the directional arrows. Blue means low density, then cyan, green, yellow, and red for high density; colors use log(1 + 100 * density / peak) / log(101), normalized per mixture. On selection, a WebGPU compute pass evaluates the complete weighted VMM at 2048 × 1024 world-space directions across the full sphere (16 × 16 workgroups). The grid is uniform in azimuth and zenith. It evaluates density per steradian directly, without an additional sine weighting. A workgroup/global maximum reduction finds the sampled peak; a second compute pass maps the full density field to colors. The 3D sphere and flat map sample the same GPU texture. Camera movement only changes the view of that fixed directional field; it does not evaluate or renormalize the mixture. The finite angular grid approximates lobes narrower than a texel. The sphere uses a fixed world-space radius: clamp(0.55 × observed cell diagonal × Heatmap size, Minimum heatmap radius, Maximum heatmap radius). Both limits are editable in world units and default to 1% and 2% of the snapshot extent when loaded. Camera movement and viewport size never resize it; the sphere naturally appears smaller when viewed from farther away. It is drawn over the cell geometry to remain visible at embedded pivots. Selected spherical heatmap toggles it. The sidebar flat map uses the same density range/colors and a fixed Y-up equirectangular projection: horizontal azimuth −π to π; vertical zenith 0 at the top to π at the bottom. The sphere uses the matching inverse lookup v = acos(direction.y) / π. Radiance/sample cell colors use a separate log(1+x) scale over the visible range. This viewer displays the guiding field; it does not load scene geometry. There is no cutaway control or bounds selector.

## Hide the UI for screenshots

Click **Hide UI · H** under Display, or press **H** while not typing in a form control. The header, sidebar, notices, viewport overlays, and axis marker disappear, leaving the scene and selected spherical distribution across the entire browser viewport. Camera position, selection, and display settings are preserved; movement, looking, and picking still work. Press **H** again or **Escape** to restore the controls. Keep the browser window at the same size for both location screenshots to capture matching image dimensions.

## Export a directional distribution image

Select a cell by clicking it or entering its ID, then click **Export PNG · 2048 × 1024** below the directional density preview. The browser downloads the full-resolution equirectangular heatmap as `<snapshot>-cell-<id>-directional-density.png`, ready to use in a blog post. The image contains just the heatmap, with the same palette, per-mixture log normalization, and fixed Y-up orientation as the preview (azimuth −π to π from left to right; zenith 0 to π from top to bottom). Export reads the original computed GPU texture rather than enlarging the sidebar preview. Select an initialized, nonempty VMM to enable export. Changing the selected cell during export does not change the image already being saved.

## C++ API and snapshot semantics

```cpp
std::string error;
bool ok = guiding.ExportGuidingCells("guiding.json", &error);
// Also forwarded by WavefrontIntegrator::ExportGuidingCells().
```

Call on the owning thread between render/update dispatches. Export synchronizes the device stream and copies the trained field to host memory on CPU or CUDA. The export function itself does not trigger training or modify the field. Call `PathGuidingSystem::FlushTrainingSamples()` (or `WavefrontIntegrator::FinishGuidingTraining()`) first to train pending samples without incrementing the rendered sample count. The offline `--export-guiding` option does this automatically so the snapshot includes the entire requested render. `trainedSamples` records the render sample count of the last completed training pass. No ImGui entry is added.

Version 1 JSON uses `schema: "yeoubi.guiding-cells"`. Top-level fields include `splitDecision`, `generation`, `iteration`, `renderedSamples`, `nodeCount`, `distributionCount`, `sceneBounds`, and `cells`. `renderedSamples` counts calls to `PathGuidingSystem::Update`; direct calls to `UpdateKDTree` do not increment it. Only active guiding cells (`IsGuidingCell`) are exported; lookahead descendants and inactive distribution slots are excluded.

Each cell includes:

| Field | Meaning |
| --- | --- |
| `id`, `nodeIndex`, `parentIndex`, `depth` | Distribution slot and spatial tree identity; IDs belong to this snapshot. |
| `bounds` | Actual spatial cell min/max, including unbounded faces. |
| `observedBounds` | Accumulated training position bounds stored on the node. |
| `position` | Current VMM pivot position. |
| `positionMean`, `positionVariance`, `positionSampleCount` | Stored node position history; it may stop accumulating once its split plane is established. |
| `meanRadiance`, `meanRadianceSource` | Lookahead mean of scalar `incidentRadiance/pdf`, including zeros; otherwise VMM `sumWeights/sampleCount`, conditional on nonzero samples and possibly decayed. The latter is labeled `vmmNonZeroSamples`. Untrained means are null. These are importance-weighted scalar statistics, not RGB or radiance per steradian. |
| `meanRadianceRGB` | Optional RGB mean of `incidentRadiance/pdf`, available when built with RGB statistics and lookahead history exists. |
| `radianceVariance` | Lookahead population variance of `incidentRadiance/pdf`, not variance of the mean; null without lookahead samples. |
| `lookahead` | Sample count, first/second radiance moment sums, and radiance-weighted direction sum. |
| `vmm` | Initialization flag, effective/overall nonzero sample counts, sum of weights, and all active components (direction, weight, kappa, distance). |

All non-finite floats serialize as JSON `null`. In `bounds.min`/`bounds.max`, null indicates an unbounded kd-tree face. These raw spatial regions remain in the export for debugging; the viewer uses only `observedBounds`. Other nulls mean unavailable/non-finite. `distance: null` usually indicates an infinite-distance lobe. Empty fields still export their untrained root, but the viewer draws no box until it has observed positions.


