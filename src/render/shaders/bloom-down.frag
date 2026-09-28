#version 300 es
precision highp float;

// Downsample for bloom: a 4-tap box of bilinear samples. The first pass keeps only
// light above the threshold (emissive splats go over 1.0 in the HDR buffer).
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_tx;      // 1 / source size
uniform float u_th;     // threshold, 0 = none
out vec4 o;

void main() {
  vec2 uv = v_uv * 0.5 + 0.5;
  vec3 c = texture(u_src, uv + u_tx * vec2(-1.0, -1.0)).rgb
         + texture(u_src, uv + u_tx * vec2(1.0, -1.0)).rgb
         + texture(u_src, uv + u_tx * vec2(-1.0, 1.0)).rgb
         + texture(u_src, uv + u_tx * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  if (u_th > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    c *= max(l - u_th, 0.0) / max(l, 1e-4);
  }
  o = vec4(c, 1.0);
}
