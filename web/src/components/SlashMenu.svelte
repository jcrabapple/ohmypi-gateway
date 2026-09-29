<script lang="ts">
  import { tick } from 'svelte';
  import { firstDescriptionLine, type SlashGroup, type SlashMatch } from '../lib/composer/slash';

  type Props = {
    id: string;
    groups: SlashGroup[];
    active: number;
    onpick: (m: SlashMatch, via: 'enter' | 'tab' | 'click') => void;
    onhover: (index: number) => void;
  };

  let { id, groups, active, onpick, onhover }: Props = $props();

  let list: HTMLDivElement | undefined = $state();

  // Flat index of each option, so the active one is known across group boundaries.
  const indexed = $derived.by(() => {
    let n = 0;
    return groups.map((g) => ({ ...g, items: g.items.map((m) => ({ m, i: n++ })) }));
  });

  $effect(() => {
    void active;
    void tick().then(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  });
</script>

<div class="menu scroll-y" bind:this={list} {id} role="listbox" aria-label="Commands">
  {#each indexed as g (g.key)}
    <div role="group" aria-labelledby="{id}-{g.key}">
      <div id="{id}-{g.key}" class="eyebrow head">{g.label}</div>
      {#each g.items as { m, i } (m.command.name + m.command.source)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          id="{id}-o{i}"
          class="opt"
          class:on={i === active}
          role="option"
          aria-selected={i === active}
          tabindex="-1"
          onpointerdown={(e) => e.preventDefault()}
          onpointermove={() => i !== active && onhover(i)}
          onclick={() => onpick(m, 'click')}
        >
          <span class="name mono">/{m.command.name}</span>
          {#if m.command.input?.hint}<span class="hint mono">{m.command.input.hint}</span>{/if}
          <span class="desc truncate">{firstDescriptionLine(m.command)}</span>
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .menu {
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
    animation: rise var(--dur-fast) var(--ease);
  }
  .head {
    padding: var(--s-2) var(--s-3) var(--s-1);
  }
  .opt {
    display: flex;
    align-items: baseline;
    gap: var(--s-3);
    min-height: max(32px, var(--hit));
    padding: var(--s-1) var(--s-3);
    border-radius: var(--r-md);
    cursor: pointer;
    align-items: center;
  }
  .opt.on {
    background: var(--press);
  }
  .name {
    flex: none;
    color: var(--ink);
  }
  .hint {
    flex: none;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .desc {
    flex: 1;
    color: var(--ink-3);
    font-size: var(--fs-sm);
    text-align: right;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(4px); }
  }
</style>
