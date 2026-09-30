<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import type { PromptMode } from '../lib/api/endpoints';
  import { isAbortError } from '../lib/api/client';
  import { sessionFiles } from '../lib/api/endpoints';
  import type { FileIndexEntry } from '../lib/api/types';
  import { atDirPrefix, extractAtQuery, insertMention, rankEntries } from '../lib/composer/atQuery';
  import { clearDraft, loadDraft, saveDraft } from '../lib/composer/drafts';
  import { IMAGE_ACCEPT, imageProblem, isImageType, toPromptImage } from '../lib/composer/images';
  import { modeForKey, sendPlan } from '../lib/composer/send';
  import { filterCommands, flattenGroups, slashQuery, slashText, wantsInput, type SlashMatch } from '../lib/composer/slash';
  import { lastTurnFailure } from '../lib/transcript/reducer';
  import { active, ui } from '../lib/state';
  import { Icon, Kbd, Sheet, Spinner } from '../lib/ui';
  import { scrollFade } from '../lib/ui/actions';
  import { viewport } from '../lib/ui/media.svelte';
  import ComposerChips from './ComposerChips.svelte';
  import ImageTray, { type Attached } from './ImageTray.svelte';
  import SlashMenu from './SlashMenu.svelte';

  let { gwId }: { gwId: string } = $props();

  let text = $state(untrack(() => loadDraft(gwId)));
  let images = $state.raw<Attached[]>([]);
  let sending = $state(false);
  let dismissedFor = $state<string | null>(null);
  let sel = $state(0);
  let el: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let nextImage = 1;
  const uid = $props.id();

  const streaming = $derived(active.running);
  const plan = $derived(sendPlan(streaming));
  const ended = $derived(active.phase === 'gone' || active.info?.exited === true);
  const canSend = $derived(active.phase === 'ready' && !ended && (text.trim() !== '' || images.length > 0));
  const failure = $derived(lastTurnFailure(active.transcript));
  // `retried` hides the chip while the accepted retry waits for omp to start
  // the new turn; the transcript itself keeps the failed turn until then.
  const canRetry = $derived(active.phase === 'ready' && !streaming && !ended && failure !== null && !active.transcript.retried);

  let retrying = $state(false);

  const query = $derived(slashQuery(text));
  const groups = $derived(query !== null && dismissedFor !== text ? filterCommands(active.commands, query) : []);
  const flat = $derived(flattenGroups(groups));
  const menuOpen = $derived(flat.length > 0);
  const selected = $derived(Math.min(sel, Math.max(0, flat.length - 1)));

  // ---- @-file mentions: the query lives between the last trigger and the caret
  const AT_LIMIT = 8;
  const AT_CACHE_MAX = 40;

  let caret = $state(0);
  let atEntries = $state.raw<FileIndexEntry[]>([]);
  let atSel = $state(0);
  let atNote = $state<string | null>(null);
  let atLoaded = $state(false);
  /** Full draft text whose @-menu was dismissed or picked away. Reset by the
   * next input event: retyping (or pasting over) the same words rebuilds the
   * token and re-opens, even when the resulting text is identical. */
  let atDismissedFor = $state<string | null>(null);
  /** Sheet variant only: directory being listed ('' = the cwd). */
  let sheetDrill = $state<string | null>(null);
  /** Listings live one @-interaction: omp creates files as it works, so a
   * new directory, a new cwd, or a send drops the cache. Revisiting a
   * directory while the same token stays open may show that token's earlier
   * listing; that is the accepted staleness window within a turn. */
  const fileCache = new Map<string, FileIndexEntry[]>();
  let fetchCtl: AbortController | null = null;
  let fetchTimer: ReturnType<typeof setTimeout> | null = null;

  const at = $derived(ended ? null : extractAtQuery(text.slice(0, caret)));
  const atOpen = $derived(at !== null && atDismissedFor !== text);
  /** Touch paths and narrow windows get the bottom sheet, not the popover. */
  const atSheet = $derived(viewport.narrow || viewport.coarse);
  /** Directory to list: the sheet's drill state wins while it is open. */
  const atPrefix = $derived.by(() => {
    if (!atOpen || at === null) return null;
    if (atSheet && sheetDrill !== null) return sheetDrill;
    return atDirPrefix(at.query);
  });
  const atList = $derived.by(() => {
    if (!atOpen || at === null) return [];
    const q = atSheet && sheetDrill !== null ? '' : at.query;
    return rankEntries(atEntries, q).slice(0, AT_LIMIT);
  });
  const atActive = $derived(Math.min(atSel, Math.max(0, atList.length - 1)));
  const sheetTitle = $derived(!sheetDrill ? 'Files' : sheetDrill);
  /** The popover listbox exists only when it has rows or a note; the sheet
   * variant is a plain list of buttons and claims no listbox relationship. */
  const atBoxOpen = $derived(atOpen && !atSheet && (atList.length > 0 || atNote !== null));

  $effect(() => {
    void at?.query;
    void atPrefix;
    atSel = 0;
  });

  // Drop the cache when the at-token moves to a different directory, so
  // coming back to a directory in a later token re-lists it fresh.
  let atPrevDir: string | null = null;
  $effect(() => {
    const dir = at === null ? null : atDirPrefix(at.query);
    if (dir !== atPrevDir) {
      atPrevDir = dir;
      if (dir !== null) fileCache.clear();
    }
  });

  // One listing per (session, cwd, directory), debounced; a hit renders
  // instantly and an in-flight request is aborted when the prefix changes.
  $effect(() => {
    const prefix = atPrefix;
    atLoaded = false;
    if (prefix === null) {
      atEntries = [];
      atNote = null;
      return;
    }
    const key = `${gwId}\u0000${active.info?.cwd ?? ''}\u0000${prefix}`;
    const cached = fileCache.get(key);
    if (cached) {
      atEntries = cached;
      atNote = null;
      atLoaded = true;
      return;
    }
    atEntries = [];
    atNote = null;
    const ctl = new AbortController();
    fetchCtl = ctl;
    fetchTimer = setTimeout(() => {
      sessionFiles(gwId, prefix, ctl.signal)
        .then((entries) => {
          if (fileCache.size >= AT_CACHE_MAX) fileCache.delete(fileCache.keys().next().value!);
          fileCache.set(key, entries);
          if (fetchCtl !== ctl) return;
          atEntries = entries;
          atNote = null;
          atLoaded = true;
        })
        .catch((e: unknown) => {
          // Confinement rejections and dead sessions are a quiet note, never a toast.
          if (fetchCtl !== ctl || isAbortError(e)) return;
          atEntries = [];
          atNote = 'File list unavailable';
          atLoaded = true;
        });
    }, 150);
    return () => {
      if (fetchTimer !== null) clearTimeout(fetchTimer);
      fetchTimer = null;
      ctl.abort();
      if (fetchCtl === ctl) fetchCtl = null;
    };
  });

  function trackCaret() {
    caret = el?.selectionStart ?? text.length;
  }

  function dismissAt() {
    atDismissedFor = text;
    sheetDrill = null;
  }

  /** Any edit rebuilds the @-token, so a dismissal never survives an input. */
  function atInput() {
    atDismissedFor = null;
    trackCaret();
  }

  /** Replace the @query token with the picked path (quoted when it has spaces). */
  function pickAt(entry: FileIndexEntry) {
    if (at === null) return;
    const res = insertMention(text, at, entry.path);
    setText(res.text, res.caret);
    // No trailing space is forced any more, so the caret can still sit at the
    // end of a live token: dismiss THIS draft so the menu closes instead of
    // re-opening over the inserted path.
    atDismissedFor = res.text;
    sheetDrill = null;
  }

  /** Sheet rows: a folder drills down (touch has no keyboard to type slashes). */
  function drillAt(entry: FileIndexEntry) {
    if (entry.isDir) sheetDrill = `${entry.path}/`;
    else pickAt(entry);
  }

  function atSheetUp() {
    const cur = sheetDrill ?? '';
    if (cur === '') return;
    const body = cur.slice(0, -1);
    const cut = body.lastIndexOf('/');
    sheetDrill = cut === -1 ? '' : body.slice(0, cut + 1);
  }

  function atSheetKeydown(e: KeyboardEvent) {
    // Dismiss the suggestions, never the sheet underneath.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismissAt();
    }
  }

  function sizeLabel(entry: FileIndexEntry): string {
    if (entry.isDir || entry.size === null) return 'folder';
    const size = entry.size;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0).replace(/\.0$/, '')} KB`;
    return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  }

  $effect(() => {
    void query;
    sel = 0;
  });

  // ---- drafts: saved shortly after typing, flushed on the way out, untouched while a send is in flight
  $effect(() => {
    const t = text;
    if (sending) return;
    saveTimer = setTimeout(() => saveDraft(gwId, t), 250);
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
    };
  });
  const flush = () => {
    if (!sending) saveDraft(gwId, text);
  };
  onDestroy(() => {
    flush();
    for (const i of images) URL.revokeObjectURL(i.url);
  });

  // ---- auto-grow up to 40% of the visible viewport
  function grow() {
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.4);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }
  $effect(() => {
    void text;
    grow();
  });

  onMount(() => {
    if (!viewport.coarse && !ended) el?.focus({ preventScroll: true });
  });

  export function setText(next: string, atCaret = next.length) {
    text = next;
    caret = atCaret;
    void tick().then(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  export function focus() {
    el?.focus();
  }

  // ---- images
  function addFiles(files: Iterable<File>) {
    const added: Attached[] = [];
    for (const file of files) {
      const problem = imageProblem(file, images.length + added.length);
      if (problem) {
        ui.error(problem);
        break;
      }
      added.push({ id: nextImage++, file, url: URL.createObjectURL(file) });
    }
    if (added.length) images = [...images, ...added];
  }

  function removeImage(id: number) {
    const gone = images.find((i) => i.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    images = images.filter((i) => i.id !== id);
  }

  function onpaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => isImageType(f.type));
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  }

  function ondragover(e: DragEvent) {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  }

  function ondrop(e: DragEvent) {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  }

  function onattach(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    addFiles(input.files ?? []);
    input.value = '';
  }

  // ---- sending
  async function submit(mode: PromptMode = plan.primary.mode, override?: string) {
    const message = (override ?? text).trim();
    if (active.phase !== 'ready' || ended || (!message && images.length === 0)) return;
    if (sending) return;
    const original = text;
    const attached = images;
    let prompt;
    try {
      prompt = await Promise.all(attached.map((i) => toPromptImage(i.file)));
    } catch (e) {
      ui.error(e instanceof Error ? e.message : 'Could not read the image');
      return;
    }
    sending = true;
    text = '';
    images = [];
    dismissedFor = null;
    fileCache.clear();
    if (viewport.coarse) el?.blur();
    const ok = await active.send(message, mode, prompt.length ? prompt : undefined);
    sending = false;
    if (ok) {
      for (const i of attached) URL.revokeObjectURL(i.url);
      if (text.trim()) saveDraft(gwId, text);
      else clearDraft(gwId);
    } else {
      // The failed bubble explains why; the words come back so nothing is lost.
      if (!text) text = original;
      if (images.length === 0) images = attached;
      saveDraft(gwId, text);
    }
  }

  function pick(m: SlashMatch, via: 'enter' | 'tab' | 'click') {
    const cmd = m.command;
    if (via !== 'tab' && !wantsInput(cmd)) void submit(plan.primary.mode, `/${cmd.name}`);
    else setText(slashText(cmd));
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return;
    if (atOpen) {
      // Escape dismisses the suggestions whenever the @ state is open, even
      // with an empty list (debounce, note, zero matches): it must never
      // bubble into whatever overlay is open underneath.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissAt();
        return;
      }
      if (atList.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = atList.length;
          atSel = (atActive + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          pickAt(atList[atActive]!);
          return;
        }
      }
    }
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = flat.length;
        sel = (selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const m = flat[selected];
        if (m) pick(m, e.key === 'Tab' ? 'tab' : 'enter');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissedFor = text;
        return;
      }
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    const modifier = e.ctrlKey || e.metaKey;
    if (viewport.coarse && !modifier) return;
    e.preventDefault();
    void submit(modeForKey(streaming, modifier));
  }

  async function stop() {
    try {
      await active.abort();
    } catch (e) {
      ui.error(e instanceof Error ? e.message : 'Could not stop');
    }
  }

  async function retryTurn() {
    if (retrying) return;
    retrying = true;
    try {
      await active.retry();
      // Optimistic: an accepted request hides the chip; omp's events refresh
      // the transcript from here (agent_start re-enables the chip on failure).
      active.markRetried();
    } catch (e) {
      ui.error(e instanceof Error ? e.message : 'Could not retry');
    } finally {
      retrying = false;
    }
  }
</script>

<svelte:window onpagehide={flush} onresize={grow} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="composer" {ondragover} {ondrop}>
  <div class="box" class:disabled={ended}>
    {#if atBoxOpen}
      <div class="menu at-menu scroll-y" id="{uid}-at" role="listbox" aria-label="Files">
        {#if atNote}
          <p class="at-note" role="status">{atNote}</p>
        {/if}
        {#each atList as entry, i (entry.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id="{uid}-at-o{i}"
            class="opt"
            class:on={i === atActive}
            role="option"
            aria-selected={i === atActive}
            aria-label={entry.path}
            tabindex="-1"
            title={entry.path}
            onpointerdown={(e) => e.preventDefault()}
            onpointermove={() => i !== atActive && (atSel = i)}
            onclick={() => pickAt(entry)}
          >
            <span class="name mono" class:is-dir={entry.isDir}>{entry.name}{entry.isDir ? '/' : ''}</span>
            <span class="size">{sizeLabel(entry)}</span>
          </div>
        {/each}
      </div>
    {/if}
    {#if menuOpen}
      <SlashMenu id="{uid}-slash" {groups} active={selected} onpick={pick} onhover={(i) => (sel = i)} />
    {/if}
    {#if images.length}
      <ImageTray {images} onremove={removeImage} />
    {/if}
    <textarea
      bind:this={el}
      bind:value={text}
      rows="1"
      aria-label="Message"
      placeholder={ended ? 'This session has ended' : streaming ? 'Steer, or queue a message for after this turn' : 'Message omp'}
      disabled={ended}
      autocomplete="off"
      autocapitalize="sentences"
      spellcheck="true"
      enterkeyhint={viewport.coarse ? 'enter' : 'send'}
      role={menuOpen || atBoxOpen ? 'combobox' : undefined}
      aria-expanded={menuOpen || atBoxOpen ? true : undefined}
      aria-controls={menuOpen ? `${uid}-slash` : atBoxOpen ? `${uid}-at` : undefined}
      aria-activedescendant={menuOpen
        ? `${uid}-slash-o${selected}`
        : atBoxOpen && atList.length > 0 ? `${uid}-at-o${atActive}` : undefined}
      aria-autocomplete={menuOpen || atBoxOpen ? 'list' : undefined}
      {onkeydown}
      oninput={atInput}
      onclick={trackCaret}
      onkeyup={trackCaret}
      {onpaste}
    ></textarea>

    <div class="bar">
      <input bind:this={fileInput} type="file" accept={IMAGE_ACCEPT} multiple hidden onchange={onattach} />
      <button
        type="button"
        class="icon-btn attach"
        aria-label="Attach images"
        title="Attach images"
        disabled={ended}
        onclick={() => fileInput?.click()}
      >
        <Icon name="paperclip" size={17} />
      </button>
      <div class="chips-scroll" use:scrollFade><ComposerChips /></div>

      <div class="right">
        {#if active.queued > 0}
          <span class="queued" role="status">{active.queued} queued</span>
        {/if}
        {#if streaming}
          <button type="button" class="btn btn-sm stop" onclick={stop} aria-label="Stop">
            <Icon name="stop" size={14} /> <span class="lbl">Stop</span>
          </button>
          {#if plan.secondary}
            <button
              type="button"
              class="btn btn-sm"
              disabled={!canSend}
              onclick={() => submit(plan.secondary!.mode)}
              title="Send after this turn"
            >
              {plan.secondary.label}
            </button>
          {/if}
        {/if}
        {#if canRetry}
          <button
            type="button"
            class="btn btn-sm retry"
            disabled={retrying}
            onclick={retryTurn}
            aria-label="Retry"
            title="Retry the failed turn"
          >
            <Icon name="refresh" size={14} /> <span class="lbl">Retry</span>
          </button>
        {/if}
        <button
          type="button"
          class="btn btn-primary btn-sm primary"
          class:round={!streaming}
          disabled={!canSend}
          aria-label={plan.primary.label}
          onclick={() => submit()}
        >
          {#if streaming}
            {plan.primary.label}
          {:else}
            <Icon name="arrow-up" size={16} />
          {/if}
        </button>
      </div>
    </div>
  </div>

  {#if atOpen && atSheet}
    <Sheet open onclose={dismissAt} title={sheetTitle} size="sm" flush>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="at-sheet" onkeydown={atSheetKeydown}>
        {#if sheetDrill}
          <button type="button" class="at-back" onclick={atSheetUp} aria-label="Up one folder">
            <Icon name="arrow-left" size={15} />
            <span class="mono">..</span>
          </button>
        {/if}
        {#if atNote}
          <p class="at-note" role="status">{atNote}</p>
        {:else if atList.length === 0 && !atLoaded}
          <p class="at-note at-wait"><Spinner /></p>
        {:else if atList.length === 0}
          <p class="at-note">Empty folder</p>
        {/if}
        <!-- A plain list of real buttons, not a listbox: the sheet has no
             aria-activedescendant owner and options must not be nested buttons. -->
        <ul id="{uid}-at" class="at-list" aria-label="Files">
          {#each atList as entry (entry.path)}
            <li>
              <button
                type="button"
                class="at-row"
                aria-label={entry.path}
                title={entry.path}
                onclick={() => drillAt(entry)}
              >
                <span class="name mono" class:is-dir={entry.isDir}>{entry.name}{entry.isDir ? '/' : ''}</span>
                <span class="size">{sizeLabel(entry)}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </Sheet>
  {/if}

  {#if !viewport.coarse}
    <p class="keys" aria-hidden="true">
      {#if streaming}
        <Kbd>Enter</Kbd> steer <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd> queue
      {:else}
        <Kbd>Enter</Kbd> send <Kbd>Shift</Kbd><Kbd>Enter</Kbd> new line
      {/if}
    </p>
  {/if}
</div>

<style>
  .composer {
    width: 100%;
    max-width: var(--reading-w);
    margin: 0 auto;
    padding: var(--s-2) var(--s-4) calc(var(--s-3) + max(var(--kb), var(--safe-b)));
  }
  .box {
    position: relative;
    display: flex;
    flex-direction: column;
    background: var(--field);
    border-radius: var(--r-lg);
    box-shadow: 0 0 0 1px var(--line-strong);
    transition: box-shadow var(--dur-fast) var(--ease);
  }
  .box:focus-within {
    box-shadow: 0 0 0 1px var(--accent);
  }
  .box.disabled {
    opacity: 0.7;
  }
  textarea {
    display: block;
    width: 100%;
    min-height: 44px;
    padding: var(--s-3) var(--s-4) var(--s-1);
    background: transparent;
    border: 0;
    resize: none;
    line-height: 1.5;
    font-size: max(var(--fs-base), 16px);
    outline: none;
  }
  @media (min-width: 900px) and (pointer: fine) {
    textarea {
      font-size: var(--fs-base);
    }
  }
  /* Three slots that never overlap: attach, the scrolling chips row, and the send controls. */
  .bar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-1);
    padding: var(--s-1) var(--s-2) var(--s-2);
  }
  .chips-scroll {
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 2px;
  }
  .chips-scroll::-webkit-scrollbar {
    display: none;
  }
  .chips-scroll:global([data-fade='end']) {
    mask-image: linear-gradient(to right, var(--ink) calc(100% - 28px), transparent);
  }
  .chips-scroll:global([data-fade='start']) {
    mask-image: linear-gradient(to left, var(--ink) calc(100% - 28px), transparent);
  }
  .chips-scroll:global([data-fade='both']) {
    mask-image: linear-gradient(to right, transparent, var(--ink) 28px, var(--ink) calc(100% - 28px), transparent);
  }
  .attach {
    flex: none;
    min-width: max(30px, var(--hit));
    min-height: max(30px, var(--hit));
  }
  .right {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding-left: var(--s-1);
  }
  .queued {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .stop {
    color: var(--err);
  }
  .retry {
    color: var(--accent);
  }
  .primary.round {
    width: max(32px, var(--hit));
    padding: 0;
    border-radius: 50%;
    min-height: max(32px, var(--hit));
  }
  .keys {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--s-1);
    margin-top: var(--s-2);
    color: var(--ink-3);
    font-size: var(--fs-xs);
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .composer:focus-within .keys {
    opacity: 1;
  }
  @media (max-width: 899.98px) {
    .composer {
      padding-inline: var(--s-3);
    }
    .lbl {
      display: none;
    }
  }

  /* ---- @-file mention suggestions (popover on desktop, sheet on touch) */

  .at-menu {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + var(--s-2));
    max-height: min(320px, 45vh);
    padding: var(--s-1);
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    z-index: 5;
    animation: at-rise var(--dur-fast) var(--ease);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-height: max(32px, var(--hit));
    padding: var(--s-1) var(--s-3);
    border-radius: var(--r-md);
    cursor: pointer;
  }
  .opt.on {
    background: var(--press);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
    text-align: left;
  }
  .name.is-dir {
    color: var(--accent);
  }
  .size {
    flex: none;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .at-note {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--s-2) var(--s-3);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .at-sheet {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--s-2) var(--s-2) var(--s-3);
    overflow-y: auto;
    max-height: 60vh;
  }
  .at-back {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: 44px;
    padding: 0 var(--s-3);
    border: 0;
    background: transparent;
    border-radius: var(--r-md);
    color: var(--ink-3);
    cursor: pointer;
  }
  .at-back:active,
  .at-back:focus-visible {
    background: var(--press);
  }
  .at-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .at-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    width: 100%;
    min-height: 44px;
    padding: var(--s-1) var(--s-3);
    border: 0;
    background: transparent;
    border-radius: var(--r-md);
    cursor: pointer;
  }
  .at-row:active,
  .at-row:focus-visible {
    background: var(--press);
  }
  @keyframes at-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
</style>
