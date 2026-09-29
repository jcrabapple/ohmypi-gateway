<script lang="ts">
  // One file's diff: op badge, path, +/- counts, unified or split body with
  // word-level marks and syntax highlighting. All row text goes through the
  // escaped highlight pipeline; markHtml only adds <mark> tags around slices.
  import { extLang, parseOmpDiff, rowMarks, type DiffRow, type FileChange } from '../../lib/render/diff2';
  import { highlightCode } from '../../lib/render/highlight';
  import { markHtml, type Range } from '../../lib/render/wordmarks';
  import { copyText } from '../../lib/platform/clipboard';
  import { ui } from '../../lib/state';
  import { Icon, Segmented, toast } from '../../lib/ui';

  type Mode = 'unified' | 'split';

  let { file, mode = null }: { file: FileChange; mode?: Mode | null } = $props();

  const MAX_ROWS = 400;
  const WIDE_PX = 1000;
  const MODES: readonly { id: Mode; label: string }[] = [
    { id: 'unified', label: 'Unified' },
    { id: 'split', label: 'Split' },
  ];

  let picked: Mode | null = $state(null);
  let showAll = $state(false);
  let wide = $state(false);
  let block: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver((entries) => {
      wide = (entries[0]?.contentRect.width ?? 0) > WIDE_PX;
    });
    if (block) ro.observe(block);
    return () => ro.disconnect();
  });

  const parsed = $derived(parseOmpDiff(file.diff));
  // Word marks pair -/+ runs within one hunk; hunks are independent regions of
  // the file, so a del at the end of one hunk never pairs with an add in the next.
  const marks = $derived.by(() => {
    const out = new Map<number, Range>();
    let offset = 0;
    for (const h of parsed.hunks) {
      for (const [k, r] of rowMarks(h.lines)) out.set(offset + k, r);
      offset += h.lines.length;
    }
    return out;
  });
  const lang = $derived(extLang(file.path));
  const shortPath = $derived.by(() => {
    const parts = file.path.replace(/\\/g, '/').split('/');
    return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : file.path;
  });
  const badge = $derived(
    file.created || file.op === 'create' ? 'A' : file.op === 'write' ? 'W' : file.op === 'delete' ? 'D' : 'M',
  );
  const badgeTone = $derived(file.op === 'delete' ? 'del' : file.created || file.op === 'create' ? 'add' : 'mod');
  const showToggle = $derived(!file.created && mode === null);
  const effective = $derived<Mode>(
    file.created ? 'unified' : (mode ?? picked ?? (wide ? 'split' : 'unified')),
  );

  interface Cell {
    row: DiffRow;
    mark?: Range;
  }
  interface Row {
    key: string;
    kind: 'row';
    row: DiffRow;
    mark?: Range;
  }
  interface Gap {
    key: string;
    kind: 'gap';
    text: string;
  }
  type URow = Row | Gap;
  interface SRow {
    key: string;
    kind: 'row';
    left?: Cell;
    right?: Cell;
  }
  type SItem = SRow | Gap;

  function gapText(a: number, b: number): string {
    return a === b ? `... line ${a}` : `... lines ${a}-${b}`;
  }

  /** Inter-hunk gap text, or null when the diff text already carries a gap note here. */
  function hunkGap(h: { lines: DiffRow[] }, lastOld: number): string | null {
    const first = h.lines[0];
    if (first?.t === 'gap') return null;
    const firstOld = h.lines.find((l) => l.o !== undefined)?.o;
    if (firstOld === undefined || lastOld <= 0 || firstOld <= lastOld + 1) return null;
    return gapText(lastOld + 1, firstOld - 1);
  }

  const rows = $derived.by(() => {
    const out: URow[] = [];
    let lastOld = 0;
    let i = 0;
    for (const h of parsed.hunks) {
      const gap = hunkGap(h, lastOld);
      if (gap) out.push({ key: `g${out.length}`, kind: 'gap', text: gap });
      for (const row of h.lines) {
        out.push(
          row.t === 'gap'
            ? { key: `r${i}`, kind: 'gap', text: row.text ? `... ${row.text}` : '...' }
            : { key: `r${i}`, kind: 'row', row, mark: marks.get(i) },
        );
        if (row.o !== undefined) lastOld = row.o;
        i += 1;
      }
    }
    return out;
  });

  const splitRows = $derived.by(() => {
    const out: SItem[] = [];
    let lastOld = 0;
    let i = 0;
    for (const h of parsed.hunks) {
      const gap = hunkGap(h, lastOld);
      if (gap) out.push({ key: `g${out.length}`, kind: 'gap', text: gap });
      let k = 0;
      while (k < h.lines.length) {
        const r = h.lines[k]!;
        if (r.t === 'ctx') {
          out.push({ key: `s${i + k}`, kind: 'row', left: { row: r }, right: { row: r } });
          k += 1;
        } else if (r.t === 'del') {
          const d0 = k;
          while (k < h.lines.length && h.lines[k]!.t === 'del') k += 1;
          const a0 = k;
          while (k < h.lines.length && h.lines[k]!.t === 'add') k += 1;
          for (let j = 0; j < Math.max(a0 - d0, k - a0); j++) {
            // Asymmetric chunks: del rows end at a0, add rows end at k. Guard
            // both indexes or an add can bleed into the left column and a
            // following context line can pair with a deletion.
            const dl = d0 + j < a0 ? h.lines[d0 + j] : undefined;
            const al = a0 + j < k ? h.lines[a0 + j] : undefined;
            out.push({
              key: `s${i + d0 + j}`,
              kind: 'row',
              ...(dl ? { left: { row: dl, mark: marks.get(i + d0 + j) } } : {}),
              ...(al ? { right: { row: al, mark: marks.get(i + a0 + j) } } : {}),
            });
          }
        } else if (r.t === 'add') {
          out.push({ key: `s${i + k}`, kind: 'row', right: { row: r, mark: marks.get(i + k) } });
          k += 1;
        } else {
          out.push({ key: `s${i + k}`, kind: 'gap', text: r.text ? `... ${r.text}` : '...' });
          k += 1;
        }
      }
      i += h.lines.length;
      for (const row of h.lines) {
        if (row.o !== undefined) lastOld = row.o;
      }
    }
    return out;
  });

  const totalLines = $derived(effective === 'split' ? splitRows.length : rows.length);
  const hidden = $derived(showAll || totalLines <= MAX_ROWS ? 0 : totalLines - MAX_ROWS);

  function chunks<T extends { key: string }>(items: readonly T[], prefix: string): { key: string; rows: T[] }[] {
    const capped = hidden > 0 ? items.slice(0, MAX_ROWS) : items;
    const out: { key: string; rows: T[] }[] = [];
    for (let i = 0; i < capped.length; i += 50) out.push({ key: `${prefix}${i}`, rows: capped.slice(i, i + 50) });
    return out;
  }

  const groups = $derived(chunks(rows, 'c'));
  const splitGroups = $derived(chunks(splitRows, 'd'));

  function rowHtml(row: DiffRow, mark: Range | undefined): string {
    const { html } = highlightCode(row.text, lang);
    return mark ? markHtml(html, mark.start, mark.end) : html;
  }

  async function copyPath() {
    if (await copyText(file.path)) toast('Copied');
  }
