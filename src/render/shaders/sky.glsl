// What you see looking into a direction: the sky background (sky.frag) and reflections on foil,
// visors and glass (splat.vert) share this, so reflections always match the sky. Above the
// Moon there's no air: the sky is black, with the sun's disc, a little lens glare round it and
// faint stars. Below the horizon, for reflections, is the sunlit ground.

uniform vec3 u_sun;    // direction toward the sun

float skyHash(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

/** Light arriving from direction d (unit). stars adds the star field. */
vec3 skyRadiance(vec3 d, bool stars) {
  if (d.y < 0.0) return vec3(0.33, 0.32, 0.3) * clamp(u_sun.y * 4.0 + 0.1, 0.1, 1.0);
  float s = dot(d, u_sun);
  // The sun's disc (about half a degree across) and a camera-like glare round it.
  vec3 col = vec3(1.0, 0.97, 0.92) * (smoothstep(0.99997, 0.999992, s) * 60.0 + pow(max(s, 0.0), 400.0) * 0.5 + pow(max(s, 0.0), 24.0) * 0.02);
  if (stars) {
    // Cells a tenth of a degree across; a few hold a star, drawn as a point at the cell's centre.
    vec2 sp = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0))) * 573.0, cell = floor(sp);
    float star = step(0.9975, skyHash(cell)) * smoothstep(0.42, 0.12, length(fract(sp) - 0.5));
    col += star * (0.05 + 0.3 * skyHash(cell + 7.0)) * smoothstep(0.0, 0.2, d.y);
  }
  return col;
}
