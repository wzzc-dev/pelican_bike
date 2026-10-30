# Upstream note: `DrawPath` is ~150x more expensive on the web renderer than on Skia

Status: workaround applied in this repo; the underlying cost is in
`wzzc-dev/moui_web_renderer@0.2.6`.

## Symptom

`./macos_skia` runs at display refresh rate, the packaged `./web_wasm` build of
the same scene (`app/app.mbt`) dropped to ~2.5 fps in Chrome on the same machine
(WebGPU backend active, Canvas2D fallback not involved).

## Measurement

`scripts/measure-web-perf.py` boots a packaged page in headless Chrome, waits for
the app to report `Running`, and samples `requestAnimationFrame` deltas. The main
thread is saturated, so the rAF rate is the frame rate.

```
python3 scripts/measure-web-perf.py http://127.0.0.1:8123/index.html
```

Payload accounting was done by instrumenting `imports.draw_path_mesh` and
`imports.present` in the renderer's `runtime.js` with counters for call count and
`meshPayload.length`.

Pelican scene, 1280x800 viewport, WebGPU backend:

| build | `DrawPath` calls / frame | payload chars / frame | fps |
| --- | --- | --- | --- |
| before (paths for everything) | 175 | 3,617,662 | 2.5 |
| after (analytic quads) | 47 | 399,794 | 22 |
| debug wasm instead of release | same payload | same payload | ~2.0 |

A CPU profile of one second of frames attributed ~60% of the main thread to
`wasm-to-js`, `string_append_char` and `pushPathMesh`.

## Root cause

Two independent problems multiply.

1. Every path is tessellated on the MoonBit side with a fixed subdivision:

   `moui_web_renderer/adapter_host_calls.mbt:328`
   ```moonbit
   let mesh = @render_common.tessellate_path(path)
   host_draw_path_mesh(renderer, host_string(path_mesh_payload(mesh)))
   ```

   `tessellate_path` uses 32 segments per quadratic/cubic, independent of the
   shape's on-screen size, so a 3 px dot costs the same as a 160 px wheel:
   `ellipse r=8` and `ellipse r=80` both produce 189 vertices filled / 384
   stroked. A filled 4-cubic ellipse is 189 vertices.

2. The payload is a comma-joined decimal string that crosses the wasm→JS
   boundary **one code point per call**:

   `moui_web_renderer/adapter_host_imports.mbt:22`
   ```moonbit
   fn host_string(value : String) -> HostWebGpuString {
     let handle = host_begin_create_string()
     for ch in value {
       host_string_append_char(handle, ch.to_int())
     }
     host_finish_create_string(handle)
   }
   ```

   Each component is printed with full `Double::to_string()` precision, so one
   vertex (15 floats) is ~150 characters, i.e. ~150 wasm→JS calls, plus a JS
   `Map.get` and string concatenation each time. A single filled ellipse is
   therefore ~29,000 boundary crossings; the pelican scene was ~3.6M per frame.

Skia does not have this problem because paths go straight to Skia; nothing is
tessellated or serialized.

## Suggested fixes (renderer side)

In order of payoff:

1. Move the mesh across the boundary as numbers, not characters. Either an
   import that accepts a small batch of `f64` (a vertex needs two calls, ~2
   crossings per vertex instead of ~150) or a shared `Float64Array` buffer with
   `copyFromMemory`/`ArrayBuffer`-based transfer.
2. Cache the tessellated mesh per `PathSpec` (identity or content hash) so a
   style-only or transform-only change does not re-tessellate and re-transfer.
3. Make tessellation scale-aware: subdivide by the transformed on-screen size
   with a ~0.25 px tolerance instead of a fixed 32 segments per curve. Small
   decorative shapes would drop from ~190 vertices to <20.
4. Until then, expose a cheap primitive set (filled/stroked rounded rect with
   radius, i.e. an analytic SDF quad, plus affine transform) as the recommended
   way to draw circles, capsules and ellipses. Those already cross the boundary
   as plain numbers and cost ~10 calls each.

## Workaround in this repo

`app/app.mbt` no longer uses `draw_path` for anything that can be expressed as an
analytic quad:

- circles and near-circular ellipses -> `fill_rounded_rect` / `stroke_rounded_rect`
  (a radius of half the short side is an exact circle);
- line segments and every stroke along a curve -> a rotated capsule per segment,
  with curves flattened in MoonBit first;
- flat ellipses (clouds, ground shadows) -> polygon chords sized to the radius;
- translucent strokes keep the vector path so overlapping capsules do not
  double-blend at joints.

That is a 9x payload reduction and an 8x frame-rate gain with no visible change
to the scene. The remaining ~400 KB/frame is the pelican's bezier fills (bill,
pouch, cap, wing, tail, toes) plus clouds/trees/hills, which cannot be reduced
further without changing the artwork.

## Fix taken upstream

Recommendations 1 and 2 are implemented in MoUI as
[MoUI#7](https://github.com/wzzc-dev/MoUI/pull/7), branch
`fix/web-path-mesh-transfer`. The adapter now uploads a tessellated mesh once
and keeps it behind a host handle, keyed by structural `PathSpec` equality in a
bounded 256-entry LRU, so a repeated path costs one two-scalar call
(`draw_path_mesh_cached`) instead of re-serializing.
The old single-shot `draw_path_mesh` import is gone; the host side is
`upload_path_mesh` / `draw_path_mesh_cached` / `release_path_mesh`, implemented
in *both* providers (`runtime.js` and `canvas2d_runtime.js`).

Measured here, 4 interleaved rounds per variant, same machine, one fresh browser
profile per sample:

| scene | mainline | with the fix | note |
| --- | --- | --- | --- |
| static geometry (HEAD app, paths repeated) | 2.58-2.64 fps, median 417-433 ms | 3.61-3.77 fps, median 283 ms | the case the cache is for: identical geometry every frame |
| animated scene (workaround app) | 19.75-20.34 fps, median 50 ms | 22.69-23.95 fps | ~10% of draws hit; median unchanged, the gain is headroom |
| same fix, cache limit forced to 1 | — | 20.00-20.42 fps | equals baseline: splitting upload from draw is free, the retained handles are the whole gain |

wasm-gc artifact grew 481,110 -> 483,663 bytes. The Canvas2D fallback was
checked in the browser with `forceUnavailable` (3,841 cached draws/s, 68,133
fills/s).

### Building against the vendored source

`vendor/MoUI` is a git submodule pinned to mainline. `moon.work` is *local and
untracked*: it adds `./vendor/MoUI/moui` and `./vendor/MoUI/moui_web_renderer`
as workspace members so `moon build`/`moon test` compile the app against the
vendored source instead of `.mooncakes/wzzc-dev/moui*`, and
`scripts/package-web-app.mjs` reads it to copy the matching `runtime.js` /
`canvas2d_runtime.js` into `dist/pages`. It is not committed because
`.github/workflows/deploy.yml` does not check submodules; delete `moon.work` to
build the published registry version again. MoUI's own nested submodules
(`window`, `moui_studio`, `examples/momark`) need
`git -C vendor/MoUI submodule update --init --depth 1 window moui_studio examples/momark`
before MoUI's `scripts/check.sh` can resolve its workspace.
