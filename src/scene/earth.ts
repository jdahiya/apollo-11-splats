// Earth as it hung over Tranquility Base: high in the western sky (about 66° up, because the
// site is 23° east of the point on the Moon that faces Earth), nearly four times as wide as the
// Moon looks from Earth, and a little over half lit, on the side toward the sun.
import { PI, type Vec3 } from '../util/math';
import { hash } from '../util/random';
import { canvasPanel } from '../splats/primitives';

const DIST = 3000; // far enough to sit in the sky, inside the camera's range
const ANGULAR = (1.9 * PI) / 180;

/** Unit vector toward Earth from the site (x east, y up, z south): azimuth 268°, elevation 66.5°. */
export const EARTH_DIR: Vec3 = (() => {
  const az = (268 * PI) / 180, el = (66.5 * PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
})();

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function noise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const fbm = (x: number, y: number, s: number): number =>
  noise(x, y, s) * 0.5 + noise(x * 2.1, y * 2.1, s + 1) * 0.28 + noise(x * 4.3, y * 4.3, s + 2) * 0.14 + noise(x * 8.9, y * 8.9, s + 3) * 0.08;

/** Earth, lit from sunDir, as splats on a disc in the sky. k scales how many. */
export function buildEarth(sunDir: Vec3, k: number): void {
  const d = EARTH_DIR, size = 2 * DIST * Math.tan(ANGULAR / 2);
  // On the sky: up toward the zenith, and right as you look at it.
  const upRaw: Vec3 = [-d[0] * d[1], 1 - d[1] * d[1], -d[2] * d[1]], ul = Math.hypot(...upRaw);
  const up: Vec3 = [upRaw[0] / ul, upRaw[1] / ul, upRaw[2] / ul];
  const right: Vec3 = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
  const light: Vec3 = [dot(sunDir, right), dot(sunDir, up), -dot(sunDir, d)];
  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number): void => {
    const img = ctx.createImageData(w, h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = (2 * (i + 0.5)) / w - 1, y = 1 - (2 * (j + 0.5)) / h, rr = x * x + y * y;
        if (rr > 1) continue;
        const z = Math.sqrt(1 - rr);
        const lit = Math.max(0, x * light[0] + y * light[1] + z * light[2]);
        // Oceans, continents, ice caps and swirling cloud, in the planet's own latitude and longitude.
        const lat = Math.asin(y), lon = Math.atan2(x, z) + 0.9;
        let c: Vec3 = [0.06, 0.17, 0.42];
        if (fbm(lon * 1.6 + 3, lat * 2.2, 11) > 0.56) c = fbm(lon * 5, lat * 5, 13) > 0.5 ? [0.5, 0.43, 0.28] : [0.28, 0.35, 0.18];
        if (Math.abs(lat) > 1.15) c = [0.9, 0.92, 0.95];
        const cloud = Math.max(0, fbm(lon * 3 + Math.sin(lat * 4), lat * 4.5, 17) - 0.5) * 3.2;
        c = [c[0] + (0.95 - c[0]) * Math.min(1, cloud), c[1] + (0.96 - c[1]) * Math.min(1, cloud), c[2] + (0.98 - c[2]) * Math.min(1, cloud)];
        // A thin blue rim of atmosphere on the lit limb.
        const rim = Math.pow(1 - z, 3) * 0.6 * Math.min(1, lit * 3);
        const k2 = 0.03 + 0.97 * lit, q = (j * w + i) * 4;
        img.data[q] = Math.min(255, (c[0] * k2 + 0.2 * rim) * 255);
        img.data[q + 1] = Math.min(255, (c[1] * k2 + 0.35 * rim) * 255);
        img.data[q + 2] = Math.min(255, (c[2] * k2 + 0.8 * rim) * 255);
        img.data[q + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };
  const c: Vec3 = [d[0] * DIST, d[1] * DIST, d[2] * DIST];
  const o: Vec3 = [c[0] - (right[0] + up[0]) * (size / 2), c[1] - (right[1] + up[1]) * (size / 2), c[2] - (right[2] + up[2]) * (size / 2)];
  canvasPanel(o, right, up, size, size, size / Math.round(180 / k), draw, 1.35);
}
