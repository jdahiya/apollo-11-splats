#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

// Splat data: two RGBA32UI texels per splat, 1024 splats per row.
//   texel 0: position xyz (float bits), colour RGBA8 (the degree-0 colour, 0.5 + C0 · f_dc)
//   texel 1: covariance as three half2 pairs
// Rendering follows Kerbl et al. 2023 (3D Gaussian Splatting) and KHR_gaussian_splatting:
// EWA projection with a 0.3 px dilation, alpha = min(0.99, o·G), skip alpha < 1/255, 3σ extent,
// and view-dependent colour from spherical harmonics up to degree 3. The tangential projection
// from OpenUSD's 3D Gaussian splat schema (RealityKit's default) is available too; see below.
uniform usampler2D u_tex;
uniform usampler2D u_sh;     // higher-order spherical harmonics, 512 splats per row
uniform mat4 u_proj;
uniform mat4 u_view;
uniform vec2 u_focal;
uniform vec2 u_vp;
uniform vec2 u_tanFov;       // tan(fovx / 2), tan(fovy / 2)
uniform vec3 u_camPos;
uniform mat3 u_shRot;        // world directions into the capture's own axes
uniform int u_shDegree;
uniform int u_shTexels;
uniform int u_aa;            // 0 none, 1 anti-aliased (0.3 dilation), 2 Mip-Splatting (0.1 dilation)
uniform float u_minPx;       // splats smaller than this many pixels fade out (none below half of it)
uniform int u_projection;    // 0 perspective (3DGS reference, glTF), 1 tangential (OpenUSD, RealityKit)

in vec2 a_pos;               // quad corner in [-1, 1]
in uint a_idx;               // splat index, sorted far to near
out vec4 v_col;
out vec2 v_p;

const float SQRT_4_5 = 2.1213203; // 3σ in units of sqrt(2)σ

// Real spherical-harmonic basis constants (graphdeco-inria/gaussian-splatting, sh_utils.py).
const float SH_C1 = 0.4886025119029199;
const float SH_C2_0 = 1.0925484305920792;
const float SH_C2_1 = -1.0925484305920792;
const float SH_C2_2 = 0.31539156525252005;
const float SH_C2_3 = -1.0925484305920792;
const float SH_C2_4 = 0.5462742152960396;
const float SH_C3_0 = -0.5900435899266435;
const float SH_C3_1 = 2.890611442640554;
const float SH_C3_2 = -0.4570457994644658;
const float SH_C3_3 = 0.3731763325901154;
const float SH_C3_4 = -0.4570457994644658;
const float SH_C3_5 = 1.445305721320277;
const float SH_C3_6 = -0.5900435899266435;

#define SH(k) vec3(h[3 * (k)], h[3 * (k) + 1], h[3 * (k) + 2])

/** View-dependent colour beyond the base colour, for the direction from the camera to the splat. */
vec3 shColor(uint idx, vec3 worldPos) {
  float h[48];
  int base = int(idx & 511u) * u_shTexels, row = int(idx >> 9);
  for (int t = 0; t < 6; t++) {
    if (t >= u_shTexels) break;
    uvec4 v = texelFetch(u_sh, ivec2(base + t, row), 0);
    vec2 a = unpackHalf2x16(v.x), b = unpackHalf2x16(v.y), c = unpackHalf2x16(v.z), d = unpackHalf2x16(v.w);
    h[t * 8] = a.x; h[t * 8 + 1] = a.y; h[t * 8 + 2] = b.x; h[t * 8 + 3] = b.y;
    h[t * 8 + 4] = c.x; h[t * 8 + 5] = c.y; h[t * 8 + 6] = d.x; h[t * 8 + 7] = d.y;
  }
  vec3 dir = normalize(u_shRot * (worldPos - u_camPos));
  float x = dir.x, y = dir.y, z = dir.z;
  vec3 c = -SH_C1 * y * SH(0) + SH_C1 * z * SH(1) - SH_C1 * x * SH(2);
  if (u_shDegree > 1) {
    float xx = x * x, yy = y * y, zz = z * z, xy = x * y, yz = y * z, xz = x * z;
    c += SH_C2_0 * xy * SH(3) + SH_C2_1 * yz * SH(4) + SH_C2_2 * (2.0 * zz - xx - yy) * SH(5)
       + SH_C2_3 * xz * SH(6) + SH_C2_4 * (xx - yy) * SH(7);
    if (u_shDegree > 2) {
      c += SH_C3_0 * y * (3.0 * xx - yy) * SH(8) + SH_C3_1 * xy * z * SH(9)
         + SH_C3_2 * y * (4.0 * zz - xx - yy) * SH(10) + SH_C3_3 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * SH(11)
         + SH_C3_4 * x * (4.0 * zz - xx - yy) * SH(12) + SH_C3_5 * z * (xx - yy) * SH(13)
         + SH_C3_6 * x * (xx - 3.0 * yy) * SH(14);
    }
  }
  return c;
}

void cull() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }

