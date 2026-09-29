// highlight.js core with a fixed language set. No auto-detection: an unlabeled
// or unknown fence stays plain, which is faster and never guesses wrong.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { escapeHtml } from './escape';

const LANGUAGES = {
  typescript, javascript, python, bash, shell, json, yaml, diff, css, xml, go, rust, sql, markdown, ini, dockerfile,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

/** Skip highlighting past this size; a huge paste would block the main thread. */
const MAX_HIGHLIGHT_CHARS = 60_000;

export interface Highlighted {
  /** Safe HTML: highlight.js output, or the escaped source. */
  html: string;
  /** Canonical language name when highlighted, else null. */
  language: string | null;
}

export function highlightCode(code: string, lang?: string | null): Highlighted {
  const name = lang?.trim().toLowerCase();
  if (name && code.length <= MAX_HIGHLIGHT_CHARS && hljs.getLanguage(name)) {
    try {
      const r = hljs.highlight(code, { language: name, ignoreIllegals: true });
      return { html: r.value, language: r.language ?? name };
    } catch {
      // fall through to plain text
    }
  }
  return { html: escapeHtml(code), language: null };
}
