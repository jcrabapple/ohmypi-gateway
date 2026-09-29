// Small fuzzy matcher shared by the palette and the settings search. Higher is better,
// -1 means no match. Every space-separated word of the query must match somewhere.

const norm = (s: string) => s.toLowerCase();

function wordStarts(hay: string): number[] {
  const starts: number[] = [];
  for (let i = 0; i < hay.length; i++) {
    if (i === 0 || /[\s\-_:/.>]/.test(hay[i - 1]!)) starts.push(i);
  }
  return starts;
}

function subsequence(needle: string, hay: string): number {
  let at = -1;
  let gaps = 0;
  for (const ch of needle) {
    const next = hay.indexOf(ch, at + 1);
    if (next < 0) return -1;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, 100 - gaps);
}

function scoreWord(word: string, hay: string): number {
  if (hay === word) return 1000;
  if (hay.startsWith(word)) return 800 - Math.min(hay.length - word.length, 100);
  if (wordStarts(hay).some((i) => hay.startsWith(word, i))) return 600 - Math.min(hay.indexOf(word), 100);
  const at = hay.indexOf(word);
  if (at >= 0) return 400 - Math.min(at, 100);
  // Fuzzy runs only for longer words; two letters matching across a title is noise.
  return word.length >= 3 ? subsequence(word, hay) : -1;
}

/** Score one string against a query. */
export function fuzzyScore(query: string, text: string): number {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hay = norm(text);
  let total = 0;
  for (const w of words) {
    const s = scoreWord(w, hay);
    if (s < 0) return -1;
    total += s;
  }
  return total / words.length;
}

/** Best of a primary string and weaker secondary strings (folder, keywords). */
export function fuzzyScoreAll(query: string, primary: string, secondary: readonly (string | undefined)[] = []): number {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const p = norm(primary);
  const rest = secondary.filter((x): x is string => !!x).map(norm);
  let total = 0;
  for (const w of words) {
    let best = scoreWord(w, p);
    for (const r of rest) {
      const s = scoreWord(w, r);
      if (s >= 0) best = Math.max(best, s * 0.5);
    }
    if (best < 0) return -1;
    total += best;
  }
  return total / words.length;
}
