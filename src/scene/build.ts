// Generates the whole landing site into the shared splat store, in layers by splat index (the
// renderer and the lighting treat each layer differently): the ground; rocks and Earth; the
// moonwalk's things; Eagle; and the dust its engine blows out during the landing.
import { PI } from '../util/math';
import { reseed, rng } from '../util/random';
import type { Solids } from '../render/voxels';
import { S, resetReflections } from '../splats/primitives';
import { resetAsset, store } from '../splats/store';
import { EVA_ELEVATION, sunAt } from '../world/sun';
import { buildEarth } from './earth';
import { EAGLE_BOX, buildEagle, insideEagle } from './eagle';
import { buildMoonwalk } from './moonwalk';
import { buildGround, buildRocks, groundAt, makeCraters } from './terrain';

export interface SceneInfo {
  count: number;
  /** Ground end, moonwalk start, Eagle start, Eagle end; the dust follows. */
  layers: [number, number, number, number];
  /** Eagle's box, which the lighting of everything else leaves out. */
  eagleBox: [number, number, number, number, number, number];
  /** Solid matter for the voxel grids. */
  solids: Solids;
}

/** Dust for the landing. Only the base positions are stored (for sorting and lighting); the shader moves every splat. */
function buildDust(k: number): void {
  reseed(5);
  const n = Math.round(9000 / k);
  for (let i = 0; i < n; i++) {
    const a = rng() * 2 * PI, d = 1.5 + rng() * 28;
    S(Math.cos(a) * d, 0.12, Math.sin(a) * d, 1, 0, 0, 0, 0, 1, 0.5, 0.2, 0.05, 0.64, 0.61, 0.56, 0.34);
  }
}

/** density scales splat count: 1 is the default desktop setting. */
export function buildScene(density: number): SceneInfo {
  store.count = 0;
  resetAsset();
  resetReflections();
  const k = 1 / Math.sqrt(density);
  makeCraters();
  buildGround(k);
  const groundEnd = store.count;
  buildRocks(k);
  buildEarth(sunAt(EVA_ELEVATION).dir, k);
  const evaStart = store.count;
  buildMoonwalk();
  const eagleStart = store.count;
  buildEagle(k);
  const eagleEnd = store.count;
  buildDust(k);
  return {
    count: store.count,
    layers: [groundEnd, evaStart, eagleStart, eagleEnd],
    eagleBox: EAGLE_BOX,
    solids: { ground: groundAt, inside: insideEagle },
  };
}
