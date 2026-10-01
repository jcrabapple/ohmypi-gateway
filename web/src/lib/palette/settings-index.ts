// What the settings overlay contains, as data: the pages, and every setting on them.
// The settings search and the command palette both read this, so a match can jump
// straight to the page and highlight the setting.
import { fuzzyScoreAll } from './fuzzy';

export type SettingsPageId =
  | 'appearance' | 'agent' | 'models' | 'skills' | 'usage' | 'connection' | 'shortcuts';

export interface SettingsPage {
  id: SettingsPageId;
  title: string;
  blurb: string;
}

export interface SettingsEntry {
  /** Anchor: the element with id `setting-<id>` on the page. */
  id: string;
  page: SettingsPageId;
  label: string;
  keywords: string;
}

export interface SettingsTarget {
  page: SettingsPageId;
  entry?: string;
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: 'appearance', title: 'Appearance', blurb: 'Theme, accent, density, width and fonts' },
  { id: 'agent', title: 'Agent config', blurb: 'Edit the omp config file' },
  { id: 'models', title: 'Models', blurb: 'Browse the model catalog' },
  { id: 'skills', title: 'Skills', blurb: 'Skills installed on the gateway host' },
  { id: 'usage', title: 'Usage', blurb: 'Provider usage and limits' },
  { id: 'connection', title: 'Connection', blurb: 'Versions, uptime and sign out' },
  { id: 'shortcuts', title: 'Shortcuts', blurb: 'Every keyboard shortcut' },
];

export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  { id: 'theme', page: 'appearance', label: 'Theme', keywords: 'preset dark light terminal graphite paper high contrast colors' },
  { id: 'follow-system', page: 'appearance', label: 'Follow system appearance', keywords: 'auto os light dark match' },
  { id: 'accent', page: 'appearance', label: 'Accent colour', keywords: 'accent color custom swatch highlight' },
  { id: 'density', page: 'appearance', label: 'Density', keywords: 'compact comfortable spacing tight' },
  { id: 'width', page: 'appearance', label: 'Transcript width', keywords: 'reading wide column measure' },
  { id: 'prose', page: 'appearance', label: 'Prose font', keywords: 'font sans mono monospace typeface text' },
  { id: 'config', page: 'agent', label: 'Agent config file', keywords: 'yaml config.yml editor save default model edit omp' },
  { id: 'catalog', page: 'models', label: 'Model catalog', keywords: 'models provider context price search use switch' },
  { id: 'skill-list', page: 'skills', label: 'Installed skills', keywords: 'skill description installed' },
  { id: 'usage-report', page: 'usage', label: 'Usage report', keywords: 'usage limits quota tokens cost provider' },
  { id: 'versions', page: 'connection', label: 'Gateway and omp versions', keywords: 'version uptime gateway omp live sessions system' },
  { id: 'push', page: 'connection', label: 'Push notifications', keywords: 'push notification needs you approval dialog subscribe device vapid' },
  { id: 'sign-out', page: 'connection', label: 'Sign out', keywords: 'logout log out session cookie' },
  { id: 'keys', page: 'shortcuts', label: 'Keyboard shortcuts', keywords: 'keys hotkeys keyboard bindings' },
];

export function pageTitle(id: SettingsPageId): string {
  return SETTINGS_PAGES.find((p) => p.id === id)?.title ?? id;
}

export interface SettingsHit {
  entry: SettingsEntry;
  page: SettingsPage;
  score: number;
}

/** Settings whose label, page or keywords match, best first. An empty query matches nothing. */
export function searchSettings(query: string): SettingsHit[] {
  if (!query.trim()) return [];
  const hits: SettingsHit[] = [];
  for (const entry of SETTINGS_ENTRIES) {
    const page = SETTINGS_PAGES.find((p) => p.id === entry.page)!;
    const score = fuzzyScoreAll(query, entry.label, [page.title, entry.keywords]);
    if (score >= 0) hits.push({ entry, page, score });
  }
  // Stable: equal scores keep the order they are listed in.
  return hits.sort((a, b) => b.score - a.score);
}
