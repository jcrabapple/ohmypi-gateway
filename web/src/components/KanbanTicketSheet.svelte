<script lang="ts">
  // Ticket editor / detail sheet for KanbanView.
  import { ApiError } from '../lib/api/client';
  import type { KanbanColumnId, KanbanTicket } from '../lib/api/types';
  import { relativeTime } from '../lib/format';
  import {
    KANBAN_COLUMNS, isTicketClaimed, kanbanStore, splitCsvList,
  } from '../lib/state/kanban.svelte';
  import { confirm, Icon, Segmented, Sheet, Spinner, toast } from '../lib/ui';

  type Props = {
    open: boolean;
    cwd: string;
    ticket: KanbanTicket | null;
    initialColumn: KanbanColumnId;
    onclose: () => void;
  };

  let { open, cwd, ticket, initialColumn, onclose }: Props = $props();

  let title = $state('');
  let body = $state('');
  let column = $state<KanbanColumnId>('todo');
  let priority = $state('100');
  let tags = $state('');
  let blockedBy = $state('');
  let noteText = $state('');
  let saving = $state(false);
  let error = $state<string | null>(null);
  const uid = $props.id();

  // Re-read the ticket from live board state so adding a note refreshes the list in place.
  const liveTicket = $derived.by(() => {
    if (!ticket) return null;
    const found = kanbanStore.board?.tickets.find((t) => t.id === ticket.id);
    return found ?? ticket;
  });

  const isNew = $derived(!ticket);
  const claimed = $derived(liveTicket ? isTicketClaimed(liveTicket) : false);

  $effect(() => {
    if (!open) return;
    title = ticket?.title ?? '';
    body = ticket?.body ?? '';
    column = ticket?.column ?? initialColumn;
    priority = ticket ? String(ticket.priority) : '100';
    tags = ticket?.tags.join(', ') ?? '';
    blockedBy = ticket?.blocked_by.join(', ') ?? '';
    noteText = '';
    error = null;
    saving = false;
  });

  const COL_OPTIONS = KANBAN_COLUMNS.map((c) => ({ id: c.id, label: c.title }));

  function errMsg(e: unknown, fallback: string): string {
    return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
  }

  async function save(e?: SubmitEvent) {
    e?.preventDefault();
    if (saving) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      error = 'Title is required.';
      return;
    }
    const prioRaw = priority.trim();
    const prio = prioRaw === '' ? 100 : Number(prioRaw);
    if (!Number.isFinite(prio)) {
      error = 'Priority must be a finite number.';
      return;
    }
    saving = true;
    error = null;
    const tagList = splitCsvList(tags, { stripHash: true });
    const blockerList = splitCsvList(blockedBy, { upper: true });
    try {
      if (isNew) {
        await kanbanStore.addTicket({
          cwd,
          title: cleanTitle,
          body: body.trim(),
          column,
          priority: prio,
          tags: tagList,
          blocked_by: blockerList,
        });
        toast('Ticket created');
      } else {
        await kanbanStore.updateTicket({
          cwd,
          id: ticket!.id,
          title: cleanTitle,
          body,
          priority: prio,
          tags: tagList,
          blocked_by: blockerList,
          column,
        });
        toast(`Saved ${ticket!.id}`);
      }
      onclose();
    } catch (err) {
      error = errMsg(err, 'Could not save ticket.');
    } finally {
      saving = false;
    }
  }

  async function addNote() {
    if (!liveTicket || saving) return;
    const text = noteText.trim();
    if (!text) return;
    saving = true;
    error = null;
    try {
      await kanbanStore.addNote(cwd, liveTicket.id, text);
      noteText = '';
    } catch (err) {
      error = errMsg(err, 'Could not add note.');
    } finally {
      saving = false;
    }
  }

  async function toggleClaim() {
    if (!liveTicket || saving) return;
    saving = true;
    error = null;
    try {
      if (claimed) {
        await kanbanStore.releaseTicket(cwd, liveTicket.id);
        toast(`Released ${liveTicket.id}`);
      } else {
        await kanbanStore.claimTicket(cwd, liveTicket.id);
        toast(`Claimed ${liveTicket.id} to Doing`);
      }
      onclose();
    } catch (err) {
      error = errMsg(err, 'Could not update claim.');
    } finally {
      saving = false;
    }
  }

  async function removeTicket() {
    if (!liveTicket || saving) return;
    const ok = await confirm({
      title: `Delete ${liveTicket.id}?`,
      body: `Remove "${liveTicket.title}" from the board?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    saving = true;
    error = null;
    try {
      await kanbanStore.deleteTicket(cwd, liveTicket.id);
      toast(`Deleted ${liveTicket.id}`);
      onclose();
    } catch (err) {
      error = errMsg(err, 'Could not delete ticket.');
    } finally {
      saving = false;
    }
  }

  function noteStamp(iso: string): string {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? relativeTime(ms) : iso;
  }
</script>

<Sheet {open} {onclose} title={liveTicket ? liveTicket.id : 'New ticket'} size="md">
  <form id="{uid}-form" class="form" onsubmit={save}>
    {#if liveTicket}
      <div class="claim-bar">
        {#if claimed}
          <span class="claim-status">Claimed by {liveTicket.claimed_by ?? 'session'}</span>
        {:else}
          <span class="claim-none">Unclaimed</span>
        {/if}
        <button type="button" class="btn btn-sm" disabled={saving} onclick={toggleClaim}>
          {claimed ? 'Release' : 'Claim to Doing'}
        </button>
      </div>
    {/if}

    <div class="group">
      <label class="lbl" for="{uid}-title">Title</label>
      <input
        id="{uid}-title"
        class="field"
        type="text"
        placeholder="Short imperative title"
        bind:value={title}
        disabled={saving}
      />
    </div>

    <div class="group">
      <span class="lbl">Column</span>
      <Segmented label="Column" value={column} options={COL_OPTIONS} onchange={(v) => (column = v)} />
    </div>

    <div class="group">
      <label class="lbl" for="{uid}-body">Details</label>
      <textarea
        id="{uid}-body"
        class="field area"
        rows={4}
        placeholder="Acceptance criteria, file hints, verification"
        bind:value={body}
        disabled={saving}
      ></textarea>
    </div>

    <div class="split">
      <div class="group prio">
        <label class="lbl" for="{uid}-prio">Priority</label>
        <input
          id="{uid}-prio"
          class="field mono"
          type="number"
          step="any"
          bind:value={priority}
          disabled={saving}
        />
      </div>
      <div class="group grow">
        <label class="lbl" for="{uid}-tags">Tags</label>
        <input
          id="{uid}-tags"
          class="field"
          type="text"
          placeholder="ui, bug"
          bind:value={tags}
          disabled={saving}
        />
      </div>
    </div>

    <div class="group">
      <label class="lbl" for="{uid}-blocked">Blocked by</label>
      <input
        id="{uid}-blocked"
        class="field mono"
        type="text"
        placeholder="K-1, K-2"
        bind:value={blockedBy}
        disabled={saving}
      />
    </div>

    {#if liveTicket}
      <div class="group">
        <span class="lbl">Notes ({liveTicket.notes.length})</span>
        {#if liveTicket.notes.length === 0}
          <p class="notes-empty">No notes yet.</p>
        {:else}
          <ul class="notes">
            {#each liveTicket.notes as n, idx (idx)}
              <li>
                <span class="note-at mono">{noteStamp(n.at)}</span>
                <span class="note-text">{n.text}</span>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="note-add">
          <input
            class="field"
            type="text"
            aria-label="Add a note"
            placeholder="Add a note"
            bind:value={noteText}
            disabled={saving}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addNote();
              }
            }}
          />
          <button type="button" class="btn btn-sm" disabled={saving || !noteText.trim()} onclick={addNote}>
            Add
          </button>
        </div>
      </div>
    {/if}

    {#if error}
      <p class="err" role="alert">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    {#if !isNew}
      <button type="button" class="btn btn-ghost btn-danger" disabled={saving} onclick={removeTicket}>
        Delete
      </button>
      <span class="spacer"></span>
    {/if}
    <button type="button" class="btn btn-ghost" disabled={saving} onclick={onclose}>Cancel</button>
    <button type="submit" form="{uid}-form" class="btn btn-primary" disabled={saving}>
      {#if saving}
        <Spinner size={14} label="Saving" />
      {:else}
        <Icon name="check" size={14} />
      {/if}
      {isNew ? 'Create' : 'Save'}
    </button>
  {/snippet}
</Sheet>

<style>
  .form {
    display: grid;
    gap: var(--s-3);
  }
  .claim-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    background: var(--inset);
    box-shadow: var(--ring);
    font-size: var(--fs-sm);
  }
  .claim-status {
    color: var(--ok);
    font-weight: 500;
  }
  .claim-none {
    color: var(--ink-3);
  }
  .group {
    display: grid;
    gap: var(--s-1);
    min-width: 0;
  }
  .lbl {
    font-size: var(--fs-sm);
    color: var(--ink-2);
    font-weight: 500;
  }
  .area {
    min-height: 88px;
    padding: var(--s-2) var(--s-3);
    resize: vertical;
    line-height: var(--lh);
  }
  .split {
    display: flex;
    gap: var(--s-2);
    align-items: start;
  }
  .prio {
    width: 108px;
    flex: none;
  }
  .grow {
    flex: 1;
  }
  .notes-empty {
    font-size: var(--fs-sm);
    color: var(--ink-3);
  }
  .notes {
    list-style: none;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-md);
    background: var(--inset);
    box-shadow: var(--ring);
    display: grid;
    gap: var(--s-1);
    max-height: 180px;
    overflow-y: auto;
  }
  .notes li {
    display: flex;
    gap: var(--s-2);
    font-size: var(--fs-sm);
    align-items: baseline;
  }
  .note-at {
    flex: none;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .note-text {
    color: var(--ink-2);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .note-add {
    display: flex;
    gap: var(--s-2);
    align-items: center;
  }
  .note-add .field {
    flex: 1;
    min-width: 0;
  }
  .err {
    color: var(--err);
    font-size: var(--fs-sm);
  }
  .spacer {
    flex: 1;
  }
</style>
