#version 300 es
precision highp float;

// Final image, shown neutrally as the reference renderer does: blended colour, clamped, with a
// sRGB encode only when a capture's colours are linear (glTF lin_rec709_display). When the scene
// is rendered below full size, contrast-adaptive sharpening (after AMD FidelityFX CAS) restores
// the edges the upscale softens.
in vec2 v_uv;
uniform sampler2D u_scene;
uniform float u_encode;   // 1 when blended colours are linear and need the sRGB transfer
uniform vec2 u_texel;     // one scene pixel in uv
uniform float u_sharpen;  // 0..1
out vec4 o;

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 colour(vec2 uv) {
  vec3 c = texture(u_scene, uv).rgb;
  if (u_encode > 0.5) c = toSrgb(c);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 uv = v_uv * 0.5 + 0.5;
  vec3 c = colour(uv);
  if (u_sharpen > 0.0) {
    // Sharpen by how much headroom the neighbourhood leaves, so edges crisp up without halos.
    vec3 n = colour(uv + vec2(0.0, u_texel.y)), s = colour(uv - vec2(0.0, u_texel.y));
    vec3 e = colour(uv + vec2(u_texel.x, 0.0)), w = colour(uv - vec2(u_texel.x, 0.0));
    vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
    vec3 wt = amp * (-1.0 / mix(8.0, 5.0, u_sharpen));
    c = clamp((c + (n + s + e + w) * wt) / (1.0 + 4.0 * wt), 0.0, 1.0);
  }
  o = vec4(c, 1.0);
}
