// Accent choices offered in Appearance. Kept out of the components so no hex lives in markup.
export interface AccentChoice {
  id: string;
  label: string;
  hex: string;
}

export const ACCENTS: readonly AccentChoice[] = [
  { id: 'green', label: 'Green', hex: '#4ade80' },
  { id: 'blue', label: 'Blue', hex: '#60a5fa' },
  { id: 'violet', label: 'Violet', hex: '#a78bfa' },
  { id: 'pink', label: 'Pink', hex: '#f472b6' },
  { id: 'orange', label: 'Orange', hex: '#fb923c' },
  { id: 'yellow', label: 'Yellow', hex: '#facc15' },
  { id: 'teal', label: 'Teal', hex: '#2dd4bf' },
  { id: 'red', label: 'Red', hex: '#f87171' },
];

/** Starting value for the colour picker when a theme's own accent cannot be read. */
export const FALLBACK_ACCENT = '#4ade80';
