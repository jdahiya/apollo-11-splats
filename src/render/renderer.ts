// Draws a frame: sky, sorted splats into an HDR buffer, bloom, then tone-mapped composite.
import bloomDownFrag from './shaders/bloom-down.frag';
import bloomUpFrag from './shaders/bloom-up.frag';
import compositeFrag from './shaders/composite.frag';
import fullscreenVert from './shaders/fullscreen.vert';
import skyFrag from './shaders/sky.frag';
import skyGlsl from './shaders/sky.glsl';
import splatFrag from './shaders/splat.frag';
import splatVert from './shaders/splat.vert';
import { compile, createTarget, deleteTarget, must, uniforms, type Target } from './gl';
import { asset, type SplatStore } from '../splats/store';
import { toHalf } from '../util/half';
import type { RGB, Vec3 } from '../util/math';

export interface FrameParams {
  view: Float32Array;
  proj: Float32Array;
  focal: number;
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  eye: Vec3;
  tanHalf: number;
  aspect: number;
  /** false shows the scene neutrally (loaded captures): no bloom, shoulder, vignette or grain. */
  look: boolean;
  sun: Vec3;
  fogColor: RGB;
  fogDensity: number;
  /** Splat index ranges: ground end, moonwalk start, Eagle start, Eagle end (dust after that). */
  layers: readonly [number, number, number, number];
  /** Eagle's rigid transform during the landing (column-major 4×4), and its inverse. */
  eagle: Float32Array;
  eagleInv: Float32Array;
  /** 0..1: the moonwalk's things, the landing dust, the engine's glow. */
  evaVis: number;
  dust: number;
  engine: number;
  /** Seconds, for animation. */
  time: number;
  /** Per-splat lighting from the ray tracer, or null for unlit colours. */
  lightTex: WebGLTexture | null;
  /** 0..1: how much of the ray-traced lighting to show (it fades in and out). */
  lightMix: number;
  /** How lightTex is laid out (Lighting.lightLayout). */
  lightLayout: readonly [number, number, number, number];
  minPx: number;
  /** 0..1 bloom strength (it fades rather than switching). */
  bloom: number;
  seed: number;
  /** Tangential projection (OpenUSD, RealityKit) instead of the 3DGS perspective (EWA) projection. */
  tangential: boolean;
}

