<script lang="ts">
  import { tick } from 'svelte';
  import { shortcutText } from '../lib/keymap';
  import { openOverlay, openSettings } from '../lib/overlays';
  import type { SavedSession } from '../lib/api/types';
  import { pins } from '../lib/state';
  import { basename, relativeTime, savedFolderLabel, savedTitle, sessionTitle, uniqueCwds } from '../lib/format';
  import { active, auth, folderFilter, nav, reviewed, sessionsStore, ui } from '../lib/state';
  import { folderCounts } from '../lib/state/folders.svelte';
  import { confirm, Icon, Kbd, Menu, type MenuItem } from '../lib/ui';
  import type { ExternalSession, SessionInfo } from '../lib/api/types';
  import ConnectionDot from './ConnectionDot.svelte';
  import RailRow from './RailRow.svelte';
  import ExternalRow from './ExternalRow.svelte';
  import type { SessionStatus } from './StatusGlyph.svelte';

  const groups = $derived(sessionsStore.groups);
  const liveCwds = $derived(uniqueCwds(sessionsStore.live));
  const empty = $derived(
    sessionsStore.loaded &&
      !groups.needsYou.length && !groups.review.length && !groups.running.length && !groups.idle.length &&
      !groups.pinned.length && !groups.history.length && !groups.hiddenCount &&
      !groups.externalNeedsYou.length && !groups.externalRest.length,
  );

  // ---- folder filter: hide whole folders of saved transcripts (scheduler runs, /tmp probes)
  // Count only what the filter can actually hide: live/running and pinned
  // transcripts always show, so they would inflate the numbers.
  const folders = $derived.by(() => {
    const liveFiles = new Set(sessionsStore.live.filter((s) => !s.exited).map((s) => s.ompSessionFile).filter(Boolean));
    return folderCounts(
      sessionsStore.saved.filter((s) => !s.running && !liveFiles.has(s.file) && !pins.isPinned(s.file)),
    );
  });
  // Keys for folders no longer listed (deleted, aged out) do not count as "some hidden".
  const hiddenOn = $derived(folders.some((f) => folderFilter.isHidden(f.key)));
  let filterOpen = $state(false);
  let filterBtn: HTMLButtonElement | undefined = $state();
  let searchBtn: HTMLButtonElement | undefined = $state();

  async function showAllFolders() {
    folderFilter.showAll();
    // The note unmounts with the last hidden row, and with a single folder left so
    // does the filter button; land focus on whichever header control survives.
    await tick();
    (filterBtn?.isConnected ? filterBtn : searchBtn)?.focus();
  }

  function folderLabel(key: string): string {
    return key.startsWith('/') ? basename(key) || '/' : key.replace(/^-+/, '') || key;
  }

  const filterItems = $derived.by((): MenuItem[] => {
    const labels = folders.map((f) => folderLabel(f.key));
    const items: MenuItem[] = folders.map((f, i) => {
      // Two folders with one basename (~/tmp and /tmp) fall back to the full path.
      const label = labels.indexOf(labels[i]!) !== labels.lastIndexOf(labels[i]!) ? f.key : labels[i]!;
      return {
        id: `folder:${f.key}`,
        label: `${label} (${f.count})`,
        checked: !folderFilter.isHidden(f.key),
        checkbox: true,
        onselect: () => folderFilter.toggle(f.key),
      };
    });
    if (hiddenOn) items.unshift({ id: 'show-all', label: 'Show all folders', icon: 'refresh', onselect: () => folderFilter.showAll() });
    return items;
  });
  // Rows show "5m" style stamps; one shared tick keeps them current without a timer per row.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const live: { key: 'needsYou' | 'review' | 'running' | 'idle'; label: string; status: SessionStatus }[] = [
    { key: 'needsYou', label: 'Needs you', status: 'needs' },
    { key: 'review', label: 'Ready for review', status: 'review' },
    { key: 'running', label: 'Running', status: 'running' },
    { key: 'idle', label: 'Idle', status: 'idle' },
  ];

  /** Live rows carry review actions; saved rows carry pin/unpin actions. */
  function rowMenu(s: SessionInfo): MenuItem[] {
    if (reviewed.needsReview.has(s.gwId)) {
      return [{ id: 'unpin', label: 'Unpin', icon: 'x', onselect: () => reviewed.unflag(s.gwId) }];
    }
    return [{ id: 'review', label: 'Mark ready for review', icon: 'flag', onselect: () => reviewed.flag(s.gwId) }];
  }

  function savedMenu(s: SavedSession): MenuItem[] {
    const isPinned = pins.isPinned(s.file);
    return [{
      id: isPinned ? 'unpin-session' : 'pin-session',
      label: isPinned ? 'Unpin from list' : 'Pin to top of list',
      icon: isPinned ? 'x' : 'pin',
      onselect: () => pins.toggle(s.file),
    }];
  }

  function liveSub(s: SessionInfo): string {
    const model = s.model?.name ?? s.model?.id;
    return [basename(s.cwd), model].filter(Boolean).join(' · ');
  }

  function connection(): 'live' | 'connecting' | 'offline' {
    if (sessionsStore.error) return 'offline';
    if (active.gwId && active.connection.state !== 'live') return 'connecting';
    return 'live';
  }

  async function signOut() {
    if (await confirm({ title: 'Sign out', body: 'Live sessions keep running on the gateway.', confirmLabel: 'Sign out' })) {
      await auth.logout();
    }
  }

  function openNew(e: MouseEvent) {
    ui.open('new-session', e.currentTarget as HTMLElement);
  }

  /** External rows render inside the Needs you section; other groups have none. */
  function extFor(key: 'needsYou' | 'review' | 'running' | 'idle'): ExternalSession[] {
    return key === 'needsYou' ? groups.externalNeedsYou : [];
  }
