// Messages between the page and the sort worker.

/**
 * distance: by distance from the camera (the glTF KHR_gaussian_splatting default); turning the
 *           camera doesn't change the order, so it only re-sorts when the camera moves.
 * depth:    by view-space depth, as the original 3DGS rasteriser does.
 */
export type SortMode = 'distance' | 'depth';

/** A range of splats that moves as one rigid body: start, end and a column-major 4×4 transform. */
export interface Rigid {
  start: number;
  end: number;
  m: number[];
}

export type SortRequest =
  | { type: 'boot'; wasmUrl: string }
  | { type: 'init'; n: number; pos: Float32Array }
  | { type: 'sort'; mode: SortMode; row: [number, number, number, number]; eye: [number, number, number]; gen: number; rigid: Rigid | null };

export type SortReply =
  | { type: 'booted'; wasm: boolean }
  | { type: 'sorted'; order: Uint32Array; ms: number; n: number; gen: number };
