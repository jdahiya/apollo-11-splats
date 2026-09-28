// Shared ray-marching code for the lighting passes (included by lighting.frag and cache.frag).
//
// Two voxel grids describe the scene: a fine one round the landing site and a coarse one for the
// plain around it. Each grid has a geometry texture (rgb = emitted light, a = how much of the
// voxel the splats cover) and a radiance cache (rgb = light leaving the voxel's surfaces,
// premultiplied by coverage). Tracing a ray through the cache is what makes light bounce: whatever
// a ray hits contributes the light that surface is itself sending out.
//
// On the Moon there's no sky light: rays that escape see black space, so everything in shadow is
// lit only by sunlight thrown back off the ground and off Eagle.

uniform highp sampler3D u_geoIn;
uniform highp sampler3D u_geoOut;
uniform highp sampler3D u_radIn;
uniform highp sampler3D u_radOut;
uniform vec3 u_inMin;
uniform vec3 u_inInv;         // 1 / grid extent in metres
uniform vec3 u_outMin;
uniform vec3 u_outInv;
uniform float u_vIn;          // voxel size in metres
uniform float u_vOut;
uniform float u_radScale;     // radiance stored / u_radScale (1 for half-float, 4 for 8-bit)
uniform int u_frame;
uniform int u_steps;          // march steps for shadow rays
uniform int u_lights;
uniform int u_lightSamples;
uniform vec3 u_sun;           // direction toward the sun
uniform vec3 u_sunCol;
uniform vec3 u_sky;           // light from rays that escape (black space on the Moon)
uniform vec3 u_ambient;
uniform vec4 u_lightPos[16];  // xyz, w = intensity
uniform vec3 u_lightCol[16];
uniform vec4 u_lightDir[16];  // spot direction; w = cos of cone, below -1 for omni lights
uniform float u_lightCdf[16]; // running sum of intensities, for picking lights by brightness
uniform float u_lightTotal;
uniform vec3 u_eagleMin;      // Eagle's box in the voxel grids
uniform vec3 u_eagleMax;

// Per splat, set by the gather pass before it traces:
bool g_skipEagle = false;     // leave Eagle out (its shadow on everything else is drawn live)
bool g_oneSided = false;      // light only the side the normal faces (the ground)
vec3 g_lift = vec3(0.0);      // start rays this many voxels off the surface

uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

float rand(inout uint s) {
  s = hash(s);
  return float(s) * (1.0 / 4294967296.0);
}

vec3 uniformSphere(inout uint s) {
  float z = 1.0 - 2.0 * rand(s), ph = 6.2831853 * rand(s), r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(ph), z, r * sin(ph));
}

bool inEagle(vec3 p) {
  return g_skipEagle && all(greaterThan(p, u_eagleMin)) && all(lessThan(p, u_eagleMax));
}

bool inFine(vec3 p) {
  vec3 q = (p - u_inMin) * u_inInv;
  return all(greaterThanEqual(q, vec3(0.0))) && all(lessThan(q, vec3(1.0)));
}

float voxelAt(vec3 p) {
  return inFine(p) ? u_vIn : u_vOut;
}

float occupancy(vec3 p) {
  if (inEagle(p)) return 0.0;
  vec3 q = (p - u_inMin) * u_inInv;
  if (all(greaterThanEqual(q, vec3(0.0))) && all(lessThan(q, vec3(1.0)))) return textureLod(u_geoIn, q, 0.0).a;
  vec3 r = (p - u_outMin) * u_outInv;
  if (any(lessThan(r, vec3(0.0))) || any(greaterThanEqual(r, vec3(1.0)))) return 0.0;
  return textureLod(u_geoOut, r, 0.0).a;
}

void sampleScene(vec3 p, out float occ, out vec3 radiance) {
  occ = 0.0;
  radiance = vec3(0.0);
  if (inEagle(p)) return;
  vec3 q = (p - u_inMin) * u_inInv;
  if (all(greaterThanEqual(q, vec3(0.0))) && all(lessThan(q, vec3(1.0)))) {
    occ = textureLod(u_geoIn, q, 0.0).a;
    radiance = textureLod(u_radIn, q, 0.0).rgb * u_radScale;
    return;
  }
  vec3 r = (p - u_outMin) * u_outInv;
  if (any(lessThan(r, vec3(0.0))) || any(greaterThanEqual(r, vec3(1.0)))) return;
  occ = textureLod(u_geoOut, r, 0.0).a;
  radiance = textureLod(u_radOut, r, 0.0).rgb * u_radScale;
}

// Rays from the ground start a voxel above it, so the ground they sit on doesn't shadow them.
vec3 rayOrigin(vec3 p, float voxel) {
  return p + g_lift * voxel;
}

// Fraction of light that reaches p along dir from tMax metres away (shadow rays).
float visibility(vec3 p, vec3 dir, float tMax, float jitter) {
  float voxel = voxelAt(p), stride = max(voxel, tMax / float(u_steps));
  float t = voxel * 1.5 + voxel * jitter, T = 1.0; // start outside the point's own voxel
  vec3 o = rayOrigin(p, voxel);
  for (int i = 0; i < 128; i++) {
    if (i >= u_steps || t > tMax) break;
    T *= 1.0 - occupancy(o + dir * t);
    if (T < 0.03) return 0.0;
    // Low sun: step finely near the start, where nearby rims and rocks cast the long shadows.
    t += min(stride, voxel * (1.0 + 0.25 * float(i)));
  }
  return T;
}

// Light arriving at p from direction dir: the cached light of every surface the ray meets,
// weighted by how much of it is still visible, plus whatever escapes (black space here).
vec3 incoming(vec3 p, vec3 dir, float tMax, int steps, float jitter) {
  float voxel = voxelAt(p), stride = max(voxel, tMax / float(steps));
  float t = voxel * 1.5 + stride * jitter, T = 1.0;
  vec3 o = rayOrigin(p, voxel), L = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= steps || t > tMax) break;
    float occ;
    vec3 rad;
    sampleScene(o + dir * t, occ, rad);
    L += rad * T;
    T *= 1.0 - occ;
    if (T < 0.03) {
      T = 0.0;
      break;
    }
    t += stride;
  }
  return L + T * u_sky;
}

// Direct sunlight with a shadow ray. The ground is lit on its upper side only, so slopes facing
// away from a low sun fall dark; other surfaces (thin foil, flags) can be lit from either side.
vec3 direct(vec3 p, vec3 n, bool hasNormal, bool inside, inout uint seed) {
  if (u_sun.y < -0.01) return vec3(0.0);
  float facing = hasNormal ? (g_oneSided ? max(dot(n, u_sun), 0.0) : abs(dot(n, u_sun))) : 0.6;
  if (facing <= 0.0) return vec3(0.0);
  return u_sunCol * facing * visibility(p, u_sun, 600.0, rand(seed));
}

// Indirect light: the average light arriving over the whole sphere, doubled because a surface
// only sees one hemisphere of it. Every bounce comes in through here.
vec3 indirect(vec3 p, bool inside, int rays, int steps, inout uint seed) {
  float reach = voxelAt(p) * 14.0;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= rays) break;
    vec3 dir = uniformSphere(seed);
    sum += min(incoming(p, dir, reach, steps, rand(seed)), vec3(2.0)); // clamp fireflies
  }
  return 2.0 * sum / float(max(rays, 1));
}
