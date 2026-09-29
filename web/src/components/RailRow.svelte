<script lang="ts">
  import InlineCode from '../lib/ui/InlineCode.svelte';
  import Spinner from '../lib/ui/Spinner.svelte';
  import StatusGlyph, { type SessionStatus } from './StatusGlyph.svelte';

  type Props = {
    title: string;
    sub: string;
    status?: SessionStatus;
    active?: boolean;
    busy?: boolean;
    badge?: number;
    onclick: () => void;
  };

  let { title, sub, status, active = false, busy = false, badge = 0, onclick }: Props = $props();
</script>

<button type="button" class="row" class:active aria-current={active ? 'page' : undefined} {onclick} disabled={busy}>
  <span class="lead">
    {#if busy}
      <Spinner />
    {:else if status}
      <StatusGlyph {status} />
    {/if}
  </span>
  <span class="text">
    <span class="title truncate"><InlineCode text={title} /></span>
    <span class="sub truncate">{sub}</span>
  </span>
  {#if badge > 1}<span class="badge" aria-label="{badge} waiting">{badge}</span>{/if}
</button>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    width: 100%;
    min-height: 48px;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    text-align: left;
    color: var(--ink);
    transition: background var(--dur-fast) var(--ease);
  }
  .row:hover:not(:disabled) {
    background: var(--hover);
  }
  .row.active {
    background: var(--press);
  }
  .row:disabled {
    opacity: 1;
    color: var(--ink-2);
  }
  .lead {
    flex: none;
    width: 14px;
    display: grid;
    place-items: center;
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
  .sub {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .badge {
    flex: none;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: var(--fs-xs);
    font-weight: 600;
  }
</style>
