<script lang="ts">
  // Project kanban workspace: boards index (#/kanban) and per-project 4-column board (#/kanban?cwd=...).
  import { ApiError } from '../lib/api/client';
  import type { KanbanBoard, KanbanColumnId, KanbanTicket } from '../lib/api/types';
  import { basename, relativeTime } from '../lib/format';
  import { nav, ui } from '../lib/state';
  import {
    KANBAN_COLUMNS, allBoardTags, countInColumn, doneTicketIds, formatKanbanPriority,
    isTicketClaimed, kanbanStore, openTicketCount, ticketsInColumn, unmetBlockers,
  } from '../lib/state/kanban.svelte';
  import { Icon, Menu, Spinner, toast, type MenuItem } from '../lib/ui';
  import { viewport } from '../lib/ui/media.svelte';
  import KanbanArchiveSheet from './KanbanArchiveSheet.svelte';
  import KanbanFolderSheet from './KanbanFolderSheet.svelte';
  import KanbanTicketSheet from './KanbanTicketSheet.svelte';

  const selectedCwd = $derived(nav.kanbanCwd);

  // One shared tick so relative timestamps and 45m claim TTL badges stay fresh.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  $effect(() => {
    const cwd = selectedCwd;
    if (cwd) {
      void kanbanStore.loadBoard(cwd);
    } else {
      kanbanStore.clearBoard();
      void kanbanStore.loadBoards();
    }
  });

  // Board-level UI state, reset when switching projects.
  let activeCol = $state<KanbanColumnId>('todo');
  let search = $state('');
  let selectedTag = $state<string | null>(null);
  let folderOpen = $state(false);
  let archiveOpen = $state(false);
  let editorOpen = $state(false);
  let editingTicket = $state<KanbanTicket | null>(null);
  let editorCol = $state<KanbanColumnId>('todo');
  let boardMenuOpen = $state(false);
  let boardMenuBtn: HTMLButtonElement | undefined = $state();
  let ticketMenuTicket = $state<KanbanTicket | null>(null);
  let ticketMenuAnchor = $state<HTMLElement | null>(null);

  $effect(() => {
    void selectedCwd;
    search = '';
    selectedTag = null;
    activeCol = 'todo';
    editorOpen = false;
    editingTicket = null;
    archiveOpen = false;
    ticketMenuTicket = null;
  });

  const board = $derived(kanbanStore.board);
  const doneIds = $derived(board ? doneTicketIds(board) : new Set<string>());
  const tags = $derived(board ? allBoardTags(board) : []);

  // Clear stale tag selection if the last ticket with that tag was edited or deleted.
  $effect(() => {
    if (selectedTag && !tags.includes(selectedTag)) selectedTag = null;
  });

  const projectTitle = $derived.by(() => {
    if (!selectedCwd) return 'Boards';
    return basename(selectedCwd) || selectedCwd;
  });

  function openDrawer(e: MouseEvent) {
    ui.open('drawer', e.currentTarget as HTMLElement);
  }

  function errMsg(e: unknown, fallback: string): string {
    return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
  }

  function openNewTicket(col: KanbanColumnId = activeCol) {
    editingTicket = null;
    editorCol = col;
    editorOpen = true;
  }

  function openTicket(t: KanbanTicket) {
    editingTicket = t;
    editorCol = t.column;
    editorOpen = true;
  }

  async function initBoard() {
    if (!selectedCwd || kanbanStore.mutating) return;
    try {
      await kanbanStore.initBoard(selectedCwd);
      toast('Board created');
    } catch (e) {
      ui.error(errMsg(e, 'Could not create board.'));
    }
  }

  async function archiveOldDone() {
    if (!selectedCwd || kanbanStore.mutating) return;
    try {
      const moved = await kanbanStore.archiveOldDone(selectedCwd);
      toast(
        moved === 0
          ? 'No done tickets older than 7 days.'
          : `Archived ${moved} ${moved === 1 ? 'ticket' : 'tickets'}.`,
      );
    } catch (e) {
      ui.error(errMsg(e, 'Could not archive tickets.'));
    }
  }

  async function quickMove(ticket: KanbanTicket, column: KanbanColumnId) {
    if (!selectedCwd || kanbanStore.mutating) return;
    try {
      await kanbanStore.moveTicket(selectedCwd, ticket.id, column);
    } catch (e) {
      ui.error(errMsg(e, 'Could not move ticket.'));
    }
  }

  async function quickClaimToggle(ticket: KanbanTicket) {
    if (!selectedCwd || kanbanStore.mutating) return;
    const claimed = isTicketClaimed(ticket, now);
    try {
      if (claimed) {
        await kanbanStore.releaseTicket(selectedCwd, ticket.id);
        toast(`Released ${ticket.id}`);
      } else {
        await kanbanStore.claimTicket(selectedCwd, ticket.id);
        toast(`Claimed ${ticket.id} to Doing`);
      }
    } catch (e) {
      ui.error(errMsg(e, 'Could not update claim.'));
    }
  }

  const boardMenuItems = $derived<MenuItem[]>([
    {
      id: 'refresh',
      label: 'Refresh',
      icon: 'refresh',
      onselect: () => selectedCwd && void kanbanStore.loadBoard(selectedCwd),
    },
    {
      id: 'archive-old',
      label: 'Archive done (>7d)',
      icon: 'compress',
      disabled: !board?.exists || kanbanStore.mutating,
      onselect: () => void archiveOldDone(),
    },
    {
      id: 'view-archive',
      label: 'View archive',
      icon: 'clock',
      disabled: !selectedCwd,
      onselect: () => (archiveOpen = true),
    },
  ]);

  const ticketMenuItems = $derived.by((): MenuItem[] => {
    const t = ticketMenuTicket;
    if (!t) return [];
    const claimed = isTicketClaimed(t, now);
    return [
      { id: 'edit', label: `Edit ${t.id}`, icon: 'pencil', onselect: () => openTicket(t) },
      {
        id: 'claim',
        label: claimed ? 'Release claim' : 'Claim to Doing',
        icon: claimed ? 'x' : 'check',
        onselect: () => void quickClaimToggle(t),
      },
      ...KANBAN_COLUMNS.filter((c) => c.id !== t.column).map((c) => ({
        id: `move:${c.id}`,
        label: `Move to ${c.title}`,
        icon: 'chevron-right' as const,
        onselect: () => void quickMove(t, c.id),
      })),
    ];
  });

  function stamp(iso: string | null): string {
    if (!iso) return '';
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? relativeTime(ms, now) : '';
  }

  function hasTicketsIn(b: KanbanBoard, col: KanbanColumnId): KanbanTicket[] {
    return ticketsInColumn(b, col, { tag: selectedTag, query: search });
  }
