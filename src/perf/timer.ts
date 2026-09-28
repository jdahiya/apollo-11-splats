// GPU frame timing via EXT_disjoint_timer_query_webgl2, where the browser exposes it
// (most desktop Chrome and Edge; usually not on phones).

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  readonly available: boolean;
  private readonly ext: TimerQueryExt | null;
  private readonly pending: WebGLQuery[] = [];
  private current: WebGLQuery | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    this.available = !!this.ext;
  }

  begin(): void {
    if (!this.ext || this.current || this.pending.length > 6) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.current = q;
  }

  end(): void {
    if (!this.ext || !this.current) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.current);
    this.current = null;
  }

  /** Reports finished queries, oldest first. Results arrive a few frames late. */
  poll(onResult: (ms: number) => void): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      gl.deleteQuery(q);
      if (!disjoint) onResult(ns / 1e6);
    }
  }
}
