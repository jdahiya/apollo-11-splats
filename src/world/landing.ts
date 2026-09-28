// The landing replay: Eagle comes in low from the east, pitched back to brake, straightens up and
// settles onto the site while the engine blows a sheet of dust out across the ground. Then the
// replay skips ahead six and a half hours to the moonwalk.
import { PI, clamp, lerp3, smoothstep, type Vec3 } from '../util/math';

export const MAX_LIGHTS = 16;

/** Light list in the layout the lighting shader expects. The Moon has none but the sun. */
export class LightRig {
  count = 0;
  /** xyz + intensity */
  readonly pos = new Float32Array(MAX_LIGHTS * 4);
  readonly color = new Float32Array(MAX_LIGHTS * 3);
  /** spot direction xyz + cos(cone); w below -1 marks an omni light */
  readonly dir = new Float32Array(MAX_LIGHTS * 4);
  ambient: Vec3 = [0, 0, 0];
}

export interface LandingFrame {
  /** Eagle's rigid transform (column-major 4×4) and its inverse. */
  eagle: Float32Array;
  eagleInv: Float32Array;
  /** Height of Eagle's footpads above the site, metres. */
  altitude: number;
  /** 0..1 */
  dust: number;
  engine: number;
  eva: number;
}

/** Seconds from the start of the replay to touchdown, and to its end. */
export const TOUCHDOWN = 26;
const END = 33;

/** Eagle's rigid transform: moved by pos from its landed position and pitched (radians) so its top leans east. */
function rigid(pos: Vec3, pitch: number): { m: Float32Array; inv: Float32Array } {
  const c = Math.cos(pitch), s = Math.sin(pitch), pivot = 3; // rotate about a point 3 m up
  const t0 = pos[0] - pivot * s, t1 = pos[1] + pivot - pivot * c, t2 = pos[2];
  const m = new Float32Array([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, t0, t1, t2, 1]);
  const inv = new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, -(c * t0 - s * t1), -(s * t0 + c * t1), -t2, 1]);
  return { m, inv };
}

const rest = rigid([0, 0, 0], 0);
const REST: LandingFrame = { eagle: rest.m, eagleInv: rest.inv, altitude: 0, dust: 0, engine: 0, eva: 1 };

export class Landing {
  active = false;
  private start = 0;

  trigger(now: number): void {
    this.active = true;
    this.start = now;
  }

  /** Seconds into the replay. */
  time(now: number): number {
    return (now - this.start) / 1000;
  }

  /** Where everything is at this moment; the landed scene when the replay isn't running. */
  frame(now: number): LandingFrame {
    if (!this.active) return REST;
    const t = this.time(now);
    if (t >= END) {
      this.active = false;
      return REST;
    }
    const pos = this.position(t), s = clamp(t / TOUCHDOWN, 0, 1);
    const { m, inv } = rigid(pos, ((32 * PI) / 180) * (1 - smoothstep(0.55, 0.93, s)));
    const engineOn = t < TOUCHDOWN + 0.8;
    return {
      eagle: m,
      eagleInv: inv,
      altitude: pos[1],
      dust: engineOn ? smoothstep(30, 5, pos[1]) : 0,
      engine: engineOn ? 1 : 0,
      eva: smoothstep(TOUCHDOWN + 3, TOUCHDOWN + 6, t),
    };
  }

  /** Eagle's offset from where it lands: from 460 m east and 150 m up, both easing to zero. */
  private position(t: number): Vec3 {
    const rem = 1 - clamp(t / TOUCHDOWN, 0, 1);
    return [460 * rem * rem, 150 * Math.pow(rem, 1.6), 25 * rem * rem];
  }

  /** A chase camera that follows Eagle down and swings round to watch it touch down. */
  camera(now: number): [Vec3, Vec3] {
    const t = this.time(now), p = this.position(t);
    const followEye: Vec3 = [p[0] - 14, p[1] + 9, p[2] - 50], followLook: Vec3 = [p[0], p[1] + 3, p[2]];
    const w = smoothstep(10, 23, t);
    return [lerp3(followEye, [-9, 3.4, -37], w), lerp3(followLook, [0, 2.8, 0], w)];
  }
}
