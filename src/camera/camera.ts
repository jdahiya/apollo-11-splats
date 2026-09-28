// Orbit camera: a target point, yaw, pitch and distance. Also produces the matrices for a frame.
import { clamp, type Vec3 } from '../util/math';

export interface View {
  view: Float32Array;
  proj: Float32Array;
  eye: Vec3;
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalf: number;
  aspect: number;
  /** Focal length in pixels for the render target's height. */
  focal: number;
  /** The view matrix's z row: view-space depth = row · (x, y, z, 1). Drives the sort. */
  depthRow: [number, number, number, number];
}

const NEAR = 0.1;
const FAR = 4000;

export class Camera {
  target: Vec3 = [0, 10, 0];
  yaw = 0;
  pitch = 0;
  dist = 100;
  fov = Math.PI / 3;

  forward(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [cp * Math.cos(this.yaw), Math.sin(this.pitch), cp * Math.sin(this.yaw)];
  }

  eye(): Vec3 {
    const f = this.forward();
    return [this.target[0] - f[0] * this.dist, this.target[1] - f[1] * this.dist, this.target[2] - f[2] * this.dist];
  }

  setEyeLook(eye: Vec3, look: Vec3): void {
    const d: Vec3 = [look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]];
    const L = Math.hypot(...d) || 1;
    this.dist = L;
    this.yaw = Math.atan2(d[2], d[0]);
    this.pitch = Math.asin(clamp(d[1] / L, -0.999, 0.999));
    this.target = [look[0], look[1], look[2]];
  }

  orbit(dx: number, dy: number): void {
    this.yaw += dx * 0.005;
    this.pitch = clamp(this.pitch - dy * 0.005, -1.52, 1.52);
  }

  /** Moves the target in the view plane by a pixel delta. */
  pan(dx: number, dy: number, viewportHeight: number): void {
    const { right, up } = this.basis();
    const s = (2 * this.dist * Math.tan(this.fov / 2)) / Math.max(1, viewportHeight);
    for (let i = 0; i < 3; i++) this.target[i]! += (-dx * right[i]! + dy * up[i]!) * s;
  }

  /** Zooms toward the target; once close, keeps flying forward instead. */
  zoom(delta: number): void {
    if (delta < 0 && this.dist <= 3.01) {
      const f = this.forward(), step = Math.min(-delta * 0.01, 4);
      for (let i = 0; i < 3; i++) this.target[i]! += f[i]! * step;
      this.dist = 3;
    } else {
      this.dist = clamp(this.dist * Math.exp(delta * 0.0012), 3, 1500);
    }
  }

  /** Moves the target along the ground plane (forward, right) and vertically. */
  move(forward: number, right: number, up: number): void {
    const f = this.forward(), fl = Math.hypot(f[0], f[2]) || 1;
    const fx = f[0] / fl, fz = f[2] / fl;
    this.target[0] += fx * forward - fz * right;
    this.target[1] += up;
    this.target[2] += fz * forward + fx * right;
  }

  basis(): { fwd: Vec3; right: Vec3; up: Vec3 } {
    const f = this.forward();
    const rl = Math.hypot(f[2], f[0]) || 1;
    const r: Vec3 = [-f[2] / rl, 0, f[0] / rl];
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { fwd: f, right: r, up: u };
  }

  compute(width: number, height: number): View {
    const { fwd: f, right: r, up: u } = this.basis();
    const e = this.eye();
    const view = new Float32Array([
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      -(r[0] * e[0] + r[1] * e[1] + r[2] * e[2]), -(u[0] * e[0] + u[1] * e[1] + u[2] * e[2]), f[0] * e[0] + f[1] * e[1] + f[2] * e[2], 1,
    ]);
    const aspect = width / Math.max(1, height), t = 1 / Math.tan(this.fov / 2);
    const proj = new Float32Array([
      t / aspect, 0, 0, 0,
      0, t, 0, 0,
      0, 0, (FAR + NEAR) / (NEAR - FAR), -1,
      0, 0, (2 * FAR * NEAR) / (NEAR - FAR), 0,
    ]);
    return {
      view, proj, eye: e, fwd: f, right: r, up: u,
      tanHalf: Math.tan(this.fov / 2), aspect, focal: (t * height) / 2,
      depthRow: [view[2]!, view[6]!, view[10]!, view[14]!],
    };
  }
}