</script>

<nav class="rail" aria-label="Sessions">
  <header>
    <span class="brand"><Icon name="mark" size={22} /><span>omp</span></span>
    <span class="spacer"></span>
    <button bind:this={searchBtn} type="button" class="icon-btn" aria-label="Search" title="Search ({shortcutText('palette')})" onclick={() => openOverlay('palette')}>
      <Icon name="search" />
    </button>
    {#if folders.length > 1 || hiddenOn}
      <button
        bind:this={filterBtn}
        type="button"
        class="icon-btn filter"
        class:on={hiddenOn}
        aria-label={hiddenOn ? 'Filter folders (some hidden)' : 'Filter folders'}
        title="Show or hide folders"
        aria-haspopup="menu"
        aria-expanded={filterOpen}
        onclick={() => (filterOpen = !filterOpen)}
      >
        <Icon name="filter" />
      </button>
    {/if}
    <button
      type="button"
      class="icon-btn new"
      aria-label="New session"
      title="New session ({shortcutText('new-session')})"
      onclick={openNew}
    >
      <Icon name="plus" />
    </button>
  </header>

  <div class="scroll scroll-y">
    {#if !sessionsStore.loaded}
      <div class="skeletons" aria-hidden="true">
        {#each [72, 58, 66, 50] as w}
          <div class="sk-row"><span class="skeleton dot"></span><span class="skeleton line" style:width="{w}%"></span></div>
        {/each}
      </div>
    {:else if empty}
      <div class="empty">
        <p>No sessions yet</p>
        <button type="button" class="btn btn-primary" onclick={openNew}>
          <Icon name="plus" size={16} /> New session <Kbd>{shortcutText('new-session')}</Kbd>
        </button>
      </div>
    {:else}
      {#each live as g (g.key)}
        {@const list = groups[g.key]}
        {@const external = extFor(g.key)}
        {#if list.length || external.length}
          <section aria-labelledby="rail-{g.key}">
            <h2 id="rail-{g.key}" class="eyebrow"><span>{g.label}</span><span class="count">{list.length + external.length}</span></h2>
            {#each list as s (s.gwId)}
              <RailRow
                title={sessionTitle(s, sessionsStore.saved)}
                sub={liveSub(s)}
                status={g.status}
                active={nav.gwId === s.gwId}
                badge={s.pendingUi.length}
                forked={s.gwId in sessionsStore.forked}
                menu={rowMenu(s)}
                onclick={() => nav.open(s.gwId)}
              />
            {/each}
            {#each external as row (row.instanceId)}
              <ExternalRow {row} />
            {/each}
          </section>
        {/if}
      {/each}

      {#if groups.externalRest.length}
        <section aria-labelledby="rail-elsewhere">
          <h2 id="rail-elsewhere" class="eyebrow"><span>Other terminals</span><span class="count">{groups.externalRest.length}</span></h2>
          {#each groups.externalRest as row (row.instanceId)}
            <ExternalRow {row} />
          {/each}
        </section>
      {/if}

      {#if groups.pinned.length}
        <section aria-labelledby="rail-pinned">
          <h2 id="rail-pinned" class="eyebrow"><span>Pinned</span><span class="count">{groups.pinned.length}</span></h2>
          {#each groups.pinned as s (s.file)}
            <RailRow
              title={savedTitle(s, liveCwds)}
              sub="{savedFolderLabel(s, liveCwds)} · {relativeTime(s.mtime * 1000, now)}"
              busy={nav.resuming === s.file}
              pinned
              menu={savedMenu(s)}
              onclick={() => nav.resume(s)}
            />
          {/each}
        </section>
      {/if}

      {#each groups.history as h (h.key)}
        <section aria-labelledby="rail-{h.key}">
          <h2 id="rail-{h.key}" class="eyebrow"><span>{h.label}</span><span class="count">{h.items.length}</span></h2>
          {#each h.items as s (s.file)}
            <RailRow
              title={savedTitle(s, liveCwds)}
              sub="{savedFolderLabel(s, liveCwds)} · {relativeTime(s.mtime * 1000, now)}"
              busy={nav.resuming === s.file}
              menu={savedMenu(s)}
              onclick={() => nav.resume(s)}
            />
          {/each}
        </section>
      {/each}

      {#if groups.hiddenCount}
        <p class="hidden-note" role="status">
          <span>{groups.hiddenCount} hidden by folder filter</span>
          <button
            type="button"
            class="link"
            onclick={showAllFolders}
          >Show all</button>
        </p>
      {/if}
    {/if}

    {#if sessionsStore.error}
      <p class="error" role="status">Can't reach the gateway. Trying again.</p>
    {/if}
  </div>

  <footer>
    <ConnectionDot state={connection()} />
    <span class="spacer"></span>
    <button type="button" class="icon-btn" aria-label="Settings" title="Settings ({shortcutText('settings')})" onclick={() => openSettings()}>
      <Icon name="sliders" />
    </button>
    <button type="button" class="icon-btn" aria-label="Search transcripts" title="Search transcripts" aria-pressed={nav.search} onclick={() => nav.openSearch()}>
      <Icon name="search" />
    </button>
    <button type="button" class="icon-btn" aria-label="Clean up sessions" title="Clean up sessions" onclick={() => openOverlay('session-cleanup')}>
      <Icon name="broom" />
    </button>
    <button
      type="button"
      class="icon-btn"
      aria-label="Usage"
      title="Usage"
      aria-pressed={nav.usage}
      onclick={() => nav.openUsage()}
    >
      <Icon name="chart" />
    </button>
    <button type="button" class="icon-btn" aria-label="Sign out" title="Sign out" onclick={signOut}>
      <Icon name="power" />
    </button>
  </footer>
</nav>

<Menu open={filterOpen} onclose={() => (filterOpen = false)} anchor={filterBtn} title="Show folders" items={filterItems} />

<style>
  .rail {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
    border-right: 1px solid var(--line);
    padding-top: var(--safe-t);
  }
  header,
  footer {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    padding: var(--s-2) var(--s-3);
    flex: none;
  }
  header {
    min-height: 52px;
  }
  footer {
    border-top: 1px solid var(--line);
    padding-bottom: calc(var(--s-2) + var(--safe-b));
  }
  .spacer {
    flex: 1;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--accent);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .brand span:last-child {
    color: var(--ink);
  }
  .new {
    color: var(--ink);
  }
  .filter.on {
    color: var(--accent);
  }
  .hidden-note {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    margin: var(--s-4) var(--s-3) 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .link {
    color: var(--accent);
    font-size: inherit;
    min-height: var(--hit);
    padding: 0 var(--s-1);
  }
  .link:hover {
    text-decoration: underline;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    padding: var(--s-1) var(--s-2) var(--s-4);
  }
  section + section {
    margin-top: var(--s-3);
  }
  h2 {
    display: flex;
    justify-content: space-between;
    padding: var(--s-3) var(--s-3) var(--s-1);
  }
  .count {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }
  .skeletons {
    display: grid;
    gap: var(--s-3);
    padding: var(--s-3);
  }
  .sk-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }
  .sk-row .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    min-height: 0;
  }
  .sk-row .line {
    height: 12px;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .empty {
    display: grid;
    gap: var(--s-4);
    justify-items: center;
    padding: var(--s-7) var(--s-4);
    color: var(--ink-3);
    text-align: center;
  }
  .error {
    margin: var(--s-4) var(--s-3);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  @keyframes shimmer {
    50% { opacity: 0.5; }
  }
</style>
