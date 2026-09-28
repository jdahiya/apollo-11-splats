// Mouse, touch and keyboard input for the camera.
import type { Camera } from './camera';

export interface ControlHooks {
  /** The user took control: stop tours and auto-rotation. */
  interact(): void;
  /** Something changed that needs a frame. */
  wake(): void;
}

interface Pointer {
  x: number;
  y: number;
  button: number;
}

const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

export class Controls {
  readonly keys = new Set<string>();
  private readonly pointers = new Map<number, Pointer>();
  private pinch: { cx: number; cy: number; d: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly camera: Camera, private readonly hooks: ControlHooks) {
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.moveTo(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Applies held movement keys; returns true if the camera moved. */
  update(dt: number): boolean {
    if (!this.keys.size) return false;
    const k = this.keys, has = (...names: string[]): boolean => names.some((n) => k.has(n));
    const speed = Math.max(4, this.camera.dist * 0.6) * (k.has('shift') ? 3 : 1) * dt;
    const forward = (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0);
    const right = (has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0);
    const up = (has('e') ? 1 : 0) - (has('q') ? 1 : 0);
    if (!forward && !right && !up) return false;
    this.camera.move(forward * speed, right * speed, up * speed);
    return true;
  }

  private down(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.classList.add('dragging');
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    this.pinch = null;
    this.hooks.interact();
    this.hooks.wake();
  }

  private moveTo(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 1) {
      if (p.button === 1 || p.button === 2 || e.shiftKey) this.camera.pan(dx, dy, this.canvas.clientHeight);
      else this.camera.orbit(dx, dy);
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Pointer, Pointer];
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch) {
        this.camera.zoom((this.pinch.d - d) * 4);
        this.camera.pan(cx - this.pinch.cx, cy - this.pinch.cy, this.canvas.clientHeight);
      }
      this.pinch = { cx, cy, d };
    }
    this.hooks.wake();
  }

  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = null;
    if (!this.pointers.size) this.canvas.classList.remove('dragging');
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.hooks.interact();
    this.camera.zoom(e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY);
    this.hooks.wake();
  }

  private keyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, select, textarea')) return;
    const key = e.key.toLowerCase();
    if (key === 'shift') this.keys.add(key);
    if (!MOVE_KEYS.has(key)) return;
    if (key.startsWith('arrow')) e.preventDefault();
    this.keys.add(key);
    this.hooks.interact();
    this.hooks.wake();
  }
}
