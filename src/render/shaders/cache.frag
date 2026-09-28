#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

// Radiance cache update, one z-slice of one voxel grid per draw. For every voxel that holds
// surfaces, trace direct light and a few indirect rays against the previous pass of the cache,
// and store the light those surfaces send back out: emission + albedo × incoming light.
// Each full pass over the grids adds one more bounce; passes are blended so noise settles.

#include "trace.glsl"

uniform highp sampler3D u_selfGeo;  // the grid being updated
uniform highp sampler3D u_selfAlb;  // rgb = average surface colour, a = splat coverage
uniform highp sampler3D u_selfRad;  // its previous cache pass
uniform vec3 u_selfMin;
uniform float u_selfVoxel;
uniform int u_layer;
uniform int u_cacheRays;
uniform float u_blend;
out vec4 o;

const float EMISSION = 1.8;

void main() {
  ivec3 c = ivec3(int(gl_FragCoord.x), int(gl_FragCoord.y), u_layer);
  vec4 geo = texelFetch(u_selfGeo, c, 0);
  vec4 alb = texelFetch(u_selfAlb, c, 0);
  // Empty space and the solid ground or Eagle's insides send out no light.
  if (geo.a < 0.03 || alb.a < 0.01) {
    o = vec4(0.0);
    return;
  }
  vec3 p = u_selfMin + (vec3(c) + 0.5) * u_selfVoxel;
  uint seed = hash(uint(c.x) * 73856093u ^ uint(c.y) * 19349663u ^ uint(c.z) * 83492791u ^ uint(u_frame) * 2654435761u);
  vec3 incident = direct(p, vec3(0.0, 1.0, 0.0), false, false, seed) + indirect(p, false, u_cacheRays, 16, seed);
  vec3 radiance = geo.rgb * EMISSION + alb.rgb * incident;
  vec3 previous = texelFetch(u_selfRad, c, 0).rgb * u_radScale / max(geo.a, 1e-3);
  o = vec4(mix(previous, radiance, u_blend) * geo.a / u_radScale, 1.0);
}
