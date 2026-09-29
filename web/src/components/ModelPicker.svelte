<script lang="ts">
  // Searchable model list grouped by provider. Used by the composer chip (switch the running
  // session) and the new-session sheet (choose the starting model).
  import { tick } from 'svelte';
  import type { CatalogModel } from '../lib/api/types';
  import { compactNumber, priceLabel } from '../lib/format';
  import { groupModels, modelCatalog } from '../lib/state/models.svelte';
  import { Adaptive, Icon, Spinner } from '../lib/ui';

  type Props = {
    open: boolean;
    onclose: () => void;
    anchor?: HTMLElement | null;
    /** provider/id of the model in use, marked with a check. */
    current?: { provider?: string; id?: string } | null;
    /** Show a first row that clears the choice. */
    defaultLabel?: string;
    onpick: (model: CatalogModel | null) => void;
  };

  let { open, onclose, anchor = null, current = null, defaultLabel, onpick }: Props = $props();

  let query = $state('');
  let active = $state(0);
  let list: HTMLDivElement | undefined = $state();
  let search: HTMLInputElement | undefined = $state();

  const groups = $derived(groupModels(modelCatalog.models, query));
  const flat = $derived(groups.flatMap((g) => g.models));
  const offset = $derived(defaultLabel ? 1 : 0);
  const total = $derived(flat.length + offset);

  $effect(() => {
    if (!open) return;
    modelCatalog.ensure();
    query = '';
    active = 0;
    void tick().then(() => search?.focus({ preventScroll: true }));
  });

  $effect(() => {
    void query;
    active = 0;
  });

  $effect(() => {
    void active;
    void tick().then(() => list?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }));
  });

  function choose(i: number) {
    if (defaultLabel && i === 0) onpick(null);
    else {
      const m = flat[i - offset];
      if (m) onpick(m);
    }
    onclose();
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = total ? (active + 1) % total : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = total ? (active - 1 + total) % total : 0;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (total) choose(active);
    }
  }

  const isCurrent = (m: CatalogModel) => current?.provider === m.provider && current?.id === m.id;

  // Flat index of each model row, so highlighting works across provider groups.
  const indexed = $derived.by(() => {
    let n = offset;
    return groups.map((g) => ({ ...g, models: g.models.map((m) => ({ m, i: n++ })) }));
  });
</script>

<Adaptive {open} {onclose} {anchor} title="Model" width={420} size="md">
  <div class="picker">
    <input
      bind:this={search}
      bind:value={query}
      class="field search"
      type="search"
      placeholder="Search models"
      aria-label="Search models"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      role="combobox"
      aria-expanded="true"
      aria-controls="model-list"
      aria-activedescendant="model-o{active}"
      onkeydown={key}
    />
    <div id="model-list" class="list scroll-y" role="listbox" aria-label="Models" bind:this={list}>
      {#if !modelCatalog.ready}
        {#if modelCatalog.error}
          <div class="note">
            <p>Could not load models</p>
            <p class="sub">{modelCatalog.error}</p>
            <button type="button" class="btn btn-sm" onclick={() => modelCatalog.retry()}>Try again</button>
          </div>
        {:else}
          <div class="skels" aria-hidden="true">
            {#each [1, 2, 3, 4, 5] as n (n)}<span class="skeleton"></span>{/each}
          </div>
          <span class="sr-only" role="status">Fetching models</span>
        {/if}
      {:else}
        {#if defaultLabel}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id="model-o0"
            class="opt"
            class:on={active === 0}
            role="option"
            aria-selected={!current}
            tabindex="-1"
            onclick={() => choose(0)}
            onpointermove={() => (active = 0)}
          >
            <span class="name">{defaultLabel}</span>
            {#if !current}<Icon name="check" size={15} />{/if}
          </div>
        {/if}
        {#each indexed as g (g.provider)}
          <div role="group" aria-label={g.provider}>
            <div class="eyebrow head">{g.provider}</div>
            {#each g.models as { m, i } (m.selector)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id="model-o{i}"
                class="opt"
                class:on={active === i}
                role="option"
                aria-selected={isCurrent(m)}
                tabindex="-1"
                onclick={() => choose(i)}
                onpointermove={() => (active = i)}
              >
                <span class="name truncate">{m.name}</span>
                <span class="facts mono">{compactNumber(m.contextWindow)} · {priceLabel(m.cost)}</span>
                {#if isCurrent(m)}<Icon name="check" size={15} />{/if}
              </div>
            {/each}
          </div>
        {:else}
          <p class="note">No model matches "{query}"</p>
        {/each}
        {#if modelCatalog.refreshing}
          <p class="refresh"><Spinner size={11} label="Refreshing models" /></p>
        {/if}
      {/if}
    </div>
  </div>
</Adaptive>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-height: 0;
    max-height: inherit;
  }
  .search {
    flex: none;
  }
  .list {
    min-height: 120px;
    max-height: min(52vh, 440px);
    margin: 0 calc(var(--s-1) * -1);
    padding: 0 var(--s-1);
  }
  :global(.pop) .picker {
    padding: var(--s-2);
  }
  :global(.pop) .list {
    max-height: min(46vh, 380px);
  }
  .head {
    padding: var(--s-3) var(--s-2) var(--s-1);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-height: max(34px, var(--hit));
    padding: var(--s-1) var(--s-2);
    border-radius: var(--r-md);
    cursor: pointer;
  }
  .opt.on {
    background: var(--press);
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .facts {
    flex: none;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .opt :global(svg) {
    color: var(--accent);
  }
  .skels {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-2);
  }
  .skels span {
    height: 20px;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .note {
    display: grid;
    justify-items: center;
    gap: var(--s-2);
    padding: var(--s-5) var(--s-3);
    color: var(--ink-3);
    text-align: center;
  }
  .sub {
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .refresh {
    display: grid;
    place-items: center;
    padding: var(--s-2);
  }
  @keyframes shimmer {
    50% { opacity: 0.5; }
  }
</style>
