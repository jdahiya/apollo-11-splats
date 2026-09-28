// Path-traced lighting, in two progressive passes that run within the frame budget and then stop
// costing anything until the sun, the lights or the scene change.
//
// 1. Radiance cache: a few z-slices of the voxel grids per frame. Every voxel that holds surfaces
//    traces direct light and indirect rays against the previous cache pass, then stores the light
//    it sends back out. Each full pass adds a bounce.
// 2. Final gather: a band of splats per frame, lit by direct light plus indirect rays read against
//    the cache. One light value per splat, averaged over passes. The light texture is laid out
//    interleaved (see lightLayout), so each row of it holds splats from all over the scene and a
//    pass dissolves in evenly instead of sweeping across the scene region by region.
import cacheFrag from './shaders/cache.frag';
import fullscreenVert from './shaders/fullscreen.vert';
import lightingFrag from './shaders/lighting.frag';
import traceGlsl from './shaders/trace.glsl';
import { compile, must, uniforms, type Uniforms } from './gl';
import type { GridData } from './voxels';
import type { SunState } from '../world/sun';
import type { LightRig } from '../world/landing';

/** Interior splats are stored first, so the two bands can be refreshed separately. */
export type Band = 'int' | 'ext';

export interface RayBudget {
  /** Rows of 1024 splats to gather this frame. */
  rows: number;
  /** Radiance-cache slices to update this frame (shared by both grids). */
  cacheSlices: number;
  rays: number;
  cacheRays: number;
  lightSamples: number;
  steps: number;
}

interface GridGpu {
  shape: Omit<GridData, 'geo' | 'alb'>;
  geo: WebGLTexture;
  alb: WebGLTexture;
  rad: [WebGLTexture, WebGLTexture];
  read: 0 | 1;
}

const TRACE_UNIFORMS = [
  'u_geoIn', 'u_geoOut', 'u_radIn', 'u_radOut', 'u_inMin', 'u_inInv', 'u_outMin', 'u_outInv', 'u_vIn', 'u_vOut',
  'u_radScale', 'u_frame', 'u_steps', 'u_lights', 'u_lightSamples', 'u_sun', 'u_sunCol', 'u_sky', 'u_ambient',
  'u_lightPos', 'u_lightCol', 'u_lightDir', 'u_lightCdf', 'u_lightTotal', 'u_eagleMin', 'u_eagleMax',
] as const;
type TraceUniforms = Uniforms<(typeof TRACE_UNIFORMS)[number]>;

const withTrace = (source: string): string => source.replace('#include "trace.glsl"', traceGlsl);

/** Bounces kept in the cache after a change; each is one full pass over both grids. */
const CACHE_PASSES = 4;

