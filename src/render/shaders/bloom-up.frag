#version 300 es
precision highp float;

// Upsample for bloom: a 3x3 tent filter, added onto the next larger level.
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_tx;      // 1 / source size
uniform float u_k;
out vec4 o;

void main() {
  vec2 uv = v_uv * 0.5 + 0.5;
  vec3 c = texture(u_src, uv).rgb * 4.0;
  c += (texture(u_src, uv + vec2(u_tx.x, 0.0)).rgb + texture(u_src, uv - vec2(u_tx.x, 0.0)).rgb
      + texture(u_src, uv + vec2(0.0, u_tx.y)).rgb + texture(u_src, uv - vec2(0.0, u_tx.y)).rgb) * 2.0;
  c += texture(u_src, uv + u_tx).rgb + texture(u_src, uv - u_tx).rgb
     + texture(u_src, uv + vec2(u_tx.x, -u_tx.y)).rgb + texture(u_src, uv + vec2(-u_tx.x, u_tx.y)).rgb;
  o = vec4(c / 16.0 * u_k, 1.0);
}
