<script lang="ts">
  // One external omp instance (not run by this gateway) in the rail.
  import type { ExternalSession } from '../lib/api/types';
  import { sessions as sessionsApi } from '../lib/api/endpoints';
  import { basename, relativeTime } from '../lib/format';
  import { toast, Icon, Menu, type MenuItem } from '../lib/ui';
  import InlineCode from '../lib/ui/InlineCode.svelte';

  let { row }: { row: ExternalSession } = $props();

  let menuOpen = $state(false);
  let menuBtn: HTMLButtonElement | undefined = $state();

  const title = $derived(row.title ?? (basename(row.cwd) || row.cwd));
  const sub = $derived(
    [row.model?.id, `pid ${row.pid}`, relativeTime(row.startedAt)].filter(Boolean).join(' · '),
  );

  function items(): MenuItem[] {
    return [
      {
        id: 'open',
        label: 'Open in omp.sh',
        icon: 'arrow-up',
        onselect: () => void openExternal(),
      },
      {
        id: 'copy-path',
        label: 'Copy path',
        icon: 'copy',
        onselect: () => void copyPath(),
      },
    ];
  }

  /** Fetch a one-shot capability URL and open it in a new tab. The URL never
   *  enters the DOM, a store, localStorage or the console. */
  async function openExternal(): Promise<void> {
    try {
      const { url } = await sessionsApi.collabLink(row.instanceId, row.generation, 'view');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast('Could not open the session', { kind: 'error' });
    }
  }

  async function copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(row.cwd);
      toast('Path copied');
    } catch {
      // Quiet fallback: without clipboard permission there is nothing to show.
    }
  }
</script>

<div class="row">
  <button
    type="button"
    class="main"
    aria-label="{title} (external, pid {row.pid})"
    onclick={() => void openExternal()}
  >
    <span class="lead">
      {#if row.stale}<span class="stale" role="img" aria-label="Stale"><Icon name="clock" size={12} /></span>
      {:else}<span class="glyph" role="img" aria-label="External"></span>{/if}
    </span>
    <span class="text">
      <span class="title truncate">
        <span class="desk" title="External session">desk</span>
        <InlineCode text={title} />
      </span>
      <span class="sub truncate">{sub}</span>
    </span>
    {#if row.inputRequired}<span class="chip" aria-label="Needs input">needs input</span>{/if}
  </button>
  <button
    bind:this={menuBtn}
    type="button"
    class="icon-btn hit kebab"
    aria-label="Session options for {title}"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <Icon name="more" size={16} />
  </button>
  <Menu open={menuOpen} onclose={() => (menuOpen = false)} anchor={menuBtn} title="Session" items={items()} />
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    border-radius: var(--r-md);
  }
  .main {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex: 1;
    min-width: 0;
    min-height: max(48px, var(--hit));
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    text-align: left;
    color: var(--ink);
    transition: background var(--dur-fast) var(--ease);
  }
  .main:hover {
    background: var(--hover);
  }
  .kebab {
    flex: none;
    width: 32px;
    height: 32px;
    margin-right: var(--s-1);
    color: var(--ink-3);
  }
  .lead {
    flex: none;
    width: 14px;
    display: grid;
    place-items: center;
  }
  .glyph {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin: 0 2px;
    background: var(--ink-3);
    opacity: 0.6;
  }
  .stale {
    display: inline-flex;
    color: var(--ink-3);
  }
  .text {
    display: grid;
    min-width: 0;
    flex: 1;
    line-height: 1.35;
  }
  .title {
    font-weight: 500;
  }
  .desk {
    display: inline-flex;
    align-items: center;
    vertical-align: -1px;
    margin-right: var(--s-1);
    padding: 0 var(--s-1);
    border-radius: 999px;
    background: var(--press);
    color: var(--ink-2);
    font-size: var(--fs-xs);
    font-weight: 600;
    text-transform: lowercase;
  }
  .sub {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .chip {
    flex: none;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: var(--fs-xs);
    font-weight: 600;
  }
</style>
