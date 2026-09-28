// Power and battery estimates. Browsers don't expose power draw, so this models it from how
// busy the GPU and CPU are, using typical figures for the device class. Where the Battery Status
// API exists, the real level is shown too, with a measured drain once the level has dropped.

export type DeviceKind = 'phone' | 'laptop' | 'desktop';

export interface PowerProfile {
  kind: DeviceKind;
  label: string;
  /** Battery capacity in watt-hours; 0 for mains-powered machines. */
  batteryWh: number;
  /** Watts with the page open but idle (screen and system baseline). */
  base: number;
  /** Extra watts at full GPU / CPU load. */
  gpuMax: number;
  cpuMax: number;
  /** Rough GPU cost model, used when the GPU timer is unavailable. */
  msPerMillionSplats: number;
  msPerMegapixel: number;
  msPer100kRelit: number;
}

const PROFILES: Record<DeviceKind, PowerProfile> = {
  phone: { kind: 'phone', label: 'Phone', batteryWh: 15, base: 0.9, gpuMax: 3.5, cpuMax: 2.5, msPerMillionSplats: 9, msPerMegapixel: 5, msPer100kRelit: 3 },
  laptop: { kind: 'laptop', label: 'Laptop', batteryWh: 60, base: 6, gpuMax: 25, cpuMax: 18, msPerMillionSplats: 2, msPerMegapixel: 0.9, msPer100kRelit: 0.7 },
  desktop: { kind: 'desktop', label: 'Desktop', batteryWh: 0, base: 30, gpuMax: 160, cpuMax: 60, msPerMillionSplats: 1, msPerMegapixel: 0.4, msPer100kRelit: 0.3 },
};

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
  chargingTime: number;
}

export class PowerModel {
  profile: PowerProfile;
  batteryLevel: number | null = null;
  charging: boolean | null = null;
  /** Whole-device drain measured from the battery level, percent per hour. */
  measuredPerHour: number | null = null;
  private mark: { t: number; level: number } | null = null;

  constructor(isPhone: boolean) {
    this.profile = PROFILES[isPhone ? 'phone' : 'laptop'];
  }

  async connectBattery(): Promise<void> {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (!nav.getBattery) return;
    try {
      const b = await nav.getBattery();
      // Chrome reports a permanently full, charging battery on machines without one.
      if (this.profile.kind !== 'phone' && b.charging && b.level === 1 && b.chargingTime === 0) this.profile = PROFILES.desktop;
      const update = (): void => {
        this.batteryLevel = b.level;
        this.charging = b.charging;
        if (b.charging) {
          this.mark = null;
          this.measuredPerHour = null;
          return;
        }
        const now = performance.now();
        if (!this.mark) this.mark = { t: now, level: b.level };
        else if (this.mark.level - b.level >= 0.01 && now - this.mark.t > 120_000) {
          this.measuredPerHour = ((this.mark.level - b.level) / ((now - this.mark.t) / 3.6e6)) * 100;
        }
      };
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
      update();
    } catch {
      // Battery information is blocked here; estimates still work.
    }
  }

  /** Modelled GPU milliseconds for one frame. */
  estimateGpuMs(splats: number, pixels: number, relit: number): number {
    const p = this.profile;
    return (p.msPerMillionSplats * splats) / 1e6 + (p.msPerMegapixel * pixels) / 1e6 + (p.msPer100kRelit * relit) / 1e5;
  }

  /** gpuBusy and cpuBusy are fractions of wall time (0..1). */
  watts(gpuBusy: number, cpuBusy: number): number {
    const p = this.profile;
    return p.base + p.gpuMax * gpuBusy + p.cpuMax * cpuBusy;
  }

  /** Percent of a full battery per hour at this draw, or null on mains power. */
  drainPerHour(watts: number): number | null {
    if (!this.profile.batteryWh || this.charging) return null;
    return (watts / this.profile.batteryWh) * 100;
  }
}
