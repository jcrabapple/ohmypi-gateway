<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { busy, compactSession, stopActiveSession } from '../lib/actions.svelte';
  import { openOverlay } from '../lib/overlays';
  import { basename, money, sessionTitle } from '../lib/format';
  import { active, nav, plan, sessionsStore, settings, ui } from '../lib/state';
  import { collectChanges } from '../lib/transcript/changes';
  import { Icon, InlineCode, Menu, type MenuItem } from '../lib/ui';
  import { viewport } from '../lib/ui/media.svelte';
  import ContextMeter from './ContextMeter.svelte';

  const info = $derived(active.info);
  const title = $derived(info ? sessionTitle(info, sessionsStore.saved) : '');
  const folder = $derived(info ? basename(info.cwd) : '');
  const usage = $derived(active.stats?.contextUsage ?? info?.contextUsage ?? null);
  const model = $derived(info?.model?.name ?? info?.model?.id ?? '');
  const changed = $derived(collectChanges(active.transcript.items));

  // ---- connection text: shown only when not live
  let now = $state(Date.now());
  let ticker: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const retry = active.connection.state === 'retrying';
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (retry) {
      now = Date.now();
      ticker = setInterval(() => (now = Date.now()), 500);
    }
  });
  onDestroy(() => ticker && clearInterval(ticker));

  const connectionText = $derived.by(() => {
    const c = active.connection;
    if (active.phase !== 'ready' && active.phase !== 'loading') return '';
    if (c.state === 'live') return '';
    if (c.state === 'retrying') {
      if (c.message) return c.message;
      const s = Math.max(0, Math.ceil(((c.retryAt ?? now) - now) / 1000));
      return s > 0 ? `Reconnecting in ${s} s` : 'Reconnecting';
    }
    if (c.state === 'connecting') return 'Connecting';
    return active.phase === 'ready' ? 'Offline' : '';
  });

  // ---- inline rename
  let editing = $state(false);
  let draft = $state('');
  let input: HTMLInputElement | undefined = $state();
  let titleBtn: HTMLButtonElement | undefined = $state();

  async function startRename() {
    if (!info) return;
    draft = title;
    editing = true;
    await tick();
    input?.focus();
    input?.select();
  }

  let seenRename = ui.renameTick;
  $effect(() => {
    const t = ui.renameTick;
    if (t === seenRename) return;
    seenRename = t;
    if (info && !editing) void startRename();
  });

  async function finishRename(save: boolean) {
    if (!editing) return;
    editing = false;
    const name = draft.trim();
    if (save && name && name !== title) {
      try {
        await active.rename(name);
      } catch (e) {
        ui.error(e instanceof Error ? e.message : 'Could not rename the session');
      }
    }
    await tick();
    titleBtn?.focus();
  }

  function onRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void finishRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      void finishRename(false);
    }
  }

  // ---- overflow menu
  let menuOpen = $state(false);
  let menuBtn: HTMLButtonElement | undefined = $state();
  const items = $derived<MenuItem[]>([
    { id: 'info', label: 'Session info', icon: 'info', onselect: () => openOverlay('session-info') },
    { id: 'compact', label: 'Compact', icon: 'compress', disabled: busy.compacting || active.running, onselect: compactSession },
    { id: 'stop', label: 'Stop session', icon: 'power', danger: true, onselect: stopActiveSession },
  ]);

  function leading(e: MouseEvent) {
    if (viewport.narrow) ui.open('drawer', e.currentTarget as HTMLElement);
    else ui.railCollapsed = !ui.railCollapsed;
  }

  // Wide: the side panel. Narrow: the full-height sheet.
  const planOpen = $derived(viewport.narrow ? plan.sheet : settings.planPanelOpen);

  function togglePlan() {
    if (viewport.narrow) plan.sheet = !plan.sheet;
    else settings.planPanelOpen = !settings.planPanelOpen;
  }
</script>

