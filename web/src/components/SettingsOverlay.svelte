<script lang="ts">
  // Ctrl/Cmd+,. Pages on the left (a stacked list on phones), and a search that jumps to one setting.
  import { onMount, tick } from 'svelte';
  import type { OverlayProps } from '../lib/overlays';
  import { pageTitle, searchSettings, SETTINGS_PAGES, type SettingsPageId, type SettingsTarget } from '../lib/palette/settings-index';
  import { ui } from '../lib/state';
  import { configDraft } from '../lib/state/config-draft.svelte';
  import { confirm, Icon, Sheet } from '../lib/ui';
  import { viewport } from '../lib/ui/media.svelte';
  import AgentConfigPage from './settings/AgentConfigPage.svelte';
  import AppearancePage from './settings/AppearancePage.svelte';
  import ConnectionPage from './settings/ConnectionPage.svelte';
  import ModelsPage from './settings/ModelsPage.svelte';
  import ShortcutsPage from './settings/ShortcutsPage.svelte';
  import SkillsPage from './settings/SkillsPage.svelte';
  import UsagePage from './settings/UsagePage.svelte';

  let { onclose }: OverlayProps = $props();

  const uid = $props.id();
  let query = $state('');
  let sel = $state(0);
  let page = $state<SettingsPageId>('appearance');
  /** Phones show either the list of pages or one page. */
  let showPage = $state(false);
  let content: HTMLDivElement | undefined = $state();
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  const hits = $derived(searchSettings(query));
  const searching = $derived(query.trim() !== '');
  const narrow = $derived(viewport.narrow);

  $effect(() => {
    void query;
    sel = 0;
  });

  // A palette or shortcut opened settings at a page or a single setting.
  $effect(() => {
    const at = ui.settingsAt;
    if (!at) return;
    ui.settingsAt = null;
    void go(at);
  });

  async function go(target: SettingsTarget) {
    page = target.page;
    showPage = true;
    query = '';
    await tick();
    const el = target.entry ? content?.querySelector<HTMLElement>(`#setting-${target.entry}`) : null;
    if (!el) {
      if (content) content.scrollTop = 0;
      return;
    }
    const calm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    el.classList.remove('setting-flash');
    void el.offsetWidth;
    el.classList.add('setting-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('setting-flash'), 1700);
  }

  function searchKey(e: KeyboardEvent) {
    const n = hits.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = n ? (sel + 1) % n : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = n ? (sel - 1 + n) % n : 0;
    } else if (e.key === 'Enter') {
      const hit = hits[sel];
      if (hit) {
        e.preventDefault();
        void go({ page: hit.page.id, entry: hit.entry.id });
      }
    } else if (e.key === 'Escape' && query) {
      // First Escape clears the search; a second one closes settings.
      e.preventDefault();
      e.stopPropagation();
      query = '';
    }
  }

  function close(): void {
    ui.tryClose('settings');
  }

  onMount(() => {
    ui.guard('settings', () => {
      if (!configDraft.dirty) return true;
      void confirm({
        title: 'Discard unsaved changes',
        body: 'The agent config has edits that were not saved.',
        confirmLabel: 'Discard',
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        configDraft.discard();
        ui.close('settings');
      });
      return false;
    });
    return () => {
      ui.guard('settings', null);
      clearTimeout(flashTimer);
    };
  });
</script>

