# Apollo 11 Splats

A real-time 3D Gaussian splat model of Tranquility Base, the Apollo 11 landing site, with a replay of Eagle's landing. It's lit by progressive path tracing and runs in any browser with WebGL2, from phones to desktops.

**Live demo:** https://jdahiya.github.io/apollo-11-splats/

- **Eagle:** the lunar module as it stood on 20 July 1969. The octagonal descent stage is wrapped in crinkled gold and black foil, and every crinkle tips its splats' normal its own way, so the foil glints as you move. The four legs have their struts and footpads, and the front leg has the ladder, the porch and the plaque. The descent engine bell sits underneath, and the grey-and-black ascent stage above has its triangular windows, hatch, propellant tanks, thruster quads and antennas.
- **The moonwalk:** the flag, rippled the way it hung because its crossbar never fully extended. Aldrin salutes beside it, and Armstrong stands off to one side with the camera. There's the seismometer with its solar panels, the laser reflector tilted toward Earth, the solar-wind foil turned to the sun, and the TV camera on its tripod with its cable running back to Eagle. Footprints follow the routes they walked, including one crisp bootprint.
- **The site:** grey regolith pocked with craters of every size, with Little West crater 60 m east of Eagle and West crater, which Eagle flew over, further out. Rocks are scattered everywhere, and the ground under Eagle is streaked by its engine. The Moon's curvature brings the horizon close.
- **The sky:** black, with the sun's disc and faint stars. Earth hangs about 66° up in the west, a little over half lit.
- **Landing:** replays the descent. Eagle comes in from 460 m east and 150 m up, pitched back to brake, then straightens and settles while its engine blows a sheet of dust out across the ground. Then the replay skips ahead six and a half hours to the moonwalk.
- **Sun:** the slider moves the sun from lunar dawn toward noon. Apollo 11 landed with it about 11° up in the east; by the end of the moonwalk it was about 14°.

The model is procedural. It's generated at load time from the mission's records and NASA's footage, not scanned. You can also open a trained `.ply`, `.splat`, `.spz` or `.glb` capture in the same viewer.

## Built from

- NASA's [Apollo 11 HD videos](https://www.nasa.gov/history/apollo-11-hd-videos/), used as visual reference. The TV camera on Eagle's equipment bay filmed the ladder, and the one set up about 20 m north filmed the flag raising. Those clips fix the site's layout and the look of Eagle, the suits and the ground in low sunlight. The **Ladder** and **TV camera** stations frame the scene the way those cameras did. `node tools/fetch-reference.mjs` downloads the clips into `reference/`, which is git-ignored and isn't part of the site.
- Published mission facts: the landing site's coordinates, the sun's elevation, and the lunar module's dimensions, colours and layout.

## How it works

It runs on the same engine as [Rogers Place Splats](https://github.com/jdahiya/rogers-place-splats):
- The splat renderer follows the 3D Gaussian Splatting reference and `KHR_gaussian_splatting`, with the tangential projection from OpenUSD and RealityKit as the default.
- A WebAssembly depth sort runs in a worker.
- Path-traced lighting uses voxel radiance caches.
- An adaptive governor holds 60 fps or more.

On top of that:

| Piece | Where | What it does |
| --- | --- | --- |
| Lunar light | `src/render/shaders/trace.glsl`, `sky.glsl` | No sky light: rays that escape see black space, so shadows are lit only by sunlight thrown back off the ground and off Eagle. The ground is lit one-sided, so slopes turned away from a low sun fall dark. |
| Opposition surge | `src/render/shaders/splat.vert` | Lunar soil throws light back toward the sun. It's brightest looking straight down-sun, round your own shadow, and darker looking into the sun. |
| Layers | `src/scene/build.ts` | The scene is built in layers by splat index: the ground, rocks and Earth, the moonwalk's things, Eagle, and the landing dust. The shader and the lighting treat each one differently. |
| Landing | `src/world/landing.ts` | During the replay, Eagle's splats move as one rigid body. The vertex shader transforms them, and the sort worker moves their positions before each sort, so the order stays right. The dust is animated entirely in the shader. |
| Eagle's shadow | `splat.vert` | The baked lighting of everything else leaves Eagle out. Its shadow is traced live against a simple stand-in for its shape, wherever it is, so the shadow moves with it during the landing. |
| Reflections | `splat.vert` | The foil, the visors, the solar-wind sheet and the solar panels reflect the black sky and the bright ground, weighted by Fresnel. |

## Stations and links

**Overview**, **Eagle**, **Little West** and **Earth** show the site. **Ladder**, **TV camera**, **Flag** and **Experiments** show the moonwalk. **Play tour** flies round them all.

- `?eye=x,y,z&look=x,y,z` opens at a camera position (metres, y up, x east, z south, Eagle at the origin).
- `?sun=degrees` sets the sun's height.
- `?capture=<url>` opens a capture.

| Input | Action |
| --- | --- |
| Drag | Orbit |
| Right-drag / Shift-drag | Pan |
| Scroll | Zoom; keep scrolling to fly forward |
| W A S D / arrows | Move |
| Q / E | Down / up |
| Shift | Move faster |
| Pinch (touch) | Zoom and pan |

## Performance

60 fps is the floor, and the display's refresh rate is the ceiling. To reach a faster display's refresh rate the governor only trades the ray budget. Render scale, fine splats and bloom only give way below 60 fps, one step at a time, and they fade rather than pop. Rendering stops when nothing on screen changes. Phones start at a lighter density with coarser voxels. The **Performance** panel shows frame times, GPU time, and estimated power and battery drain.

## Development

Requires Node 20 or newer.

```bash
npm install
npm run build      # AssemblyScript -> dist/sort.wasm, TypeScript -> dist/main.js
npm run serve      # http://localhost:8080
```

`npm run dev` rebuilds on change, `npm run typecheck` runs `tsc`, and `npm test` checks the WebAssembly sort and the capture importers.

```
assembly/sort.ts        WebAssembly depth sort (AssemblyScript)
src/main.ts             entry point: frame loop and UI wiring
src/scene/              the ground and craters, Eagle, the moonwalk, Earth
src/world/              the sun, and the landing replay
src/render/             WebGL2 renderer, voxel grids, path-traced lighting, GLSL shaders
src/splats/             splat storage, shape primitives, capture import
src/sort/               sort worker and its main-thread client
src/camera/             orbit camera, input, stations and the tour
src/perf/               governor, GPU timer, power model, stats, charts, panel
tools/                  build script, dev server, tests, reference download
```

Pushing to `main` builds and deploys the site to GitHub Pages (`.github/workflows/pages.yml`).

## Not affiliated

This is an independent project. It is not affiliated with or endorsed by NASA. NASA's footage is used as modelling reference only and isn't included in the site, and the site uses no NASA insignia.