<header class="head">
  <button
    type="button"
    class="icon-btn lead"
    aria-label={viewport.narrow ? 'Sessions' : ui.railCollapsed ? 'Show sessions' : 'Hide sessions'}
    aria-expanded={viewport.narrow ? ui.isOpen('drawer') : !ui.railCollapsed}
    title="Sessions"
    onclick={leading}
  >
    <Icon name={viewport.narrow ? 'menu' : 'panel-left'} />
  </button>

  <div class="titles">
    {#if editing}
      <input
        bind:this={input}
        bind:value={draft}
        class="rename"
        aria-label="Session name"
        maxlength="120"
        onkeydown={onRenameKey}
        onblur={() => finishRename(true)}
      />
    {:else if info}
      <button bind:this={titleBtn} type="button" class="title" title="Rename" onclick={startRename}>
        <span class="truncate"><InlineCode text={title} /></span>
        <Icon name="pencil" size={13} />
      </button>
    {:else}
      <span class="skeleton sk" aria-hidden="true"></span>
    {/if}
  </div>

  <div class="meta">
    {#if connectionText}
      <span class="conn" role="status">{connectionText}</span>
    {/if}
    {#if info}
      {#if folder && folder !== title}
        <span class="cwd mono truncate" title={info.cwd}>{folder}</span>
      {/if}
      {#if model}<span class="chip model truncate" title={info.model?.id}>{model}</span>{/if}
      {#if changed.files > 0}
        <button
          type="button"
          class="chip files mono truncate"
          title="Files changed in this session"
          onclick={() => active.gwId && nav.openChanges(active.gwId)}
        >
          <Icon name="mark" size={13} />
          {changed.files} {changed.files === 1 ? 'file' : 'files'} changed
        </button>
      {/if}
      <ContextMeter percent={usage?.percent ?? null} tokens={usage?.tokens} window={usage?.contextWindow} />
      {#if active.stats}
        <span class="cost mono" title="Session cost">{money(active.stats.cost)}</span>
      {/if}
    {/if}
  </div>

  <button
    type="button"
    class="icon-btn"
    aria-label="Plan"
    aria-expanded={planOpen}
    aria-controls="plan-panel"
    title="Plan"
    onclick={togglePlan}
  >
    <Icon name="target" />
  </button>
  <button
    bind:this={menuBtn}
    type="button"
    class="icon-btn"
    aria-label="Session menu"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    disabled={!info}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <Icon name="more" />
  </button>
  <Menu open={menuOpen} onclose={() => (menuOpen = false)} anchor={menuBtn} title="Session" {items} />
</header>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    padding-top: calc(var(--s-2) + var(--safe-t));
    min-height: 52px;
    border-bottom: 1px solid var(--line);
    background: var(--canvas);
  }
  .titles {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
    max-width: 100%;
    min-height: var(--hit);
    padding: 0 var(--s-2);
    margin-left: calc(var(--s-2) * -1);
    border-radius: var(--r-md);
    font-size: var(--fs-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .title :global(svg) {
    color: var(--ink-3);
    opacity: 0;
    transition: opacity var(--dur-fast);
  }
  .title:hover :global(svg),
  .title:focus-visible :global(svg) {
    opacity: 1;
  }
  @media (pointer: coarse) {
    .title :global(svg) {
      opacity: 0.6;
    }
  }
  .rename {
    width: min(360px, 60vw);
    min-height: var(--hit);
    padding: 0 var(--s-2);
    background: var(--field);
    border: 1px solid var(--accent);
    border-radius: var(--r-md);
    font-size: var(--fs-lg);
    font-weight: 600;
  }
  .rename:focus-visible {
    outline: none;
  }
  .sk {
    display: block;
    width: 140px;
    height: 16px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    /* Shrinkable: an unshrinkable meta row would size the whole header (and the grid column
       above it) to the chips' combined width. Children truncate when space runs out. */
    flex: 0 1 auto;
    justify-content: flex-end;
    min-width: 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .cwd {
    max-width: 16ch;
  }
  .model {
    max-width: 22ch;
    padding: 0 var(--s-2);
    box-shadow: var(--ring);
    min-height: 22px;
  }
  button.files {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    max-width: 24ch;
    min-height: var(--hit);
    padding: 0 var(--s-2);
    border-radius: var(--r-md);
    box-shadow: var(--ring);
    color: var(--ink-2);
    font-size: var(--fs-sm);
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  button.files:hover {
    background: var(--hover);
    color: var(--ink);
  }
  button.files :global(svg) {
    flex: none;
    color: var(--accent);
  }
  .cost {
    color: var(--ink-2);
  }
  .conn {
    color: var(--warn);
    white-space: nowrap;
  }
  @media (max-width: 899.98px) {
    .head {
      flex-wrap: wrap;
      row-gap: 0;
    }
    .titles {
      flex: 1 1 0;
    }
    .meta {
      order: 5;
      flex: 1 0 100%;
      justify-content: flex-start;
      padding: 0 var(--s-2) var(--s-1);
      overflow: hidden;
    }
  }
  @media (max-width: 520px) {
    .cwd {
      display: none;
    }
  }
</style>
