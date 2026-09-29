import { device } from '../platform/storage';

export type Theme = 'terminal' | 'graphite' | 'paper' | 'contrast';
export type Density = 'comfortable' | 'compact';
export type Width = 'reading' | 'wide';
export type ProseFont = 'sans' | 'mono';

export const THEMES: readonly Theme[] = ['terminal', 'graphite', 'paper', 'contrast'];

export interface SettingsData {
  theme: Theme;
  /** Hex like #22c55e, or null for the theme's own accent. */
  accent: string | null;
  density: Density;
  width: Width;
  proseFont: ProseFont;
  /** Use `paper` when the OS is light, and the chosen dark theme otherwise. */
  followSystem: boolean;
}

const DEFAULTS: SettingsData = {
  theme: 'terminal',
  accent: null,
  density: 'comfortable',
  width: 'reading',
  proseFont: 'sans',
  followSystem: false,
};

const KEY = 'settings';
const HEX = /^#[0-9a-f]{6}$/i;

export function sanitizeSettings(raw: unknown): SettingsData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
    allowed.includes(v as T) ? (v as T) : fb;
  return {
    theme: pick(r.theme, THEMES, DEFAULTS.theme),
    accent: typeof r.accent === 'string' && HEX.test(r.accent) ? r.accent : null,
    density: pick(r.density, ['comfortable', 'compact'], DEFAULTS.density),
    width: pick(r.width, ['reading', 'wide'], DEFAULTS.width),
    proseFont: pick(r.proseFont, ['sans', 'mono'], DEFAULTS.proseFont),
    followSystem: r.followSystem === true,
  };
}

class SettingsStore {
  data = $state<SettingsData>(sanitizeSettings(device.get<unknown>(KEY, null)));
  systemLight = $state(false);

  /** Theme after `followSystem` is applied. */
  get effectiveTheme(): Theme {
    if (!this.data.followSystem) return this.data.theme;
    if (this.systemLight) return 'paper';
    return this.data.theme === 'paper' ? 'terminal' : this.data.theme;
  }

  update(patch: Partial<SettingsData>): void {
    this.data = sanitizeSettings({ ...this.data, ...patch });
    device.set(KEY, this.data);
    this.apply();
  }

  reset(): void {
    this.data = { ...DEFAULTS };
    device.remove(KEY);
    this.apply();
  }

  /** Write the settings onto <html>. Call once at startup; `update` calls it after that. */
  apply(root: HTMLElement = document.documentElement): void {
    root.dataset.theme = this.effectiveTheme;
    root.dataset.density = this.data.density;
    root.dataset.width = this.data.width;
    root.dataset.prose = this.data.proseFont;
    if (this.data.accent) root.style.setProperty('--accent', this.data.accent);
    else root.style.removeProperty('--accent');
  }

  /** Track the OS color scheme. Returns a stop function. */
  watchSystem(): () => void {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return () => {};
    const on = () => {
      this.systemLight = mq.matches;
      this.apply();
    };
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }
}

export const settings = new SettingsStore();
