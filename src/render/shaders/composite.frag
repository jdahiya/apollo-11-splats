#version 300 es
precision highp float;

// Final image. The generated scene gets bloom, a soft highlight shoulder, contrast-adaptive
// sharpening (after AMD FidelityFX CAS), vignette and a little grain. Loaded captures are shown
// neutrally, as the reference renderer does: blended colour, clamped, with a sRGB encode only when
// the capture's colours are linear (glTF lin_rec709_display).
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomK;
uniform float u_seed;
uniform float u_look;     // 1 for the generated scene's look, 0 for neutral
uniform float u_encode;   // 1 when blended colours are linear and need the sRGB transfer
uniform vec2 u_texel;     // one scene pixel in uv
uniform float u_sharpen;  // 0..1
out vec4 o;

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

/** Blended colour at uv, with bloom and (for the generated scene) the highlight shoulder. */
vec3 graded(vec2 uv) {
  vec3 c = texture(u_scene, uv).rgb + texture(u_bloom, uv).rgb * u_bloomK;
  if (u_encode > 0.5) c = toSrgb(c);
  if (u_look > 0.5) {
    // Leave everything under 0.75 exactly as authored; roll brighter values off toward 1.
    vec3 shoulder = 0.75 + 0.25 * (1.0 - exp(-(c - 0.75) / 0.25));
    c = mix(c, shoulder, step(vec3(0.75), c));
  }
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 uv = v_uv * 0.5 + 0.5;
  vec3 c = graded(uv);
  if (u_sharpen > 0.0) {
    // Sharpen by how much headroom the neighbourhood leaves, so edges crisp up without halos.
    vec3 n = graded(uv + vec2(0.0, u_texel.y)), s = graded(uv - vec2(0.0, u_texel.y));
    vec3 e = graded(uv + vec2(u_texel.x, 0.0)), w = graded(uv - vec2(u_texel.x, 0.0));
    vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
    vec3 wt = amp * (-1.0 / mix(8.0, 5.0, u_sharpen));
    c = clamp((c + (n + s + e + w) * wt) / (1.0 + 4.0 * wt), 0.0, 1.0);
  }
  if (u_look > 0.5) {
    float vignette = smoothstep(1.35, 0.4, length(v_uv * vec2(1.0, 0.9)));
    c *= mix(0.8, 1.0, vignette);
    float grain = fract(sin(dot(gl_FragCoord.xy + u_seed, vec2(12.9898, 78.233))) * 43758.5453);
    c += (grain - 0.5) * (0.75 / 255.0);
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}
