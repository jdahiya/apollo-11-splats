#version 300 es
precision highp float;

#include "sky.glsl"

in vec2 v_uv;
uniform vec3 u_r;      // camera right
uniform vec3 u_u;      // camera up
uniform vec3 u_f;      // camera forward
uniform float u_th;    // tan(fov / 2)
uniform float u_asp;
out vec4 o;

void main() {
  vec3 d = normalize(u_f + v_uv.x * u_th * u_asp * u_r + v_uv.y * u_th * u_u);
  // Below the horizon is black until the ground's splats cover it (the grey there is for reflections).
  o = vec4(d.y < 0.0 ? vec3(0.0) : skyRadiance(d, true), 1.0);
}
