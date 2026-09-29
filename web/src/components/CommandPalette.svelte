<script lang="ts">
  // Ctrl/Cmd+K. One search box over live sessions, history, actions, settings pages and the
  // open session's slash commands. The data and ranking live in lib/palette; this is the list.
  import { onMount, tick } from 'svelte';
  import { paletteActions } from '../lib/actions.svelte';
  import { keyLabels, shortcutFor } from '../lib/keymap';
  import { buildPaletteItems, KIND_LABEL, rankItems, type PaletteItem, type PaletteKind } from '../lib/palette/palette';
  import { active, nav, sessionsStore } from '../lib/state';
  import { Icon, Kbd, Sheet } from '../lib/ui';
  import type { OverlayProps } from '../lib/overlays';
  import { viewport } from '../lib/ui/media.svelte';
  import StatusGlyph from './StatusGlyph.svelte';

  let { onclose }: OverlayProps = $props();

  const KIND_TAG: Record<PaletteKind, string> = {
    action: 'Action', session: 'Session', slash: 'Slash', setting: 'Settings', history: 'History',
  };

  let query = $state('');
  let sel = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  const uid = $props.id();
  const now = Date.now();

  const items = $derived(
    buildPaletteItems({
      live: sessionsStore.live,
      saved: sessionsStore.saved,
      activeGwId: nav.gwId,
      commands: active.commands,
      now,
      actions: paletteActions(),
    }),
  );
  const results = $derived(rankItems(items, query));
  const heads = $derived(query.trim().replace(/^[>/]\s*/, '') === '');

  // Rows carry their flat index; sections only add headings when nothing is being searched.
  const sections = $derived.by(() => {
    const out: { kind: PaletteKind; rows: { item: PaletteItem; i: number }[] }[] = [];
    results.forEach((item, i) => {
      const last = out.at(-1);
      if (heads && last?.kind === item.kind) last.rows.push({ item, i });
      else if (!heads && last) last.rows.push({ item, i });
      else out.push({ kind: item.kind, rows: [{ item, i }] });
    });
    return out;
  });

  $effect(() => {
    void query;
    sel = 0;
  });

  $effect(() => {
    void sel;
    void tick().then(() => list?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }));
  });

  onMount(() => {
    void tick().then(() => input?.focus({ preventScroll: true }));
  });

  function choose(i: number) {
    const item = results[i];
    if (!item) return;
    onclose();
    // Let the sheet close and focus return before the action opens something else.
    queueMicrotask(item.run);
  }

  function key(e: KeyboardEvent) {
    const n = results.length;
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'ArrowDown' || (ctrl && e.key.toLowerCase() === 'n')) {
      e.preventDefault();
      sel = n ? (sel + 1) % n : 0;
    } else if (e.key === 'ArrowUp' || (ctrl && e.key.toLowerCase() === 'p')) {
      e.preventDefault();
      sel = n ? (sel - 1 + n) % n : 0;
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      sel = 0;
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault();
      sel = Math.max(0, n - 1);
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      choose(sel);
    }
  }
</script>

<Sheet open {onclose} bare label="Command palette" size="md" flush fillNarrow place="top">
  <div class="palette">
    <div class="search">
      <Icon name="search" size={18} />
      <input
        bind:this={input}
        bind:value={query}
        type="search"
        placeholder="Search sessions, actions and settings"
        aria-label="Search sessions, actions and settings"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="go"
        role="combobox"
        aria-expanded="true"
        aria-controls="{uid}-list"
        aria-activedescendant={results.length ? `${uid}-o${sel}` : undefined}
        onkeydown={key}
      />
      <button type="button" class="icon-btn close" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </div>

    <div id="{uid}-list" class="list scroll-y" role="listbox" aria-label="Results" bind:this={list}>
      {#each sections as sec, si (si)}
        <div role="group" aria-label={heads ? KIND_LABEL[sec.kind] : 'Results'}>
          {#if heads}<div class="eyebrow head" aria-hidden="true">{KIND_LABEL[sec.kind]}</div>{/if}
          {#each sec.rows as { item, i } (item.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="{uid}-o{i}"
              class="opt"
              class:on={sel === i}
              role="option"
              aria-selected={sel === i}
              tabindex="-1"
              onclick={() => choose(i)}
              onpointermove={() => (sel = i)}
            >
              <span class="lead">
                {#if item.status}
                  <StatusGlyph status={item.status} />
                {:else}
                  <Icon name={item.icon} size={16} />
                {/if}
              </span>
              <span class="text">
                <span class="title truncate" class:mono={item.kind === 'slash'}>{item.title}</span>
                {#if item.sub}<span class="sub truncate">{item.sub}</span>{/if}
              </span>
              {#if item.current}
                <span class="tag">Open</span>
              {:else if item.shortcut && !viewport.coarse}
                <span class="keys">
                  {#each keyLabels(shortcutFor(item.shortcut).chord) as k, ki (ki)}<Kbd>{k}</Kbd>{/each}
                </span>
              {:else if !heads}
                <span class="tag">{KIND_TAG[item.kind]}</span>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty">
          <p>Nothing matches "{query.trim()}"</p>
          <p class="hint">Start with &gt; for actions and settings, or / for slash commands.</p>
        </div>
      {/each}
    </div>
    <p class="sr-only" role="status">{results.length} {results.length === 1 ? 'result' : 'results'}</p>

    {#if !viewport.coarse}
      <div class="foot" aria-hidden="true">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span><Kbd>Enter</Kbd> open</span>
        <span><Kbd>Esc</Kbd> close</span>
        <span class="grow">&gt; actions, / slash commands</span>
      </div>
    {/if}
  </div>
</Sheet>

<style>
  .palette {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex: none;
    padding: 0 var(--s-2) 0 var(--s-4);
    border-bottom: 1px solid var(--line);
    color: var(--ink-3);
  }
  .search input {
    flex: 1;
    min-width: 0;
    min-height: 52px;
    padding: 0;
    background: none;
    border: 0;
    color: var(--ink);
    font-size: var(--fs-lg);
    appearance: none;
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .search input:focus-visible {
    outline: none;
  }
  .search:focus-within {
    color: var(--accent);
  }
  .close {
    display: none;
  }
  .list {
    flex: 1 1 auto;
    min-height: 0;
    max-height: min(60vh, 460px);
    padding: var(--s-2);
  }
  .head {
    padding: var(--s-3) var(--s-3) var(--s-1);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-height: max(44px, var(--hit));
    padding: var(--s-1) var(--s-3);
    border-radius: var(--r-md);
    cursor: pointer;
  }
  .opt.on {
    background: var(--press);
  }
  .lead {
    flex: none;
    width: 16px;
    display: grid;
    place-items: center;
    color: var(--ink-2);
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
  .title.mono {
    font-weight: 400;
  }
  .sub {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .tag {
    flex: none;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .keys {
    display: inline-flex;
    gap: var(--s-1);
    flex: none;
  }
  .empty {
    display: grid;
    gap: var(--s-1);
    justify-items: center;
    padding: var(--s-6) var(--s-4);
    color: var(--ink-2);
    text-align: center;
    overflow-wrap: anywhere;
  }
  .hint {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-4);
    flex: none;
    padding: var(--s-2) var(--s-4);
    border-top: 1px solid var(--line);
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .foot span {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
  }
  .foot .grow {
    margin-left: auto;
  }

  @media (max-width: 899.98px) {
    .close {
      display: inline-flex;
    }
    .list {
      max-height: none;
      padding-bottom: calc(var(--s-2) + var(--safe-b));
    }
    .search input {
      min-height: 56px;
    }
  }
</style>
