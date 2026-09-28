#version 300 es
// One oversized triangle that covers the viewport. v_uv runs from -1 to 1 across it.
out vec2 v_uv;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  v_uv = p;
  gl_Position = vec4(p, 0.0, 1.0);
}