</script>

<div class="kanban" class:board-mode={!!selectedCwd}>
  <header class="head">
    {#if viewport.narrow}
      <button type="button" class="icon-btn" aria-label="Sessions" onclick={openDrawer}>
        <Icon name="menu" />
      </button>
    {/if}
    {#if selectedCwd}
      <button
        type="button"
        class="icon-btn"
        aria-label="All boards"
        title="All boards"
        onclick={() => nav.openKanban(null)}
      >
        <Icon name="arrow-left" />
      </button>
    {/if}

    <div class="titles">
      <h1 class="truncate">{projectTitle}</h1>
      {#if selectedCwd}
        <p class="cwd mono truncate" title={selectedCwd}>{selectedCwd}</p>
      {:else}
        <p class="sub">Per-project boards stored in <code class="mono">.omp/kanban/board.json</code></p>
      {/if}
    </div>

    <div class="actions">
      {#if !selectedCwd}
        <button
          type="button"
          class="icon-btn"
          aria-label="Refresh boards"
          title="Refresh"
          disabled={kanbanStore.boardsLoading}
          onclick={() => void kanbanStore.loadBoards()}
        >
          <Icon name="refresh" />
        </button>
        <button type="button" class="btn btn-sm" onclick={() => (folderOpen = true)}>
          <Icon name="plus" size={14} />
          Open folder
        </button>
      {:else}
        {#if board?.exists || (board && board.tickets.length > 0)}
          <button type="button" class="btn btn-primary btn-sm" onclick={() => openNewTicket(activeCol)}>
            <Icon name="plus" size={14} />
            New ticket
          </button>
        {/if}
        <button
          bind:this={boardMenuBtn}
          type="button"
          class="icon-btn"
          aria-label="Board options"
          aria-haspopup="menu"
          aria-expanded={boardMenuOpen}
          onclick={() => (boardMenuOpen = !boardMenuOpen)}
        >
          <Icon name="more" />
        </button>
      {/if}
    </div>
  </header>

  {#if !selectedCwd}
    <div class="index-body scroll-y">
      {#if kanbanStore.boardsError && !kanbanStore.boardsLoaded}
        <div class="center-state">
          <p class="err" role="alert">{kanbanStore.boardsError}</p>
          <button type="button" class="btn" onclick={() => void kanbanStore.loadBoards()}>Retry</button>
        </div>
      {:else if !kanbanStore.boardsLoaded && kanbanStore.boardsLoading}
        <div class="center-state"><Spinner size={18} label="Loading boards" /></div>
      {:else}
        {#if kanbanStore.boardsError}
          <div class="banner" role="alert">
            <span>{kanbanStore.boardsError}</span>
            <button type="button" class="btn btn-sm" onclick={() => void kanbanStore.loadBoards()}>Retry</button>
          </div>
        {/if}

        {#if kanbanStore.boards.length === 0}
          <div class="empty-card">
            <p class="empty-title">No kanban boards found yet.</p>
            <p class="empty-sub">
              Boards live in <code class="mono">&lt;project&gt;/.omp/kanban/board.json</code>. Open a project folder to initialize one.
            </p>
            <button type="button" class="btn" onclick={() => (folderOpen = true)}>
              <Icon name="plus" size={14} />
              Open project folder
            </button>
          </div>
        {:else}
          <div class="board-grid">
            {#each kanbanStore.boards as b (b.cwd)}
              {@const openCount = openTicketCount(b)}
              {@const when = stamp(b.updated)}
              <button
                type="button"
                class="board-card"
                onclick={() => nav.openKanban(b.cwd)}
              >
                <div class="bc-top">
                  <span class="bc-name truncate">{b.name}</span>
                  <span class="bc-open mono">{openCount} open</span>
                </div>
                <p class="bc-cwd mono truncate" title={b.cwd}>{b.cwd}</p>
                <div class="bc-counts">
                  {#each KANBAN_COLUMNS as col (col.id)}
                    {@const c = b.counts[col.id] ?? 0}
                    <span class="pill" class:dim={c === 0}>
                      {col.title} <strong class="mono">{c}</strong>
                    </span>
                  {/each}
                  {#if when}
                    <span class="bc-when">{when}</span>
                  {/if}
                </div>
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {:else if kanbanStore.boardLoading && !board}
    <div class="center-state"><Spinner size={18} label="Loading board" /></div>
  {:else if kanbanStore.boardError && !board}
    <div class="center-state">
      <p class="err" role="alert">{kanbanStore.boardError}</p>
      <button type="button" class="btn" onclick={() => void kanbanStore.loadBoard(selectedCwd)}>Retry</button>
    </div>
  {:else if board && !board.exists && board.tickets.length === 0}
    <div class="center-state">
      <p class="empty-title">No kanban board in this project yet.</p>
      <p class="bc-cwd mono">{board.path}</p>
      <button type="button" class="btn btn-primary" disabled={kanbanStore.mutating} onclick={initBoard}>
        Create board
      </button>
    </div>
  {:else if board}
    <div class="toolbar">
      <div class="filter-row">
        <div class="search-wrap">
          <Icon name="search" size={15} />
          <input
            class="search-input"
            type="search"
            aria-label="Filter tickets"
            placeholder="Filter by id, title, details, tag"
            bind:value={search}
          />
          {#if search}
            <button
              type="button"
              class="icon-btn clear-btn"
              aria-label="Clear filter"
              onclick={() => (search = '')}
            >
              <Icon name="x" size={14} />
            </button>
          {/if}
        </div>
      </div>

      {#if tags.length > 0}
        <div class="tag-strip" role="group" aria-label="Filter by tag">
          {#if selectedTag}
            <button type="button" class="tag-pill" onclick={() => (selectedTag = null)}>All</button>
          {/if}
          {#each tags as tag (tag)}
            <button
              type="button"
              class="tag-pill mono"
              class:on={selectedTag === tag}
              aria-pressed={selectedTag === tag}
              onclick={() => (selectedTag = selectedTag === tag ? null : tag)}
            >
              #{tag}
            </button>
          {/each}
        </div>
      {/if}

      {#if kanbanStore.boardError}
        <div class="banner" role="alert">
          <span>{kanbanStore.boardError}</span>
          <button type="button" class="btn btn-sm" onclick={() => void kanbanStore.loadBoard(selectedCwd)}>
            Retry
          </button>
        </div>
      {/if}
    </div>

    {#if viewport.narrow}
      <div class="col-tabs" role="tablist" aria-label="Board columns">
        {#each KANBAN_COLUMNS as col (col.id)}
          <button
            type="button"
            role="tab"
            class="col-tab"
            aria-selected={activeCol === col.id}
            class:on={activeCol === col.id}
            onclick={() => (activeCol = col.id)}
          >
            <span>{col.title}</span>
            <span class="tab-count mono">{countInColumn(board, col.id)}</span>
          </button>
        {/each}
      </div>
      {@const colTickets = hasTicketsIn(board, activeCol)}
      <div class="col-single scroll-y" role="tabpanel">
        {#if colTickets.length === 0}
          <p class="col-empty">No tickets in {KANBAN_COLUMNS.find((c) => c.id === activeCol)?.title}.</p>
        {:else}
          {#each colTickets as t (t.id)}
            {@const unmet = unmetBlockers(t, doneIds)}
            {@const claimed = t.column === 'doing' && isTicketClaimed(t, now)}
            <div
              class="ticket"
              class:blocked={unmet.length > 0}
              class:claimed={claimed && unmet.length === 0}
            >
              <div class="t-row">
                <button type="button" class="t-main" onclick={() => openTicket(t)}>
                  <span class="t-top">
                    <span class="t-id mono">{t.id}</span>
                    <span class="t-prio mono">{formatKanbanPriority(t.priority)}</span>
                    {#if t.notes.length > 0}
                      <span class="t-notes mono" title="{t.notes.length} notes">{t.notes.length}n</span>
                    {/if}
                    <span class="spacer"></span>
                    {#if claimed}
                      <span class="t-claimed">claimed</span>
                    {/if}
                  </span>
                  <span class="t-title">{t.title}</span>
                  {#if t.body}
                    <span class="t-body">{t.body}</span>
                  {/if}
                  {#if t.tags.length > 0 || unmet.length > 0}
                    <span class="t-foot">
                      {#each t.tags as tag (tag)}
                        <span class="t-tag mono">#{tag}</span>
                      {/each}
                      {#if unmet.length > 0}
                        <span class="t-blocked">blocked by {unmet.join(', ')}</span>
                      {/if}
                    </span>
                  {/if}
                </button>
                <button
                  type="button"
                  class="icon-btn t-more"
                  aria-label="Actions for {t.id}"
                  onclick={(e) => {
                    ticketMenuAnchor = e.currentTarget as HTMLElement;
                    ticketMenuTicket = t;
                  }}
                >
                  <Icon name="more" size={16} />
                </button>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="columns">
        {#each KANBAN_COLUMNS as col (col.id)}
          {@const colTickets = hasTicketsIn(board, col.id)}
          <section class="column" aria-label={col.title}>
            <header class="col-head">
              <h2>{col.title}</h2>
              <span class="col-count mono">{countInColumn(board, col.id)}</span>
              <span class="spacer"></span>
              <button
                type="button"
                class="icon-btn col-add"
                aria-label="Add ticket to {col.title}"
                title="Add to {col.title}"
                onclick={() => openNewTicket(col.id)}
              >
                <Icon name="plus" size={15} />
              </button>
            </header>
            <div class="col-list scroll-y">
              {#if colTickets.length === 0}
                <p class="col-empty">No tickets</p>
              {:else}
                {#each colTickets as t (t.id)}
                  {@const unmet = unmetBlockers(t, doneIds)}
                  {@const claimed = t.column === 'doing' && isTicketClaimed(t, now)}
                  <div
                    class="ticket"
                    class:blocked={unmet.length > 0}
                    class:claimed={claimed && unmet.length === 0}
                  >
                    <div class="t-row">
                      <button type="button" class="t-main" onclick={() => openTicket(t)}>
                        <span class="t-top">
                          <span class="t-id mono">{t.id}</span>
                          <span class="t-prio mono">{formatKanbanPriority(t.priority)}</span>
                          {#if t.notes.length > 0}
                            <span class="t-notes mono" title="{t.notes.length} notes">{t.notes.length}n</span>
                          {/if}
                          <span class="spacer"></span>
                          {#if claimed}
                            <span class="t-claimed">claimed</span>
                          {/if}
                        </span>
                        <span class="t-title">{t.title}</span>
                        {#if t.body}
                          <span class="t-body">{t.body}</span>
                        {/if}
                        {#if t.tags.length > 0 || unmet.length > 0}
                          <span class="t-foot">
                            {#each t.tags as tag (tag)}
                              <span class="t-tag mono">#{tag}</span>
                            {/each}
                            {#if unmet.length > 0}
                              <span class="t-blocked">blocked by {unmet.join(', ')}</span>
                            {/if}
                          </span>
                        {/if}
                      </button>
                      <button
                        type="button"
                        class="icon-btn t-more"
                        aria-label="Actions for {t.id}"
                        onclick={(e) => {
                          ticketMenuAnchor = e.currentTarget as HTMLElement;
                          ticketMenuTicket = t;
                        }}
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<KanbanFolderSheet
  open={folderOpen}
  onclose={() => (folderOpen = false)}
  onopen={(cwd) => nav.openKanban(cwd)}
/>

{#if selectedCwd}
  <KanbanTicketSheet
    open={editorOpen}
    cwd={selectedCwd}
    ticket={editingTicket}
    initialColumn={editorCol}
    onclose={() => (editorOpen = false)}
  />
  <KanbanArchiveSheet
    open={archiveOpen}
    cwd={selectedCwd}
    onclose={() => (archiveOpen = false)}
  />
{/if}

<Menu
  open={boardMenuOpen}
  onclose={() => (boardMenuOpen = false)}
  anchor={boardMenuBtn}
  title="Board"
  items={boardMenuItems}
/>

<Menu
  open={ticketMenuTicket !== null}
  onclose={() => (ticketMenuTicket = null)}
  anchor={ticketMenuAnchor}
  title={ticketMenuTicket?.id ?? 'Ticket'}
  items={ticketMenuItems}
/>

<style>
  .kanban {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-width: 0;
    background: var(--canvas);
  }
  .kanban.board-mode {
    grid-template-rows: auto auto minmax(0, 1fr);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: max(var(--safe-t), var(--s-3)) var(--s-4) var(--s-3);
    border-bottom: 1px solid var(--line);
    background: var(--canvas);
    min-width: 0;
  }
  @media (max-width: 899.98px) {
    .head {
      padding: max(var(--safe-t), var(--s-2)) var(--s-3) var(--s-2);
    }
    .toolbar {
      padding: var(--s-2) var(--s-3);
    }
  }
  .titles {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  h1 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--ink);
  }
  .sub,
  .cwd {
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex: none;
  }
  .index-body {
    padding: var(--s-4);
    max-width: var(--wide-w);
    width: 100%;
    margin: 0 auto;
    display: grid;
    gap: var(--s-4);
    align-content: start;
  }
  .board-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--s-3);
  }
  .board-card {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: var(--ring);
    text-align: left;
    transition: background var(--dur-fast) var(--ease);
  }
  .board-card:hover {
    background: color-mix(in srgb, var(--surface) 88%, var(--ink));
  }
  .bc-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-2);
  }
  .bc-name {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--ink);
  }
  .bc-open {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--accent);
    font-weight: 600;
  }
  .bc-cwd {
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .bc-counts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1) var(--s-2);
    margin-top: var(--s-1);
  }
  .pill {
    font-size: var(--fs-xs);
    color: var(--ink-2);
    padding: 2px var(--s-2);
    border-radius: var(--r-sm);
    background: var(--inset);
    box-shadow: var(--ring);
  }
  .pill.dim {
    color: var(--ink-3);
  }
  .bc-when {
    margin-left: auto;
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .empty-card {
    display: grid;
    gap: var(--s-3);
    justify-items: start;
    padding: var(--s-5);
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: var(--ring);
    max-width: 520px;
  }
  .empty-title {
    color: var(--ink);
    font-weight: 500;
  }
  .empty-sub {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .center-state {
    display: grid;
    place-items: center;
    align-content: center;
    gap: var(--s-3);
    padding: var(--s-6) var(--s-4);
    text-align: center;
  }
  .err {
    color: var(--err);
    font-size: var(--fs-sm);
  }
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    background: var(--err-soft);
    color: var(--err);
    font-size: var(--fs-sm);
  }
  .toolbar {
    display: grid;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-4);
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }
  .filter-row {
    display: flex;
    gap: var(--s-2);
    align-items: center;
  }
  .search-wrap {
    flex: 1;
    max-width: 440px;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: var(--hit);
    padding: 0 var(--s-3);
    border-radius: var(--r-md);
    background: var(--field);
    box-shadow: var(--ring);
    color: var(--ink-3);
  }
  .search-wrap:focus-within {
    box-shadow: 0 0 0 1px var(--accent);
  }
  .search-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--ink);
  }
  .search-input:focus-visible {
    outline: none;
  }
  .clear-btn {
    min-width: 24px;
    min-height: 24px;
    width: 24px;
    height: 24px;
  }
  .tag-strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .tag-pill {
    font-size: var(--fs-xs);
    padding: 3px var(--s-2);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--ink-2);
    box-shadow: var(--ring);
  }
  .tag-pill.on {
    background: var(--accent-soft);
    color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(4, minmax(220px, 1fr));
    gap: var(--s-3);
    padding: var(--s-3) var(--s-4) var(--s-4);
    min-height: 0;
    overflow-x: auto;
  }
  .column {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
    border-radius: var(--r-md);
    background: var(--bg);
    box-shadow: var(--ring);
  }
  .col-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line);
  }
  .col-head h2 {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--ink);
  }
  .col-count {
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .col-add {
    min-width: 28px;
    min-height: 28px;
    width: 28px;
    height: 28px;
  }
  .col-list {
    padding: var(--s-2);
    display: grid;
    gap: var(--s-2);
    align-content: start;
  }
  .col-empty {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    padding: var(--s-3) var(--s-2);
  }
  .col-tabs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-bottom: 1px solid var(--line);
    background: var(--bg);
  }
  .col-tab {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-1);
    min-height: var(--hit);
    padding: var(--s-2) var(--s-1);
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--ink-3);
    border-bottom: 2px solid transparent;
  }
  .col-tab.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .tab-count {
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .col-single {
    padding: var(--s-3);
    display: grid;
    gap: var(--s-2);
    align-content: start;
  }
  .kanban.board-mode:has(.col-tabs) {
    grid-template-rows: auto auto auto minmax(0, 1fr);
  }
  .ticket {
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: var(--ring);
    transition: background var(--dur-fast) var(--ease);
  }
  .ticket.claimed {
    box-shadow: 0 0 0 1px var(--ok);
  }
  .ticket.blocked {
    box-shadow: 0 0 0 1px var(--warn);
  }
  .t-row {
    display: flex;
    align-items: flex-start;
  }
  .t-main {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 4px;
    padding: var(--s-2) var(--s-3);
    text-align: left;
  }
  .t-more {
    flex: none;
    margin: var(--s-1) var(--s-1) 0 0;
  }
  .t-top {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .t-id {
    font-weight: 600;
  }
  .t-claimed {
    color: var(--ok);
    font-weight: 600;
  }
  .t-title {
    color: var(--ink);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .t-body {
    color: var(--ink-2);
    font-size: var(--fs-sm);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .t-foot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-2);
    margin-top: 2px;
    font-size: var(--fs-xs);
  }
  .t-tag {
    color: var(--accent);
  }
  .t-blocked {
    color: var(--warn);
  }
  .spacer {
    flex: 1;
  }
</style>
