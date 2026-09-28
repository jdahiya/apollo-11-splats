// Camera stations (fixed viewpoints), smooth flights between them, and the guided tour.
import { catmullRom, easeInOutCubic, lerp3, type Vec3 } from '../util/math';
import type { Camera } from './camera';

/** [eye, look-at] pairs. x is east, z south; Eagle stands at the origin facing west. */
export const VIEWS = {
  overview: [[-34, 22, -40], [0, 1.2, 2]],
  eagle: [[-10, 2.4, -12], [0, 3.1, 0]],
  // Where the TV camera on Eagle's equipment bay watched Armstrong come down the ladder.
  ladder: [[-1.9, 1.6, 1.3], [-3.9, 1.0, -0.1]],
  // The TV camera on its tripod, about 20 m north, looking back at Eagle.
  tv: [[-6, 1.36, -20], [-1.5, 1.6, 0]],
  // Armstrong's view of Aldrin saluting the flag.
  flag: [[-13.6, 1.65, -13.4], [-8.6, 1.25, -7.4]],
  science: [[-9, 2.4, 22], [-4.5, 0.4, 15.5]],
  crater: [[46, 2.6, 7], [0, 2.2, 0]],
  earth: [[7.5, 1.4, 0.9], [1.34, 9.28, 0.9]],
} satisfies Record<string, [Vec3, Vec3]>;

export type ViewName = keyof typeof VIEWS;

export interface Leg {
  eye: Vec3;
  look: Vec3;
  seconds: number;
}

/** Round the site: in over the plain, up to Eagle, down the ladder, out to the flag and the experiments, and up at Earth. */
export const TOUR: readonly Leg[] = [
  { eye: [-34, 22, -40], look: [0, 1.2, 2], seconds: 5 },
  { eye: [-16, 5, -18], look: [0, 3, 0], seconds: 5 },
  { eye: [-8.5, 2.2, -3.5], look: [-4, 1.4, 0], seconds: 4.5 },
  { eye: [-6, 1.5, -18], look: [-1.5, 1.6, 0], seconds: 4.5 },
  { eye: [-13.6, 1.65, -13.4], look: [-8.6, 1.25, -7.4], seconds: 5 },
  { eye: [-12, 3, 8], look: [-4.5, 0.6, 15.5], seconds: 4.5 },
  { eye: [-9, 2.4, 22], look: [-4.5, 0.4, 15.5], seconds: 4.5 },
  { eye: [20, 4, 16], look: [0, 2.2, 0], seconds: 5 },
  { eye: [7.5, 1.4, 0.9], look: [1.34, 9.28, 0.9], seconds: 0 },
];

interface Transition {
  e0: Vec3;
  l0: Vec3;
  e1: Vec3;
  l1: Vec3;
  t0: number;
  ms: number;
}

export type FlightState = 'idle' | 'moving' | 'ended';

export class Flight {
  private transition: Transition | null = null;
  private tourStart = -1;

  get touring(): boolean {
    return this.tourStart >= 0;
  }

  goTo(cam: Camera, name: ViewName, now: number): void {
    this.tourStart = -1;
    const [e1, l1] = VIEWS[name];
    const e0 = cam.eye(), l0: Vec3 = [...cam.target];
    const distance = Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]);
    this.transition = { e0, l0, e1, l1, t0: now, ms: Math.min(3.4, Math.max(1.2, distance / 70)) * 1000 };
  }

  startTour(now: number): void {
    this.transition = null;
    this.tourStart = now;
  }

  stop(): void {
    this.transition = null;
    this.tourStart = -1;
  }

  update(cam: Camera, now: number): FlightState {
    if (this.tourStart >= 0) return this.tourStep(cam, now);
    const tr = this.transition;
    if (!tr) return 'idle';
    const t = Math.min(1, (now - tr.t0) / tr.ms), s = easeInOutCubic(t);
    cam.setEyeLook(lerp3(tr.e0, tr.e1, s), lerp3(tr.l0, tr.l1, s));
    if (t >= 1) this.transition = null;
    return 'moving';
  }

  private tourStep(cam: Camera, now: number): FlightState {
    let t = (now - this.tourStart) / 1000, i = 0;
    while (i < TOUR.length - 1 && t > TOUR[i]!.seconds) {
      t -= TOUR[i]!.seconds;
      i++;
    }
    if (i >= TOUR.length - 1) {
      this.tourStart = -1;
      const last = TOUR[TOUR.length - 1]!;
      cam.setEyeLook(last.eye, last.look);
      return 'ended';
    }
    const u = t / TOUR[i]!.seconds;
    const leg = (j: number): Leg => TOUR[Math.min(Math.max(j, 0), TOUR.length - 1)]!;
    cam.setEyeLook(
      catmullRom(leg(i - 1).eye, leg(i).eye, leg(i + 1).eye, leg(i + 2).eye, u),
      catmullRom(leg(i - 1).look, leg(i).look, leg(i + 1).look, leg(i + 2).look, u),
    );
    return 'moving';
  }
}
