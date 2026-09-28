// Draws a frame: sorted splats over black space into a float buffer, then the composite to screen.
import compositeFrag from './shaders/composite.frag';
import fullscreenVert from './shaders/fullscreen.vert';
import splatFrag from './shaders/splat.frag';
import splatVert from './shaders/splat.vert';
import { compile, createTarget, deleteTarget, must, uniforms, type Target } from './gl';
import { asset, type SplatStore } from '../splats/store';
import { toHalf } from '../util/half';
import type { Vec3 } from '../util/math';

export interface FrameParams {
  view: Float32Array;
  proj: Float32Array;
  focal: number;
  eye: Vec3;
  tanHalf: number;
  aspect: number;
  /** Splats smaller than this many pixels fade out. */
  minPx: number;
  /** Tangential projection (OpenUSD, RealityKit) instead of the 3DGS perspective (EWA) projection. */
  tangential: boolean;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  /** True when half-float render targets work (smoother blending of thousands of layers). */
  hdr: boolean;
  readonly dataTex: WebGLTexture;
  rows = 0;
  drawCount = 0;

  private readonly splat: WebGLProgram;
  private readonly composite: WebGLProgram;
  private readonly us;
  private readonly uc;
  private readonly vao: WebGLVertexArrayObject;
  private readonly empty: WebGLVertexArrayObject;
  private readonly order: WebGLBuffer;
  /** Higher-order spherical harmonics; a 1×1 placeholder when there are none. */
  private readonly shTex: WebGLTexture;
  private scene: Target | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser has no WebGL2. Try a current Chrome, Edge, Firefox or Safari.');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');

    this.splat = compile(gl, splatVert, splatFrag);
    this.composite = compile(gl, fullscreenVert, compositeFrag);
    this.us = uniforms(gl, this.splat, [
      'u_tex', 'u_sh', 'u_proj', 'u_view', 'u_focal', 'u_vp', 'u_tanFov', 'u_camPos', 'u_shRot', 'u_shDegree',
      'u_shTexels', 'u_aa', 'u_minPx', 'u_projection',
    ] as const);
    this.uc = uniforms(gl, this.composite, ['u_scene', 'u_encode', 'u_texel', 'u_sharpen'] as const);

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
    this.shTex = must(gl.createTexture(), 'a texture');
    this.uploadSh();
  }

  /** Uploads the spherical harmonics (or a placeholder so the integer sampler stays valid). */
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

  /** Packs the first `count` splats into the RGBA32UI data texture: 2 texels per splat, 1024 splats per row. */
  upload(s: SplatStore, count = s.count): void {
    const gl = this.gl, n = Math.min(count, s.count), rows = Math.max(1, Math.ceil(n / 1024));
    if (rows > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('Too many splats for this GPU. Try a lighter detail level.');
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
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.drawCount) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.splat);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
      gl.uniform1i(this.us.u_tex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.shTex);
      gl.uniform1i(this.us.u_sh, 1);
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
      gl.uniform1f(this.us.u_minPx, p.minPx);
      gl.uniform1i(this.us.u_projection, p.tangential ? 1 : 0);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.drawCount);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.composite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(this.uc.u_scene, 0);
    gl.uniform2f(this.uc.u_texel, 1 / sceneW, 1 / sceneH);
    // Sharpen only to make up for rendering below full size.
    gl.uniform1f(this.uc.u_sharpen, Math.max(0, Math.min(1, 1.2 * (1 - sceneW / Math.max(1, outW)))));
    gl.uniform1f(this.uc.u_encode, asset.linear ? 1 : 0);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private targets(w: number, h: number): Target {
    if (this.scene && this.scene.w === w && this.scene.h === h) return this.scene;
    const gl = this.gl;
    deleteTarget(gl, this.scene);
    let scene = createTarget(gl, w, h, this.hdr);
    if (!scene && this.hdr) {
      this.hdr = false;
      scene = createTarget(gl, w, h, false);
    }
    this.scene = must(scene, 'a render target');
    return this.scene;
  }
}