const BLOOM_LEVELS = 5;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  /** True when half-float render targets work (needed for bloom). */
  hdr: boolean;
  readonly dataTex: WebGLTexture;
  rows = 0;
  drawCount = 0;

  private readonly splat: WebGLProgram;
  private readonly sky: WebGLProgram;
  private readonly down: WebGLProgram;
  private readonly up: WebGLProgram;
  private readonly composite: WebGLProgram;
  private readonly us;
  private readonly uk;
  private readonly ud;
  private readonly uu;
  private readonly uc;
  private readonly vao: WebGLVertexArrayObject;
  private readonly empty: WebGLVertexArrayObject;
  private readonly order: WebGLBuffer;
  private readonly neutral: WebGLTexture;
  /** Higher-order spherical harmonics for captures; a 1×1 placeholder otherwise. */
  private readonly shTex: WebGLTexture;
  private scene: Target | null = null;
  private mips: Target[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser has no WebGL2. Try a current Chrome, Edge, Firefox or Safari.');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');

    const withSky = (source: string): string => source.replace('#include "sky.glsl"', skyGlsl);
    this.splat = compile(gl, withSky(splatVert), splatFrag);
    this.sky = compile(gl, fullscreenVert, withSky(skyFrag));
    this.down = compile(gl, fullscreenVert, bloomDownFrag);
    this.up = compile(gl, fullscreenVert, bloomUpFrag);
    this.composite = compile(gl, fullscreenVert, compositeFrag);
    this.us = uniforms(gl, this.splat, [
      'u_tex', 'u_sh', 'u_light', 'u_proj', 'u_view', 'u_focal', 'u_vp', 'u_tanFov', 'u_camPos', 'u_shRot', 'u_shDegree',
      'u_shTexels', 'u_aa', 'u_useLight', 'u_lightMix', 'u_lightLayout', 'u_minPx', 'u_fogD', 'u_fogC', 'u_sun', 'u_reflect',
      'u_projection', 'u_layers', 'u_eagle', 'u_eagleInv', 'u_evaVis', 'u_dust', 'u_engine', 'u_time',
    ] as const);
    this.uk = uniforms(gl, this.sky, ['u_r', 'u_u', 'u_f', 'u_sun', 'u_th', 'u_asp'] as const);
    this.ud = uniforms(gl, this.down, ['u_src', 'u_tx', 'u_th'] as const);
    this.uu = uniforms(gl, this.up, ['u_src', 'u_tx', 'u_k'] as const);
    this.uc = uniforms(gl, this.composite, ['u_scene', 'u_bloom', 'u_bloomK', 'u_seed', 'u_look', 'u_encode', 'u_texel', 'u_sharpen'] as const);

    // One quad, instanced once per splat; the instance attribute is the sorted splat index.
    this.vao = must(gl.createVertexArray(), 'a vertex array');
    gl.bindVertexArray(this.vao);
    const quad = must(gl.createBuffer(), 'a buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.splat, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.order = must(gl.createBuffer(), 'a buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.order);
    const aIdx = gl.getAttribLocation(this.splat, 'a_idx');
    gl.enableVertexAttribArray(aIdx);
    gl.vertexAttribIPointer(aIdx, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(aIdx, 1);
    gl.bindVertexArray(null);
    this.empty = must(gl.createVertexArray(), 'a vertex array');

    this.dataTex = must(gl.createTexture(), 'a texture');
    this.neutral = must(gl.createTexture(), 'a texture');
    gl.bindTexture(gl.TEXTURE_2D, this.neutral);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
    this.shTex = must(gl.createTexture(), 'a texture');
    this.uploadSh();
  }

  /** Uploads the capture's spherical harmonics (or a placeholder so the integer sampler stays valid). */
  private uploadSh(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.shTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (asset.shDegree && asset.sh) {
      const width = 512 * asset.shTexels, rows = asset.sh.length / (width * 8);
      if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || rows > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('This capture is too large for this GPU.');
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, width, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, new Uint32Array(asset.sh.buffer, asset.sh.byteOffset, asset.sh.length / 2));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 1, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, new Uint32Array(4));
    }
  }

  /** Packs every splat into the RGBA32UI data texture: 2 texels per splat, 1024 splats per row. */
  upload(s: SplatStore): void {
    const gl = this.gl, n = s.count, rows = Math.max(1, Math.ceil(n / 1024));
    if (rows > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('Too many splats for this GPU. Try a lower density.');
    const data = new Uint32Array(2048 * rows * 4);
    const f = new Float32Array(data.buffer), u8 = new Uint8Array(data.buffer);
    for (let i = 0; i < n; i++) {
      const b = i * 8, c = i * 6, q = (b + 3) * 4;
      f[b] = s.pos[i * 3]!;
      f[b + 1] = s.pos[i * 3 + 1]!;
      f[b + 2] = s.pos[i * 3 + 2]!;
      u8[q] = s.col[i * 4]!;
      u8[q + 1] = s.col[i * 4 + 1]!;
      u8[q + 2] = s.col[i * 4 + 2]!;
      u8[q + 3] = s.col[i * 4 + 3]!;
      data[b + 4] = toHalf(s.cov[c]!) | (toHalf(s.cov[c + 1]!) << 16);
      data[b + 5] = toHalf(s.cov[c + 2]!) | (toHalf(s.cov[c + 3]!) << 16);
      data[b + 6] = toHalf(s.cov[c + 4]!) | (toHalf(s.cov[c + 5]!) << 16);
      data[b + 7] = s.em[i]! | (s.nrm[i]! << 16);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 2048, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
    this.uploadSh();
    this.rows = rows;
    this.drawCount = 0;
  }

  /** New back-to-front order from the sort worker. */
  setOrder(order: Uint32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.order);
    gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
    this.drawCount = order.length;
  }

  render(p: FrameParams, sceneW: number, sceneH: number, outW: number, outH: number): void {
    const gl = this.gl;
    const scene = this.targets(sceneW, sceneH);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fb);
    gl.viewport(0, 0, sceneW, sceneH);
    gl.disable(gl.BLEND);
    gl.useProgram(this.sky);
    gl.uniform3fv(this.uk.u_r, p.right);
    gl.uniform3fv(this.uk.u_u, p.up);
    gl.uniform3fv(this.uk.u_f, p.fwd);
    gl.uniform3fv(this.uk.u_sun, p.sun);
    gl.uniform1f(this.uk.u_th, p.tanHalf);
    gl.uniform1f(this.uk.u_asp, p.aspect);
    this.fullscreen();

    if (this.drawCount) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.splat);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      gl.uniform1i(this.us.u_tex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, p.lightTex ?? this.neutral);
      gl.uniform1i(this.us.u_light, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.shTex);
      gl.uniform1i(this.us.u_sh, 2);
      gl.uniformMatrix4fv(this.us.u_proj, false, p.proj);
      gl.uniformMatrix4fv(this.us.u_view, false, p.view);
      gl.uniform2f(this.us.u_focal, p.focal, p.focal);
      gl.uniform2f(this.us.u_vp, sceneW, sceneH);
      gl.uniform2f(this.us.u_tanFov, p.tanHalf * p.aspect, p.tanHalf);
      gl.uniform3fv(this.us.u_camPos, p.eye);
      gl.uniformMatrix3fv(this.us.u_shRot, false, asset.shRot);
      gl.uniform1i(this.us.u_shDegree, asset.shDegree);
      gl.uniform1i(this.us.u_shTexels, asset.shTexels);
      gl.uniform1i(this.us.u_aa, asset.aa === 'mip' ? 2 : asset.aa === 'aa' ? 1 : 0);
      gl.uniform1f(this.us.u_useLight, p.lightTex ? 1 : 0);
      gl.uniform1f(this.us.u_lightMix, p.lightMix);
      gl.uniform4i(this.us.u_lightLayout, ...p.lightLayout);
      gl.uniform1f(this.us.u_minPx, p.minPx);
      gl.uniform1f(this.us.u_fogD, p.fogDensity);
      gl.uniform3fv(this.us.u_fogC, p.fogColor);
      gl.uniform3fv(this.us.u_sun, p.sun);
      gl.uniform4i(this.us.u_layers, ...p.layers);
      gl.uniformMatrix4fv(this.us.u_eagle, false, p.eagle);
      gl.uniformMatrix4fv(this.us.u_eagleInv, false, p.eagleInv);
      gl.uniform1f(this.us.u_evaVis, p.evaVis);
      gl.uniform1f(this.us.u_dust, p.dust);
      gl.uniform1f(this.us.u_engine, p.engine);
      gl.uniform1f(this.us.u_time, p.time);
      gl.uniform1f(this.us.u_reflect, p.look ? 1 : 0);
      gl.uniform1i(this.us.u_projection, p.tangential ? 1 : 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.drawCount);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    const bloom = p.bloom > 0.002 && p.look && this.hdr && this.mips.length === BLOOM_LEVELS;
    if (bloom) {
      gl.useProgram(this.down);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.ud.u_src, 0);
      let src: Target = scene;
      this.mips.forEach((dst, i) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(this.ud.u_tx, 1 / src.w, 1 / src.h);
        gl.uniform1f(this.ud.u_th, i === 0 ? 1.6 : 0);
        this.fullscreen();
        src = dst;
      });
      gl.useProgram(this.up);
      gl.uniform1i(this.uu.u_src, 0);
      gl.uniform1f(this.uu.u_k, 1);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
        const from = this.mips[i]!, to = this.mips[i - 1]!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb);
        gl.viewport(0, 0, to.w, to.h);
        gl.bindTexture(gl.TEXTURE_2D, from.tex);
        gl.uniform2f(this.uu.u_tx, 1 / from.w, 1 / from.h);
        this.fullscreen();
      }
      gl.disable(gl.BLEND);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.composite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(this.uc.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloom ? this.mips[0]!.tex : this.neutral);
    gl.uniform1i(this.uc.u_bloom, 1);
    gl.uniform1f(this.uc.u_bloomK, bloom ? 0.3 * p.bloom : 0);
    gl.uniform1f(this.uc.u_seed, p.seed);
    gl.uniform2f(this.uc.u_texel, 1 / sceneW, 1 / sceneH);
    // Contrast-adaptive sharpening for the generated scene (more when rendering below full size).
    gl.uniform1f(this.uc.u_sharpen, p.look ? Math.min(1, 0.45 + 0.8 * (1 - sceneW / Math.max(1, outW))) : 0);
    gl.uniform1f(this.uc.u_look, p.look ? 1 : 0);
    gl.uniform1f(this.uc.u_encode, asset.linear ? 1 : 0);
    this.fullscreen();
    gl.activeTexture(gl.TEXTURE0);
  }

  private fullscreen(): void {
    this.gl.bindVertexArray(this.empty);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    this.gl.bindVertexArray(null);
  }

  private targets(w: number, h: number): Target {
    if (this.scene && this.scene.w === w && this.scene.h === h) return this.scene;
    const gl = this.gl;
    deleteTarget(gl, this.scene);
    for (const m of this.mips) deleteTarget(gl, m);
    this.mips = [];
    let scene = createTarget(gl, w, h, this.hdr);
    if (!scene && this.hdr) {
      this.hdr = false;
      scene = createTarget(gl, w, h, false);
    }
    this.scene = must(scene, 'a render target');
    if (this.hdr) {
      let mw = w, mh = h;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        mw = Math.max(1, mw >> 1);
        mh = Math.max(1, mh >> 1);
        const t = createTarget(gl, mw, mh, true);
        if (!t) break;
        this.mips.push(t);
      }
    }
    return this.scene;
  }
}
