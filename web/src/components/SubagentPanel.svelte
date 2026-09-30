<script lang="ts">
  // Roster pane for the right panel: one row per subagent, click for its transcript.
  // Data is the subagents store (live frames + registry seed); the sheet reads the
  // messages route incrementally via nextByte.
  import { sessions as api } from '../lib/api/endpoints';
  import { active, subagents } from '../lib/state';
  import type { SubagentRow } from '../lib/state/subagents.svelte';
  import { compactNumber, firstLine, money } from '../lib/format';
  import { emptyTranscript, reduce } from '../lib/transcript/reducer';
  import { toBlocks } from '../lib/transcript/blocks';
  import type { OmpMessage } from '../lib/api/types';
  import { Icon, Sheet, Spinner } from '../lib/ui';
  import AssistantMessage from './items/AssistantMessage.svelte';
  import CommandCard from './items/CommandCard.svelte';
  import NoticeLine from './items/NoticeLine.svelte';
  import SkillChip from './items/SkillChip.svelte';
  import ThinkingRow from './items/ThinkingRow.svelte';
  import ToolGroup from './items/ToolGroup.svelte';
  import UserBubble from './items/UserBubble.svelte';

  const STATUS_WORD: Record<string, string> = {
    pending: 'Pending',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    aborted: 'Aborted',
  };

  /** The one line shown under the agent name, with its full text for the title. */
  function describe(row: SubagentRow): { short: string; full: string } {
    const text = row.description || row.task || row.assignment;
    return { short: firstLine(text), full: text };
  }

  function label(row: SubagentRow): string {
    const bits = [STATUS_WORD[row.status]];
    if (row.currentTool) bits.push(row.currentTool);
    return `${row.agent || 'Helper'}: ${bits.join(', ')}`;
  }

  interface SheetState {
    key: string;
    agent: string;
    messages: OmpMessage[];
    nextByte: number | null;
    loading: boolean;
    loadingMore: boolean;
    error: string | null;
  }

  let sheet = $state<SheetState | null>(null);
  // Reactive through the store's rows, so a live update re-renders the sheet header.
  const openRow = $derived(sheet ? subagents.rows.find((r) => r.key === sheet!.key) ?? null : null);
  const sheetBlocks = $derived(
    sheet ? toBlocks(reduce(emptyTranscript(), { kind: 'history', messages: sheet.messages }).items) : [],
  );

  function open(row: SubagentRow): void {
    sheet = {
      key: row.key,
      agent: row.agent || 'Helper',
      messages: [],
      nextByte: null,
      loading: Boolean(row.id),
      loadingMore: false,
      error: null,
    };
    if (row.id) void load(row.key, row.id);
  }

  function close(): void {
    sheet = null;
  }

  async function load(key: string, subId: string): Promise<void> {
    const gwId = active.gwId;
    if (!gwId || !sheet || sheet.key !== key || !subId) return;
    const from = sheet.messages.length ? sheet.nextByte ?? undefined : undefined;
    if (sheet.messages.length) sheet = { ...sheet, loadingMore: true };
    try {
      const r = await api.subagents.messages(gwId, subId, from);
      if (!sheet || sheet.key !== key) return;
      // Terminate if nextByte does not advance beyond the current offset.
      const nextByte = r.nextByte != null && (from === undefined || r.nextByte > from) ? r.nextByte : null;
      sheet = {
        ...sheet,
        messages: r.reset ? r.messages : [...sheet.messages, ...r.messages],
        nextByte,
        loading: false,
        loadingMore: false,
        error: null,
      };
    } catch (e) {
      if (!sheet || sheet.key !== key) return;
      sheet = {
        ...sheet,
        loading: false,
        loadingMore: false,
        error: e instanceof Error ? e.message : 'Could not load the transcript',
      };
    }
  }
</script>

