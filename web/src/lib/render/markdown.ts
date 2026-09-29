// Markdown to safe HTML for assistant text. Pipeline:
//   marked (GFM) -> DOMPurify -> code blocks highlighted and given a header.
// Only our own markup is added after sanitizing, and highlight.js output is
// escaped, so nothing model-controlled reaches the page unsanitized.
// Partial input is fine: an unclosed fence renders as a code block, unclosed
// emphasis stays literal.
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import { Marked } from 'marked';
import { escapeHtml } from './escape';
import { highlightCode } from './highlight';

const marked = new Marked({ gfm: true, breaks: false });

const SANITIZE: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'link', 'meta'],
  FORBID_ATTR: ['style', 'srcset', 'formaction'],
  RETURN_DOM_FRAGMENT: true,
};

const LANG = /^[\w#+.-]{1,24}$/;
const CACHE_MAX = 300;
const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) {
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  let html: string;
  try {
    html = build(src);
  } catch {
    html = `<p>${escapeHtml(src)}</p>`;
  }
  cache.set(src, html);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return html;
}

function build(src: string): string {
  const raw = marked.parse(src, { async: false });
  const frag = DOMPurify.sanitize(raw, SANITIZE);
  const doc = frag.ownerDocument;

  for (const a of frag.querySelectorAll('a')) {
    if (!a.getAttribute('href')) continue;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }

  // Remote images from model output would be an exfiltration channel. Show a link instead.
  for (const img of frag.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (/^https?:\/\//i.test(src)) {
      const a = doc.createElement('a');
      a.setAttribute('href', src);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = img.getAttribute('alt') || 'image';
      img.replaceWith(a);
    } else {
      img.remove();
    }
  }

  for (const box of frag.querySelectorAll('input')) {
    if (box.getAttribute('type') === 'checkbox') box.setAttribute('disabled', '');
    else box.remove();
  }

  for (const table of frag.querySelectorAll('table')) {
    const wrap = doc.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }

  for (const pre of frag.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const cls = code?.getAttribute('class') ?? '';
    const lang = /(?:^|\s)language-([^\s]+)/.exec(cls)?.[1];
    const source = (code ?? pre).textContent ?? '';
    const h = highlightCode(source, lang);

    const body = doc.createElement('code');
    body.className = `hljs${h.language ? ` language-${h.language}` : ''}`;
    body.innerHTML = h.html;
    const newPre = doc.createElement('pre');
    newPre.appendChild(body);

    const head = doc.createElement('div');
    head.className = 'code-head';
    const label = doc.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang && LANG.test(lang) ? lang : '';
    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'code-copy';
    copy.setAttribute('data-code-copy', '');
    copy.setAttribute('aria-label', 'Copy code');
    copy.textContent = 'Copy';
    head.append(label, copy);

    const block = doc.createElement('div');
    block.className = 'code-block';
    block.append(head, newPre);
    pre.replaceWith(block);
  }

  const holder = doc.createElement('div');
  holder.appendChild(frag);
  return holder.innerHTML;
}

/** Text a `[data-code-copy]` button should copy, for the component's click handler. */
export function codeTextFor(button: Element): string {
  return button.closest('.code-block')?.querySelector('pre code')?.textContent ?? '';
}
