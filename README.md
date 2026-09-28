# Apollo 11 Splats

A 3D Gaussian splat model of Tranquility Base, the Apollo 11 landing site, trained from the photographs Armstrong and Aldrin took there on 20 July 1969. It runs in any browser with WebGL2, from phones to desktops.

**Live demo:** https://jdahiya.github.io/apollo-11-splats/

Nothing in the scene is modelled or painted by hand. Every colour comes from the Hasselblad film: the model is 3D Gaussian Splatting (Kerbl et al. 2023), trained on 60 of the mission's colour photographs, with each photo's camera position recovered by structure from motion. What you see is Eagle's gold and black foil, the ladder, the footpads, the flag and the trampled regolith as the film recorded them, in the low morning sunlight of the moonwalk.

- **Photo stations** stand exactly where a photograph was taken, with the Hasselblad's field of view. **Compare with photo** lays the original frame over the view, turned to the camera's tilt, so you can check the model against the film.
- **Play tour** flies round the stations, pausing at each.
- **Detail** chooses how many splats are drawn, most important first: Light (the default on phones), Standard or Full (the default elsewhere).
- **Open capture** loads any other `.ply`, `.splat`, `.spz` or `.glb` splat capture into the same viewer.

## Built from

- NASA's Apollo 11 Hasselblad photographs, magazine 40 (AS11-40-5844 to 5969), the colour magazine used on the moonwalk, in the high-resolution scans published by the [Apollo Lunar Surface Journal](https://apollojournals.org/alsj/a11/images11.html). `node tools/fetch-photos.mjs` downloads them into `reference/`, which is git-ignored.
- NASA's [Apollo 11 HD videos](https://www.nasa.gov/history/apollo-11-hd-videos/), as visual reference. They can't be trained on: the TV and film cameras were fixed in place, so the footage has no parallax to recover depth from, and the TV pictures are black and white. `node tools/fetch-reference.mjs` downloads them.

## How it was made

1. **Masks.** A 5 × 5 grid of fine crosses (the réseau) is etched on every frame at the same place; left in, they'd train as objects floating in front of every camera. `tools/reseau-masks.ps1` finds the grid in each scan and masks it. Things that moved between photos are masked out of training too: Aldrin, the photographer's shadow, the core tube and lens flares, traced by hand in `tools/transients.json` and painted in by `tools/paint-transients.ps1`. So Aldrin doesn't leave ghosts: the model fills in the ladder behind him from the photos where he wasn't in the way.
2. **Camera poses.** [COLMAP](https://colmap.github.io/) 4.2 recovers where each photo was taken. The lens is known: a 60 mm Biogon, which is exactly six réseau pitches (the crosses are 10 mm apart on the film), and the principal point is the centre cross. Features are SIFT with affine shape and domain-size pooling, matched exhaustively. A second, looser matching pass adds only pairs that also fit the calibrated (essential-matrix) model. Of the 123 frames, 82 end up in one reconstruction; the rest (close-ups of bootprints, panoramas out by the craters, the shot of Earth) share too little with it. Then every camera is checked against what the photographers could have done: the Hasselblad was chest-mounted, so surface photos must sit about 1.4 m above the ground, and the frames shot through Eagle's window must sit about 5 m up (they do). The 22 frames placed anywhere else were dropped.
3. **Training.** [Brush](https://github.com/ArthurBrussee/brush) trains the splats on the 60 remaining photos at full scan resolution: 30,000 steps on an RTX 4090.
4. **Site frame.** `tools/align-site.mjs` turns the reconstruction's arbitrary frame into metres, with y up, x east, z south and Eagle's base at the origin. Up is the ground plane, scale comes from the 1.4 m camera height, and Eagle's position from its gold foil. North comes from the sun: lens flares and shadows in several photos put it at azimuth 89°, just north of east, and with that heading Eagle's long shadow falls over the places where the photos show the photographer standing in it.
5. **For the web.** `tools/ply-to-spz.mjs` moves the trained splats into the site frame, rotating their view-dependent colour to match, and writes Niantic's compressed SPZ format. It ranks the splats by how much each one covered in the photos (opacity times its largest footprint in any training frame, in pixels), keeps the top two thirds and orders them so each detail level draws the most important first. The Light level is also written as a file of its own, so phones download well under half as much. `tools/stations.mjs` turns the chosen photos' camera poses into the stations, and `tools/station-photos.ps1` exports the frames for the compare overlay.

### What it can't show

Only what the photographs saw is in the model, and it's sharpest near where they were taken. The far sides of Eagle, the experiments south of it and Little West crater were photographed from places whose photos couldn't be tied into the same reconstruction, so they're missing or soft. Fly away from the stations and the splats get patchy, with streaks where the ground was only ever seen at a glancing angle. The model is a record of the film, not a rebuild of the site.

## How it works

- The renderer follows the 3D Gaussian Splatting reference and `KHR_gaussian_splatting`: EWA projection with a 0.3-pixel dilation, alpha capped at 0.99 and cut off under 1/255, and view-dependent colour from spherical harmonics. The tangential projection from OpenUSD and RealityKit is in the Performance panel too.
- A WebAssembly counting sort orders the splats back to front in a worker, by camera distance (the glTF default) or view depth (the original 3DGS).
- An adaptive governor holds 60 fps or more. Render scale and sub-pixel splats only give way below 60 fps, one step at a time, and fade rather than pop. Rendering stops when nothing on screen changes.
- The **Performance** panel shows frame times, GPU time, and estimated power and battery drain.

| Link | Opens |
| --- | --- |
| `?station=name` | at a station (`ladder`, `flag`, …) |
| `?eye=x,y,z&look=x,y,z` | at a camera position (site metres: y up, x east, z south, Eagle at the origin) |
| `?capture=<url>` | another capture |

| Input | Action |
| --- | --- |
| Drag | Orbit |
| Right-drag / Shift-drag | Pan |
| Scroll | Zoom; keep scrolling to fly forward |
| W A S D / arrows | Move |
| Q / E | Down / up |
| Shift | Move faster |
| Pinch (touch) | Zoom and pan |

## Development

Requires Node 22.15 or newer (the SPZ encoder uses zstd from `node:zlib`).

```bash
npm install
npm run build      # AssemblyScript -> dist/sort.wasm, TypeScript -> dist/main.js, assets copied
npm run serve      # http://localhost:8080
```

`npm run dev` rebuilds on change, `npm run typecheck` runs `tsc`, and `npm test` checks the WebAssembly sort, the capture importers and the SPZ encoder.

```
assembly/sort.ts        WebAssembly depth sort (AssemblyScript)
assets/                 the trained model (SPZ), its detail levels, and the station photographs
src/main.ts             entry point: loading, frame loop and interface
src/render/             WebGL2 renderer and GLSL shaders
src/splats/             splat storage and capture importers
src/sort/               sort worker and its main-thread client
src/camera/             orbit camera, input, the photo stations and the tour
src/perf/               governor, GPU timer, power model, stats, charts, panel
tools/                  build, dev server, tests, and the training pipeline's scripts
```

Pushing to `main` builds and deploys the site to GitHub Pages (`.github/workflows/pages.yml`).

## Not affiliated

This is an independent project. It is not affiliated with or endorsed by NASA. The photographs it's trained on, and the frames shown in the compare overlay, are NASA's and in the public domain.
