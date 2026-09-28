#version 300 es
precision highp float;

in vec4 v_col;
in vec2 v_p;
out vec4 o;

void main() {
  // v_p is in units of sqrt(2)σ, so |v_p|² = d²/(2σ²) and exp(-|v_p|²) is the Gaussian.
  // Cut off at 3σ (|v_p|² = 4.5), clamp alpha at 0.99 and skip anything under 1/255 (Kerbl et al.).
  float r2 = dot(v_p, v_p);
  if (r2 > 4.5) discard;
  float alpha = min(0.99, v_col.a * exp(-r2));
  if (alpha < 1.0 / 255.0) discard;
  o = vec4(v_col.rgb * alpha, alpha); // premultiplied, blended back to front
}