<div class="pane" role="tabpanel" id="plan-pane-agents" aria-labelledby="plan-tab-agents">
  {#if subagents.rows.length === 0}
    <p class="empty">No helpers in this session.</p>
  {:else}
    <ul class="agents">
      {#each subagents.rows as row (row.key)}
        {@const d = describe(row)}
        <li class="st-{row.status}">
          <button type="button" class="row hit" aria-label={label(row)} onclick={() => open(row)}>
            <span class="glyph" aria-hidden="true">
              {#if row.status === 'running'}
                <Spinner size={13} />
              {:else if row.status === 'completed'}
                <Icon name="check" size={14} />
              {:else if row.status === 'failed'}
                <Icon name="x" size={14} />
              {:else}
                <span class="dash"></span>
              {/if}
            </span>
            <span class="body">
              <span class="line1">
                <span class="agent truncate" title={row.agent || 'Helper'}>{row.agent || 'Helper'}</span>{#if row.id && row.id !== row.agent}<span class="mono subid truncate" title={row.id}>{row.id}</span>{/if}
                {#if row.status === 'running' && row.currentTool}
                  <span class="tool mono truncate">{row.currentTool}</span>
                {/if}
                {#if row.retry && row.status !== 'completed'}
                  <span class="retry mono" title="Retrying">attempt {row.retry.attempt}/{row.retry.maxAttempts}</span>
                {/if}
              </span>
              <span class="line2">
                <span class="desc truncate" title={d.full}>{d.short || 'No task text'}</span>
                <span class="meta mono">
                  {#if row.tokens != null}<span>{compactNumber(row.tokens)} tok</span>{/if}
                  {#if row.cost != null}<span>{money(row.cost)}</span>{/if}
                  {#if row.model}<span class="model truncate">{row.model}</span>{/if}
                </span>
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if sheet}
  <Sheet open onclose={close} title={openRow?.agent || sheet.agent} size="lg" fixedHeight>
    <div class="transcript" aria-live="polite">
      {#if sheet.loading}
        <p class="note"><Spinner size={13} />fetching transcript</p>
      {:else if sheet.error}
        <p class="note err" role="status"><Icon name="alert" size={13} /> {sheet.error}</p>
      {:else if sheet.messages.length === 0}
        <p class="empty">{openRow?.id ? 'No messages yet' : 'Waiting for the helper to start.'}</p>
      {:else}
        {#each sheetBlocks as b (b.key)}
          <div class="block">
            {#if b.kind === 'tools'}
              <ToolGroup tools={b.tools} />
            {:else if b.item.kind === 'user'}
              <UserBubble item={b.item} />
            {:else if b.item.kind === 'assistant'}
              <AssistantMessage item={b.item} />
            {:else if b.item.kind === 'thinking'}
              <ThinkingRow item={b.item} />
            {:else if b.item.kind === 'skill'}
              <SkillChip item={b.item} />
            {:else if b.item.kind === 'command'}
              <CommandCard item={b.item} />
            {:else if b.item.kind === 'notice'}
              <NoticeLine item={b.item} />
            {/if}
          </div>
        {/each}
        {#if sheet.nextByte != null}
          <p class="more">
            <button
              type="button"
              class="btn"
              disabled={sheet.loadingMore}
              onclick={() => {
                if (sheet && openRow?.id) void load(sheet.key, openRow.id);
              }}
            >
              {#if sheet.loadingMore}<Spinner size={12} />{/if}
              Load more
            </button>
          </p>
        {/if}
      {/if}
    </div>
  </Sheet>
{/if}

<style>
  .pane {
    height: 100%;
    overflow-y: auto;
    padding: var(--s-2) var(--s-3);
  }
  .empty {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    padding: var(--s-2) 0;
  }
  .agents {
    list-style: none;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    text-align: start;
    padding: var(--s-2) var(--s-2);
    border-radius: var(--r-md);
    min-height: 44px;
  }
  .row:hover {
    background: var(--hover);
  }
  .glyph {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    color: var(--ink-3);
  }
  li.st-completed .glyph {
    color: var(--ok);
  }
  li.st-failed .glyph {
    color: var(--err);
  }
  .dash {
    display: block;
    width: 10px;
    height: 2px;
    border-radius: 1px;
    background: currentColor;
  }
  .body {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line1 {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    min-width: 0;
  }
  .agent {
    font-weight: 500;
    flex: none;
    max-width: 60%;
  }
  .tool {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    min-width: 0;
  }
  .retry {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--warn);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    padding: 0 var(--s-1);
  }
  .subid {
    color: var(--ink-3);
    font-size: var(--fs-xs);
    max-width: 10ch;
  }
  .line2 {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    min-width: 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .desc {
    min-width: 0;
    flex: 1;
  }
  .meta {
    flex: none;
    display: inline-flex;
    gap: var(--s-2);
    font-size: var(--fs-xs);
    max-width: 45%;
    /* Metrics stay on one line; the description truncates instead. */
    white-space: nowrap;
    overflow: hidden;
  }
  .model {
    max-width: 14ch;
  }
  .transcript {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .note {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .note.err {
    color: var(--err);
  }
  .more {
    display: flex;
    justify-content: center;
    gap: var(--s-1);
  }
</style>