export class Lighting {
  readonly tex: WebGLTexture;
  ready = false;
  rows = 1;
  interiorRows = 0;
  /**
   * Interior splat count, total count, interior rows, exterior rows. Within a band of n splats
   * over R rows, the band's splat j is lit in column floor(j / R), row j mod R.
   */
  lightLayout: [number, number, number, number] = [0, 0, 0, 0];
  /** Scene layers by splat index (see renderer.ts) and Eagle's box, which the lighting of everything else leaves out. */
  private layers: [number, number, number, number] = [0, 0, 0, 0];
  private eagleBox: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];

  private readonly gatherFb: WebGLFramebuffer;
  private readonly cacheFb: WebGLFramebuffer;
  private readonly gather: WebGLProgram;
  private readonly cache: WebGLProgram;
  private readonly ug;
  private readonly uc;
  private readonly empty: WebGLVertexArrayObject;
  private readonly radFormat: { internal: number; type: number; scale: number };
  private fine: GridGpu | null = null;
  private coarse: GridGpu | null = null;
  private frame = 0;
  private readonly cdf = new Float32Array(16);
  private readonly cycles: Record<Band, number> = { int: 0, ext: 0 };
  private readonly cursor: Record<Band, number> = { int: 0, ext: 0 };
  /** Completed passes since the band's inputs last changed; drives the running average. */
  private readonly passes: Record<Band, number> = { int: 0, ext: 0 };
  private cacheCycles = 0;
  private cachePasses = 0;
  private cacheSlice = 0;

  constructor(private readonly gl: WebGL2RenderingContext, hdr: boolean) {
    this.gather = compile(gl, fullscreenVert, withTrace(lightingFrag));
    this.cache = compile(gl, fullscreenVert, withTrace(cacheFrag));
    this.ug = uniforms(gl, this.gather, [...TRACE_UNIFORMS, 'u_tex', 'u_layout', 'u_rays', 'u_layers'] as const);
    this.uc = uniforms(gl, this.cache, [...TRACE_UNIFORMS, 'u_selfGeo', 'u_selfAlb', 'u_selfRad', 'u_selfMin', 'u_selfVoxel', 'u_layer', 'u_cacheRays', 'u_blend'] as const);
    this.tex = must(gl.createTexture(), 'a texture');
    this.gatherFb = must(gl.createFramebuffer(), 'a framebuffer');
    this.cacheFb = must(gl.createFramebuffer(), 'a framebuffer');
    this.empty = must(gl.createVertexArray(), 'a vertex array');
    // Half-float radiance when the GPU can render to it; otherwise 8-bit storing radiance / 4.
    this.radFormat = hdr && this.canRender3D(gl.RGBA16F, gl.HALF_FLOAT)
      ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT, scale: 1 }
      : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE, scale: 4 };
  }

  /** Allocates the per-splat light texture for a new scene and fills it with neutral light (1.0). */
  reset(count: number, interiorCount: number): void {
    const gl = this.gl;
    this.interiorRows = Math.ceil(interiorCount / 1024);
    const exteriorRows = Math.ceil((count - interiorCount) / 1024);
    this.rows = Math.max(1, this.interiorRows + exteriorRows);
    this.lightLayout = [interiorCount, count, this.interiorRows, exteriorRows];
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1024, this.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gatherFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.clearColor(0.5, 0.5, 0.5, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cycles.int = this.cycles.ext = 0;
    this.passes.int = this.passes.ext = 0;
    this.cursor.int = 0;
    this.cursor.ext = this.interiorRows;
    this.cacheCycles = this.cachePasses = this.cacheSlice = 0;
    this.ready = false;
  }

  setLayers(layers: [number, number, number, number], eagleBox: [number, number, number, number, number, number]): void {
    this.layers = layers;
    this.eagleBox = eagleBox;
  }

  setGrids(fine: GridData, coarse: GridData): void {
    this.fine = this.uploadGrid(fine, this.fine);
    this.coarse = this.uploadGrid(coarse, this.coarse);
    this.cacheSlice = 0;
    this.ready = true;
  }

  disable(): void {
    this.ready = false;
  }

  /**
   * Queues `cycles` full gather passes over a band, and fresh bounces in the cache.
   * `fresh` discards old lighting outright (new scene); otherwise it's kept as a starting point.
   */
  kick(band: Band | 'all', cycles: number, fresh = false): void {
    for (const b of band === 'all' ? (['int', 'ext'] as const) : [band]) {
      this.cycles[b] = Math.max(this.cycles[b], cycles);
      this.passes[b] = fresh ? 0 : Math.min(this.passes[b], 1);
    }
    this.cacheCycles = Math.max(this.cacheCycles, fresh ? CACHE_PASSES + 1 : CACHE_PASSES);
    if (fresh) this.cachePasses = 0;
  }

  get active(): boolean {
    return this.ready && (this.cycles.int > 0 || this.cycles.ext > 0 || this.cacheCycles > 0);
  }

  /** Human-readable progress for the performance panel. */
  get status(): string {
    if (!this.active) return 'Converged, idle';
    const bounce = Math.min(this.cachePasses, CACHE_PASSES);
    return `Refining · bounce ${bounce} of ${CACHE_PASSES} · ${this.cycles.int + this.cycles.ext} gather passes queued`;
  }

  /**
   * One frame of lighting work. Returns the number of splats and voxels evaluated.
   * The gather waits for two cache passes after a fresh start so it doesn't average in unlit bounces.
   */
  step(dataTex: WebGLTexture, budget: RayBudget, sun: SunState, rig: LightRig, minBlendInterior: number, minBlendExterior: number): number {
    if (!this.active || !this.fine || !this.coarse) return 0;
    const gl = this.gl;
    let work = 0;
    gl.bindVertexArray(this.empty);
    if (this.cacheCycles > 0) work += this.stepCache(budget, sun, rig, minBlendInterior);
    if (this.cachePasses >= 2 || this.cacheCycles === 0) work += this.stepGather(dataTex, budget, sun, rig, minBlendInterior, minBlendExterior);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return work;
  }

  private stepCache(budget: RayBudget, sun: SunState, rig: LightRig, minBlend: number): number {
    const gl = this.gl, u = this.uc, fine = this.fine!, coarse = this.coarse!;
    const total = fine.shape.nz + coarse.shape.nz;
    gl.useProgram(this.cache);
    this.bindTrace(u, sun, rig, budget, 1);
    gl.uniform1i(u.u_cacheRays, budget.cacheRays);
    gl.uniform1f(u.u_blend, Math.max(minBlend > 0.3 ? 0.5 : 0.25, 1 / (this.cachePasses + 1)));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cacheFb);
    let voxels = 0, current: GridGpu | null = null;
    for (let n = 0; n < budget.cacheSlices && this.cacheCycles > 0; n++) {
      const g = this.cacheSlice < fine.shape.nz ? fine : coarse;
      const layer = g === fine ? this.cacheSlice : this.cacheSlice - fine.shape.nz;
      if (g !== current) {
        current = g;
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_3D, g.geo);
        gl.uniform1i(u.u_selfGeo, 5);
        gl.activeTexture(gl.TEXTURE6);
        gl.bindTexture(gl.TEXTURE_3D, g.alb);
        gl.uniform1i(u.u_selfAlb, 6);
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_3D, g.rad[g.read]);
        gl.uniform1i(u.u_selfRad, 7);
        gl.uniform3f(u.u_selfMin, g.shape.x0, g.shape.y0, g.shape.z0);
        gl.uniform1f(u.u_selfVoxel, g.shape.v);
      }
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, g.rad[g.read === 0 ? 1 : 0], 0, layer);
      gl.viewport(0, 0, g.shape.nx, g.shape.ny);
      gl.uniform1i(u.u_layer, layer);
      gl.uniform1i(u.u_frame, this.frame++);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      voxels += g.shape.nx * g.shape.ny;
      if (++this.cacheSlice >= total) {
        // Pass complete: the freshly written textures become the ones everything reads.
        this.cacheSlice = 0;
        fine.read = fine.read === 0 ? 1 : 0;
        coarse.read = coarse.read === 0 ? 1 : 0;
        this.cacheCycles--;
        this.cachePasses++;
        this.bindTrace(u, sun, rig, budget, 1);
        current = null;
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    return voxels;
  }

  private stepGather(dataTex: WebGLTexture, budget: RayBudget, sun: SunState, rig: LightRig, minBlendInterior: number, minBlendExterior: number): number {
    const gl = this.gl, u = this.ug;
    const bands = (['int', 'ext'] as const).filter((b) => this.cycles[b] > 0);
    if (!bands.length) return 0;
    const perBand = Math.max(1, Math.floor(budget.rows / bands.length));
    gl.useProgram(this.gather);
    this.bindTrace(u, sun, rig, budget, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dataTex);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform4i(u.u_layout, ...this.lightLayout);
    gl.uniform4i(u.u_layers, ...this.layers);
    gl.uniform1i(u.u_rays, budget.rays);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gatherFb);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    let traced = 0;
    for (const band of bands) {
      const lo = band === 'int' ? 0 : this.interiorRows;
      const hi = band === 'int' ? this.interiorRows : this.rows;
      if (hi <= lo) {
        this.cycles[band] = 0;
        continue;
      }
      let left = Math.min(perBand, hi - lo);
      while (left > 0 && this.cycles[band] > 0) {
        const cur = this.cursor[band], n = Math.min(left, hi - cur);
        const minBlend = band === 'int' ? minBlendInterior : minBlendExterior;
        gl.blendColor(0, 0, 0, Math.max(minBlend, 1 / (this.passes[band] + 1)));
        gl.viewport(0, cur, 1024, n);
        gl.uniform1i(u.u_frame, this.frame++);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        traced += n;
        left -= n;
        this.cursor[band] = cur + n;
        if (this.cursor[band] >= hi) {
          this.cursor[band] = lo;
          this.cycles[band]--;
          this.passes[band]++;
        }
      }
    }
    gl.disable(gl.BLEND);
    return traced * 1024;
  }

  /** Scene grids, radiance caches and the light rig; textures go on units first..first+3. */
  private bindTrace(u: TraceUniforms, sun: SunState, rig: LightRig, budget: RayBudget, first: number): void {
    const gl = this.gl, f = this.fine!, c = this.coarse!;
    const units: [WebGLTexture, keyof TraceUniforms][] = [[f.geo, 'u_geoIn'], [c.geo, 'u_geoOut'], [f.rad[f.read], 'u_radIn'], [c.rad[c.read], 'u_radOut']];
    units.forEach(([tex, name], i) => {
      gl.activeTexture(gl.TEXTURE0 + first + i);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.uniform1i(u[name], first + i);
    });
    const fs = f.shape, cs = c.shape;
    gl.uniform3f(u.u_inMin, fs.x0, fs.y0, fs.z0);
    gl.uniform3f(u.u_inInv, 1 / (fs.nx * fs.v), 1 / (fs.ny * fs.v), 1 / (fs.nz * fs.v));
    gl.uniform3f(u.u_outMin, cs.x0, cs.y0, cs.z0);
    gl.uniform3f(u.u_outInv, 1 / (cs.nx * cs.v), 1 / (cs.ny * cs.v), 1 / (cs.nz * cs.v));
    gl.uniform1f(u.u_vIn, fs.v);
    gl.uniform1f(u.u_vOut, cs.v);
    gl.uniform1f(u.u_radScale, this.radFormat.scale);
    gl.uniform1i(u.u_steps, budget.steps);
    gl.uniform1i(u.u_lightSamples, budget.lightSamples);
    gl.uniform1i(u.u_lights, rig.count);
    gl.uniform3fv(u.u_sun, sun.dir);
    gl.uniform3fv(u.u_sunCol, sun.color);
    gl.uniform3fv(u.u_sky, sun.sky);
    gl.uniform3fv(u.u_ambient, rig.ambient);
    gl.uniform4fv(u.u_lightPos, rig.pos);
    gl.uniform3fv(u.u_lightCol, rig.color);
    gl.uniform4fv(u.u_lightDir, rig.dir);
    let total = 0;
    for (let i = 0; i < 16; i++) {
      if (i < rig.count) total += rig.pos[i * 4 + 3]!;
      this.cdf[i] = total;
    }
    gl.uniform1fv(u.u_lightCdf, this.cdf);
    gl.uniform1f(u.u_lightTotal, total || 1);
    const b = this.eagleBox;
    gl.uniform3f(u.u_eagleMin, b[0], b[1], b[2]);
    gl.uniform3f(u.u_eagleMax, b[3], b[4], b[5]);
  }

  private uploadGrid(g: GridData, old: GridGpu | null): GridGpu {
    const gl = this.gl;
    if (old) for (const t of [old.geo, old.alb, ...old.rad]) gl.deleteTexture(t);
    const make = (internal: number, format: number, type: number, data: ArrayBufferView | null): WebGLTexture => {
      const tex = must(gl.createTexture(), 'a 3D texture');
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, internal, g.nx, g.ny, g.nz, 0, format, type, data);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      return tex;
    };
    const { internal, type } = this.radFormat;
    const grid: GridGpu = {
      shape: { x0: g.x0, y0: g.y0, z0: g.z0, v: g.v, nx: g.nx, ny: g.ny, nz: g.nz },
      geo: make(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, g.geo),
      alb: make(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, g.alb),
      // WebGL zero-fills new textures, so the cache starts dark.
      rad: [make(internal, gl.RGBA, type, null), make(internal, gl.RGBA, type, null)],
      read: 0,
    };
    gl.bindTexture(gl.TEXTURE_3D, null);
    return grid;
  }

  private canRender3D(internal: number, type: number): boolean {
    const gl = this.gl;
    const tex = gl.createTexture(), fb = gl.createFramebuffer();
    if (!tex || !fb) return false;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, internal, 2, 2, 2, 0, gl.RGBA, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fb);
    return ok;
  }
}
