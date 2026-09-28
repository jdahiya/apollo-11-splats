// The sun over Tranquility Base. Apollo 11 landed early in the lunar morning with the sun low in
// the east: about 11° up at touchdown and about 14° by the end of the moonwalk. With no air, the
// sunlight is white and hard, and nothing lights the shadows but the ground.
import { PI, type Vec3 } from '../util/math';

export interface SunState {
  /** Degrees above the eastern horizon. */
  elevation: number;
  /** Unit vector toward the sun (x east, y up, z south). */
  dir: Vec3;
  color: Vec3;
  /** Light from rays that escape into space: none. */
  sky: Vec3;
}

/** Degrees from north through east. */
const AZIMUTH = 89;

/** Elevation during the moonwalk. */
export const EVA_ELEVATION = 14;

export function sunAt(elevation: number): SunState {
  const el = (elevation * PI) / 180, az = (AZIMUTH * PI) / 180;
  const dir: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  return { elevation, dir, color: [2.45, 2.42, 2.36], sky: [0, 0, 0] };
}

export function sunLabel(elevation: number): string {
  return `${Math.round(elevation)}°`;
}
