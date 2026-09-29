<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import type { PromptMode } from '../lib/api/endpoints';
  import { clearDraft, loadDraft, saveDraft } from '../lib/composer/drafts';
  import { IMAGE_ACCEPT, imageProblem, isImageType, toPromptImage } from '../lib/composer/images';
  import { modeForKey, sendPlan } from '../lib/composer/send';
  import { filterCommands, flattenGroups, slashQuery, slashText, wantsInput, type SlashMatch } from '../lib/composer/slash';
  import { active, ui } from '../lib/state';
  import { Icon, Kbd } from '../lib/ui';
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

  const query = $derived(slashQuery(text));
  const groups = $derived(query !== null && dismissedFor !== text ? filterCommands(active.commands, query) : []);
  const flat = $derived(flattenGroups(groups));
  const menuOpen = $derived(flat.length > 0);
  const selected = $derived(Math.min(sel, Math.max(0, flat.length - 1)));

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

  export function setText(next: string) {
    text = next;
    void tick().then(() => {
      el?.focus();
      el?.setSelectionRange(next.length, next.length);
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
</script>

<svelte:window onpagehide={flush} onresize={grow} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="composer" {ondragover} {ondrop}>
  <div class="box" class:disabled={ended}>
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
      role={menuOpen ? 'combobox' : undefined}
      aria-expanded={menuOpen ? true : undefined}
      aria-controls={menuOpen ? `${uid}-slash` : undefined}
      aria-activedescendant={menuOpen ? `${uid}-slash-o${selected}` : undefined}
      aria-autocomplete={menuOpen ? 'list' : undefined}
      {onkeydown}
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
</style>