void main() {
  ivec2 tc = ivec2(int((a_idx & 1023u) << 1), int(a_idx >> 10));
  uvec4 c = texelFetch(u_tex, tc, 0);
  float opacity = float(c.w >> 24) / 255.0;
  if (opacity < 1.0 / 255.0) { cull(); return; }
  vec3 wp = uintBitsToFloat(c.xyz);
  uvec4 h = texelFetch(u_tex, tc + ivec2(1, 0), 0);
  vec2 u1 = unpackHalf2x16(h.x), u2 = unpackHalf2x16(h.y), u3 = unpackHalf2x16(h.z);
  mat3 V = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);

  vec4 cam = u_view * vec4(wp, 1.0);
  vec4 clip = u_proj * cam;
  // Cull by footprint rather than by centre, so big splats don't pop in at the edges of the view:
  // keep anything whose 3σ sphere (σ² is at most the covariance's trace) can reach the frustum.
  // Near plane at 0.2 m, as in the reference rasteriser.
  float r3 = 3.0 * sqrt(max(V[0][0] + V[1][1] + V[2][2], 0.0));
  float limX = 1.02 * clip.w + (u_proj[0][0] + 1.0) * r3, limY = 1.02 * clip.w + (u_proj[1][1] + 1.0) * r3;
  if (cam.z > -0.2 || abs(clip.x) > limX || abs(clip.y) > limY) { cull(); return; }
  // Fade splats out over the last 40 cm instead of snapping them off at the near plane.
  opacity *= smoothstep(0.2, 0.6, -cam.z);
  mat3 W = mat3(u_view);
  mat3 C = W * V * transpose(W);
  float tz = -cam.z;

  // 2D covariance [a0 b; b d0]: in pixels for perspective, in metres on the tangent plane for
  // tangential (pxPerUnit converts the latter to pixels).
  float a0, b, d0, pxPerUnit = 1.0;
  vec3 ax = vec3(0.0), ay = vec3(0.0);
  if (u_projection == 1) {
    // Tangential projection: project the Gaussian orthographically onto the plane through its
    // centre that faces the camera, then draw that plane as a real quad in 3D. Perspective-correct
    // interpolation evaluates the Gaussian exactly where each pixel's ray meets the plane, so a
    // splat's footprint doesn't stretch toward the edges of a wide view or change as the camera turns.
    vec3 dir = normalize(cam.xyz);
    ax = normalize(vec3(-dir.z, 0.0, dir.x));
    ay = cross(ax, dir);
    vec3 Cx = C * ax, Cy = C * ay;
    a0 = dot(ax, Cx);
    b = dot(ax, Cy);
    d0 = dot(ay, Cy);
    pxPerUnit = u_focal.y / tz;
  } else {
    // EWA splatting: project the 3D covariance with the Jacobian of the perspective divide at the
    // splat centre. As in the reference, the centre is clamped to 1.3× the field of view first so
    // splats far off-screen don't get extreme Jacobians. The camera looks down -z.
    float iz = 1.0 / cam.z;
    vec2 fovLim = 1.3 * u_tanFov;
    float tx = clamp(cam.x / tz, -fovLim.x, fovLim.x) * tz;
    float ty = clamp(cam.y / tz, -fovLim.y, fovLim.y) * tz;
    vec3 j1 = vec3(-u_focal.x * iz, 0.0, u_focal.x * tx * iz * iz);
    vec3 j2 = vec3(0.0, -u_focal.y * iz, u_focal.y * ty * iz * iz);
    vec3 Cj1 = C * j1, Cj2 = C * j2;
    a0 = dot(j1, Cj1);
    b = dot(j1, Cj2);
    d0 = dot(j2, Cj2);
  }
  // Low-pass dilation: 0.3 px² normally, 0.1 for Mip-Splatting captures. Anti-aliased captures
  // compensate opacity for it by sqrt(det before / det after).
  float dilation = (u_aa == 2 ? 0.1 : 0.3) / (pxPerUnit * pxPerUnit);
  float a = a0 + dilation, d = d0 + dilation;
  if (u_aa > 0) opacity *= sqrt(max(2.5e-5, (a0 * d0 - b * b) / (a * d - b * b)));

  float mid = 0.5 * (a + d), rad = length(vec2(0.5 * (a - d), b));
  float l1 = mid + rad, l2 = mid - rad;
  if (l2 < 0.0) { cull(); return; }
  float extent = sqrt(2.0 * l1), px = extent * pxPerUnit;
  if (px < 0.5 * u_minPx) { cull(); return; }
  if (u_minPx > 0.0) opacity *= smoothstep(0.5 * u_minPx, u_minPx, px);
  vec2 e1 = abs(b) > 1e-8 * max(a, d) ? normalize(vec2(b, l1 - a)) : (a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  float cap = 1024.0 / pxPerUnit;
  vec2 major = min(extent, cap) * e1;
  vec2 minor = min(sqrt(2.0 * l2), cap) * vec2(e1.y, -e1.x);

  vec3 col = vec3(c.w & 0xffu, (c.w >> 8) & 0xffu, (c.w >> 16) & 0xffu) / 255.0;
  if (u_shDegree > 0) col = max(col + shColor(a_idx, wp), 0.0);

  // Only cover pixels where alpha can reach 1/255: |p|² ≤ ln(255·opacity), and never beyond 3σ.
  float reach = min(SQRT_4_5, sqrt(max(log(255.0 * opacity), 0.0)));
  vec2 corner = a_pos * reach;
  v_col = vec4(col, opacity);
  v_p = corner;
  vec2 offset = corner.x * major + corner.y * minor;
  if (u_projection == 1) gl_Position = u_proj * vec4(cam.xyz + offset.x * ax + offset.y * ay, 1.0);
  else gl_Position = vec4(clip.xy / clip.w + offset * 2.0 / u_vp, 0.0, 1.0);
}