<Sheet open onclose={close} title="Settings" size="xl" flush fixedHeight fillNarrow>
  <div class="settings" class:page-view={showPage}>
    <div class="side">
      <div class="search">
        <Icon name="search" size={16} />
        <input
          type="search"
          role="combobox"
          aria-label="Search settings"
          aria-expanded={searching}
          aria-controls="{uid}-hits"
          aria-activedescendant={searching && hits.length ? `${uid}-h${sel}` : undefined}
          placeholder="Search settings"
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
          onkeydown={searchKey}
        />
      </div>

      {#if searching}
        <div id="{uid}-hits" class="hits" role="listbox" aria-label="Matching settings">
          {#each hits as h, i (h.entry.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="{uid}-h{i}"
              role="option"
              tabindex="-1"
              aria-selected={sel === i}
              class="hit"
              class:on={sel === i}
              onclick={() => go({ page: h.page.id, entry: h.entry.id })}
              onpointermove={() => (sel = i)}
            >
              <span class="label">{h.entry.label}</span>
              <span class="where">{h.page.title}</span>
            </div>
          {:else}
            <p class="none">Nothing matches "{query.trim()}"</p>
          {/each}
        </div>
        <p class="sr-only" role="status">{hits.length} {hits.length === 1 ? 'setting' : 'settings'} found</p>
      {:else}
        <nav aria-label="Settings pages" class="nav">
          {#each SETTINGS_PAGES as p (p.id)}
            <button
              type="button"
              class="item"
              class:on={!narrow && page === p.id}
              aria-current={!narrow && page === p.id ? 'page' : undefined}
              onclick={() => go({ page: p.id })}
            >
              <span class="t">{p.title}</span>
              <span class="b">{p.blurb}</span>
              <Icon name="chevron-right" size={16} />
            </button>
          {/each}
        </nav>
      {/if}
    </div>

    <div class="main" bind:this={content}>
      <div class="crumb">
        <button type="button" class="btn btn-ghost btn-sm back" onclick={() => (showPage = false)}>
          <Icon name="chevron-right" size={14} /> Settings
        </button>
      </div>
      <div class="pad">
        <h3 class="page-title">{pageTitle(page)}</h3>
        {#if page === 'appearance'}
          <AppearancePage />
        {:else if page === 'agent'}
          <AgentConfigPage />
        {:else if page === 'models'}
          <ModelsPage />
        {:else if page === 'skills'}
          <SkillsPage />
        {:else if page === 'usage'}
          <UsagePage />
        {:else if page === 'connection'}
          <ConnectionPage />
        {:else}
          <ShortcutsPage />
        {/if}
      </div>
    </div>
  </div>
</Sheet>

<style>
  .settings {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
  }
  .side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--line);
    background: var(--canvas);
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex: none;
    margin: var(--s-3);
    padding: 0 var(--s-3);
    border-radius: var(--r-md);
    background: var(--field);
    box-shadow: var(--ring);
    color: var(--ink-3);
  }
  .search:focus-within {
    box-shadow: var(--focus);
    color: var(--accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    min-height: var(--hit);
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    appearance: none;
  }
  .search input:focus-visible {
    outline: none;
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .nav,
  .hits {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--s-2) var(--s-3);
  }
  .item,
  .hit {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    width: 100%;
    min-height: var(--hit);
    padding: var(--s-1) var(--s-3);
    border-radius: var(--r-md);
    color: var(--ink-2);
    text-align: left;
    cursor: pointer;
  }
  .item:hover,
  .hit.on {
    background: var(--hover);
    color: var(--ink);
  }
  .item.on {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .item .t {
    font-weight: 500;
  }
  .item .b {
    display: none;
    flex: 1;
    min-width: 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .item :global(svg) {
    display: none;
    margin-left: auto;
    flex: none;
    color: var(--ink-3);
  }
  .hit {
    justify-content: space-between;
  }
  .hit .where {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    flex: none;
  }
  .none {
    padding: var(--s-4) var(--s-3);
    color: var(--ink-3);
    overflow-wrap: anywhere;
  }

  .main {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .crumb {
    display: none;
  }
  .pad {
    padding: var(--s-4) var(--s-5) var(--s-6);
    max-width: 680px;
  }
  .page-title {
    font-size: var(--fs-xl);
    font-weight: 600;
    margin-bottom: var(--s-1);
  }
  .back :global(svg) {
    transform: rotate(180deg);
  }

  @media (max-width: 899.98px) {
    .settings {
      grid-template-columns: minmax(0, 1fr);
    }
    .side {
      border-right: 0;
      background: none;
    }
    .item {
      min-height: 56px;
    }
    .item .b {
      display: block;
    }
    .item .t {
      flex: none;
      min-width: 92px;
    }
    .item :global(svg) {
      display: block;
    }
    .main {
      display: none;
    }
    .page-view .side {
      display: none;
    }
    .page-view .main {
      display: block;
    }
    .crumb {
      display: block;
      position: sticky;
      top: 0;
      z-index: 1;
      padding: var(--s-1) var(--s-2);
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }
    .pad {
      padding: var(--s-3) var(--s-4) calc(var(--s-6) + var(--safe-b));
    }
    .nav,
    .hits {
      padding-bottom: calc(var(--s-3) + var(--safe-b));
    }
  }
</style>
