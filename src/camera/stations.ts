// Camera stations (fixed viewpoints), and smooth flights between them.
// Photo stations stand where a Hasselblad photograph was taken: the camera's position, aim and
// field of view come from the structure-from-motion solve the model was trained on, in site
// metres (x east, y up, z south, Eagle's base at the origin).
import { easeInOutCubic, lerp3, type Vec3 } from '../util/math';
import type { Camera } from './camera';

export interface Station {
  eye: Vec3;
  look: Vec3;
  /** Vertical field of view in degrees; photo stations use the photograph's. */
  fov?: number;
  caption: string;
  /** The photograph taken from here, and how far it's rolled from level (degrees, clockwise). */
  photo?: { id: string; roll: number };
}

export const STATIONS = {
  // STATIONS:BEGIN (written by tools/stations.mjs)
  ladder: {
    eye: [-4.25, 1.38, 4.33], look: [-0.43, 0.69, -4.89], fov: 45.9,
    caption: 'AS11-40-5869 · Aldrin climbs down to the surface. He moved from photo to photo, so he was masked out of training; the ladder behind him comes from the other frames.',
    photo: { id: 'AS11-40-5869', roll: 5.6 },
  },
  hatch: {
    eye: [-3.56, 1.61, 3.64], look: [2.21, 4.86, -3.85], fov: 45.6,
    caption: 'AS11-40-5863 · Aldrin backs out of the hatch onto the porch, the start of his climb down.',
    photo: { id: 'AS11-40-5863', roll: 0.1 },
  },
  window: {
    eye: [0.74, 5.01, 0.29], look: [-3.83, 4.24, 9.15], fov: 46.4,
    caption: 'AS11-40-5847 · Taken through one of Eagle’s windows, about 5 m up, before the moonwalk.',
    photo: { id: 'AS11-40-5847', roll: 2.2 },
  },
  eagle: {
    eye: [-0.62, 1.43, -12.95], look: [0.02, 0.41, -3.02], fov: 46,
    caption: 'AS11-40-5915 · Eagle’s descent stage from 13 m north: its gold and black foil and two of its four footpads.',
    photo: { id: 'AS11-40-5915', roll: 0.9 },
  },
  wind: {
    eye: [-7.81, 1.42, -13.9], look: [-0.23, 0.85, -7.4], fov: 46.6,
    caption: 'AS11-40-5872 · Aldrin by the solar-wind collector, a sheet of foil set out to catch particles streaming from the Sun.',
    photo: { id: 'AS11-40-5872', roll: -0.2 },
  },
  flag: {
    eye: [-6.52, 1.4, -14.94], look: [-5.92, 0.48, -5], fov: 46.3,
    caption: 'AS11-40-5875 · Aldrin beside the flag. Its crossbar never fully extended, so it hung rippled, as it does here.',
    photo: { id: 'AS11-40-5875', roll: 3.6 },
  },
  shadow: {
    eye: [-12.64, 1.67, 1.3], look: [-4.44, -0.46, -4.02], fov: 46.4,
    caption: 'AS11-40-5886 · From 13 m west of Eagle, inside its long shadow, with the flag and the solar-wind collector beyond.',
    photo: { id: 'AS11-40-5886', roll: 0.1 },
  },
  footpad: {
    eye: [-3.46, 1.29, -3.04], look: [5.06, -0.85, -7.83], fov: 46.3,
    caption: 'AS11-40-5902 · One of Eagle’s footpads, and the ground the astronauts trampled round it.',
    photo: { id: 'AS11-40-5902', roll: 2.7 },
  },
  portrait: {
    eye: [-0.91, 1.27, -4.81], look: [7.35, -1.58, -9.66], fov: 46.2,
    caption: 'AS11-40-5903 · Where Armstrong stood for his portrait of Aldrin. Aldrin is masked out, and no other photo saw the ground behind him clearly, so that patch is soft; the footprints round it are from the film.',
    photo: { id: 'AS11-40-5903', roll: 4.3 },
  },
  // STATIONS:END
} satisfies Record<string, Station>;

export type StationName = keyof typeof STATIONS;

/** The tour visits these in turn, pausing at each. */
export const TOUR: readonly StationName[] = [
  // TOUR:BEGIN (written by tools/stations.mjs)
  'ladder', 'hatch', 'eagle', 'wind', 'flag', 'shadow', 'footpad', 'portrait',
  // TOUR:END
];

/** Flights that would pass this close to Eagle's axis (metres) bend round it instead. */
const KEEP_OUT = 7;

interface Transition {
  e0: Vec3;
  l0: Vec3;
  e1: Vec3;
  l1: Vec3;
  /** Control point of a quadratic Bézier for the eye, or null to fly straight. */
  bend: Vec3 | null;
  t0: number;
  ms: number;
}

export class Flight {
  private transition: Transition | null = null;

  goTo(cam: Camera, name: StationName, now: number): void {
    const { eye: e1, look: l1 } = STATIONS[name] as Station;
    const e0 = cam.eye(), l0: Vec3 = [...cam.target];
    // Where the straight path passes closest to Eagle's axis, on the ground plane.
    const dx = e1[0] - e0[0], dz = e1[2] - e0[2], len = Math.hypot(dx, dz) || 1;
    const t = Math.min(1, Math.max(0, -(e0[0] * dx + e0[2] * dz) / (len * len)));
    const cx = e0[0] + dx * t, cz = e0[2] + dz * t, r = Math.hypot(cx, cz);
    let bend: Vec3 | null = null;
    if (r < KEEP_OUT && r < Math.min(Math.hypot(e0[0], e0[2]), Math.hypot(e1[0], e1[2])) - 1) {
      // Out from Eagle through that point (or square to the path if it runs straight through),
      // chosen so the curve's midpoint clears the keep-out circle: B(½) = (e0 + 2c + e1) / 4.
      const ux = r > 0.01 ? cx / r : -dz / len, uz = r > 0.01 ? cz / r : dx / len;
      const safe = KEEP_OUT + 2, mid = lerp3(e0, e1, 0.5);
      bend = [2 * ux * safe - mid[0], 2 * (Math.max(e0[1], e1[1]) + 1) - mid[1], 2 * uz * safe - mid[2]];
    }
    const distance = Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]) + (bend ? 2 * KEEP_OUT : 0);
    // Into or out of Eagle's cabin there's no clear way through its walls: cut straight there.
    const inCabin = (p: Vec3): boolean => Math.hypot(p[0], p[2]) < 2 && p[1] > 3;
    const ms = inCabin(e0) !== inCabin(e1) ? 1 : Math.min(4.5, Math.max(1.4, distance / 7)) * 1000;
    this.transition = { e0, l0, e1, l1, bend, t0: now, ms };
  }

  stop(): void {
    this.transition = null;
  }

  /** Moves the camera along the current flight; true while one is under way. */
  update(cam: Camera, now: number): boolean {
    const tr = this.transition;
    if (!tr) return false;
    const t = Math.min(1, (now - tr.t0) / tr.ms), s = easeInOutCubic(t);
    const eye = tr.bend ? lerp3(lerp3(tr.e0, tr.bend, s), lerp3(tr.bend, tr.e1, s), s) : lerp3(tr.e0, tr.e1, s);
    cam.setEyeLook(eye, lerp3(tr.l0, tr.l1, s));
    if (t >= 1) this.transition = null;
    return true;
  }
}