</script>

<div class="block" bind:this={block} aria-label="Diff for {file.path}">
  <div class="head">
    <span class="badge {badgeTone}" title={file.op}>{badge}</span>
    <span class="path truncate" title={file.path}>{shortPath}</span>
    <span class="stats mono" aria-label="{file.adds} added, {file.dels} removed">
      <span class="adds">+{file.adds}</span>
      <span class="dels">-{file.dels}</span>
    </span>
    {#if showToggle}
      <Segmented label="Diff mode" value={effective} options={MODES} onchange={(v) => (picked = v)} />
    {/if}
    <button type="button" class="icon-btn copy" aria-label="Copy path" title="Copy path" onclick={copyPath}>
      <Icon name="copy" size={14} />
    </button>
  </div>

  {#if parsed.hunks.length === 0}
    <p class="empty">Empty file</p>
  {:else if effective === 'unified'}
    <div class="rows unified">
      {#each groups as g (g.key)}
        <div class="grp">
          {#each g.rows as r (r.key)}
            {#if r.kind === 'gap'}
              <div class="lrow gap"><span class="code">{r.text}</span></div>
            {:else}
              <div class="lrow {r.row.t}">
                <span class="g">{r.row.o ?? ''}</span>
                <span class="g">{r.row.n ?? ''}</span>
                <span class="sign">{r.row.t === 'add' ? '+' : r.row.t === 'del' ? '-' : ' '}</span>
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped or highlighted by lib/render, markHtml only adds <mark> -->
                <span class="code">{@html rowHtml(r.row, r.mark)}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/each}
    </div>
  {:else}
    <div class="rows cols2">
      {#each splitGroups as g (g.key)}
        <div class="grp">
          {#each g.rows as r (r.key)}
            {#if r.kind === 'gap'}
              <div class="lrow gap"><span class="code">{r.text}</span></div>
            {:else}
              <div class="lrow pair">
                <div class="half {r.left?.row.t ?? 'ghost'}">
                  <span class="g">{r.left?.row.o ?? r.left?.row.n ?? ''}</span>
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped or highlighted by lib/render, markHtml only adds <mark> -->
                  <span class="code">{@html r.left ? rowHtml(r.left.row, r.left.mark) : ''}</span>
                </div>
                <div class="half {r.right?.row.t ?? 'ghost'}">
                  <span class="g">{r.right?.row.n ?? r.right?.row.o ?? ''}</span>
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped or highlighted by lib/render, markHtml only adds <mark> -->
                  <span class="code">{@html r.right ? rowHtml(r.right.row, r.right.mark) : ''}</span>
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {/each}
    </div>
  {/if}

  {#if hidden > 0}
    <button type="button" class="btn btn-ghost btn-sm more" onclick={() => (showAll = true)}>
      Show all {totalLines} lines
    </button>
  {/if}
</div>

<style>
  .block {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--inset);
    min-width: 0;
  }
  .block + .block,
  .block + .out,
  .out + .block {
    margin-top: var(--s-2);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-1) var(--s-2);
    border-bottom: 1px solid var(--line);
    min-height: max(34px, var(--hit));
  }
  .badge {
    flex: none;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: var(--r-sm);
    font-size: var(--fs-xs);
    font-weight: 700;
    font-family: var(--mono);
  }
  .badge.add {
    color: var(--ansi-2);
    background: color-mix(in srgb, var(--ansi-2) 15%, transparent);
  }
  .badge.del {
    color: var(--ansi-1);
    background: color-mix(in srgb, var(--ansi-1) 15%, transparent);
  }
  .badge.mod {
    color: var(--ansi-6);
    background: color-mix(in srgb, var(--ansi-6) 15%, transparent);
  }
  .path {
    min-width: 0;
    font-family: var(--mono);
    font-size: var(--fs-sm);
  }
  .stats {
    flex: none;
    display: inline-flex;
    gap: var(--s-2);
    font-size: var(--fs-xs);
  }
  .adds {
    color: var(--ansi-2);
  }
  .dels {
    color: var(--ansi-1);
  }
  .head :global(.seg) {
    margin-left: auto;
  }
  .head :global(.seg button) {
    padding: 0 var(--s-2);
    font-size: var(--fs-xs);
  }
  .copy {
    flex: none;
    color: var(--ink-3);
  }
  .empty {
    padding: var(--s-2) var(--s-3);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .rows {
    overflow-x: auto;
    overscroll-behavior-x: contain;
    padding: var(--s-1) 0;
    font-family: var(--mono);
    font-size: var(--fs-sm);
    line-height: 1.5;
    scrollbar-width: thin;
  }
  .grp {
    content-visibility: auto;
    contain-intrinsic-size: auto 600px;
  }
  .lrow {
    display: flex;
    min-width: max-content;
    width: 100%;
    padding: 0 var(--s-2);
    color: var(--ink-2);
  }
  .lrow.add {
    color: var(--ansi-2);
    background: color-mix(in srgb, var(--ansi-2) 10%, transparent);
  }
  .lrow.del {
    color: var(--ansi-1);
    background: color-mix(in srgb, var(--ansi-1) 10%, transparent);
  }
  .lrow.gap {
    color: var(--ink-3);
    font-style: italic;
  }
  .g {
    flex: none;
    width: 4ch;
    padding-right: var(--s-2);
    text-align: right;
    color: var(--ink-3);
    user-select: none;
  }
  .sign {
    flex: none;
    width: 1.5ch;
    text-align: center;
    user-select: none;
  }
  .code {
    white-space: pre;
    padding-left: var(--s-1);
  }
  .code :global(mark) {
    color: inherit;
    background: color-mix(in srgb, var(--accent) 32%, transparent);
    border-radius: 2px;
  }
  .pair {
    padding: 0;
  }
  .half {
    display: flex;
    flex: 1 1 50%;
    min-width: max-content;
    padding: 0 var(--s-2);
  }
  .half + .half {
    border-left: 1px solid var(--line);
  }
  .half.add {
    color: var(--ansi-2);
    background: color-mix(in srgb, var(--ansi-2) 10%, transparent);
  }
  .half.del {
    color: var(--ansi-1);
    background: color-mix(in srgb, var(--ansi-1) 10%, transparent);
  }
  .half.ghost .code {
    min-height: 1.5em;
  }
  .more {
    margin: var(--s-1) var(--s-2) var(--s-2);
  }
</style>
