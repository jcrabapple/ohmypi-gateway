<script lang="ts">
  import type { TodoTask } from '../lib/api/types';
  import type { ToolItem } from '../lib/transcript/types';
  import { active, plan, subagents } from '../lib/state';
  import { Icon, Spinner } from '../lib/ui';
  import SubagentPanel from './SubagentPanel.svelte';

  type Tab = 'plan' | 'activity' | 'agents';

  let tab = $state<Tab>('plan');
  // Disabled tabs must not own the pane: no plan falls back to activity, and a roster
  // that just emptied (session switch) falls back too.
  const shown = $derived(
    tab === 'plan' && !plan.hasPlan ? 'activity'
      : tab === 'agents' && !subagents.hasAny ? 'activity'
      : tab,
  );
  const running = $derived(
    active.transcript.items.filter((i): i is ToolItem => i.kind === 'tool' && i.status === 'running'),
  );

  // Blocked rows are the only interactive affordance: click toggles the blocker text.
  let expanded = $state<Set<string>>(new Set());

  // Task ids are optional in the wire capture, so the fallback key is positional.
  function taskKey(phaseIndex: number, taskIndex: number, t: TodoTask): string {
    return t.id ?? `p${phaseIndex}-t${taskIndex}`;
  }

  function toggleBlocker(k: string): void {
    const next = new Set(expanded);
    if (!next.delete(k)) next.add(k);
    expanded = next;
  }
</script>

<div class="panel">
  <div class="tabs" role="tablist" aria-label="Session panels">
    <button
      type="button"
      role="tab"
      id="plan-tab-plan"
      aria-controls="plan-pane-plan"
      aria-selected={shown === 'plan'}
      aria-disabled={!plan.hasPlan}
      tabindex={shown === 'plan' ? 0 : -1}
      disabled={!plan.hasPlan}
      onclick={() => (tab = 'plan')}
    >
      Plan <span class="mono frac">{plan.done}/{plan.total}</span>
    </button>
    <button
      type="button"
      role="tab"
      id="plan-tab-activity"
      aria-controls="plan-pane-activity"
      aria-selected={shown === 'activity'}
      tabindex={shown === 'activity' ? 0 : -1}
      onclick={() => (tab = 'activity')}
    >
      Activity
    </button>
    <button
      type="button"
      role="tab"
      id="plan-tab-agents"
      aria-controls="plan-pane-agents"
      aria-selected={shown === 'agents'}
      aria-disabled={!subagents.hasAny}
      tabindex={shown === 'agents' ? 0 : -1}
      disabled={!subagents.hasAny}
      onclick={() => (tab = 'agents')}
    >
      Helpers <span class="mono frac">{subagents.total}</span>
    </button>
  </div>

  {#if shown === 'plan'}
    <div class="pane" role="tabpanel" id="plan-pane-plan" aria-labelledby="plan-tab-plan">
      <p class="progress mono">{plan.done} of {plan.total} complete</p>
      <div
        class="bar"
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={plan.total}
        aria-valuenow={plan.done}
      >
        <div class="fill" style:width="{plan.total ? Math.round((plan.done / plan.total) * 100) : 0}%"></div>
      </div>

      {#each plan.phases as phase, pi (phase.id ?? `p${pi}`)}
        <section class="phase" aria-label={phase.name ?? 'Tasks'}>
          <h3 class="eyebrow">{phase.name ?? 'Tasks'}</h3>
          <ul>
            {#each phase.tasks as t, ti (taskKey(pi, ti, t))}
              {@const k = taskKey(pi, ti, t)}
              {@const blocked = t.status === 'blocked'}
              <li class="task st-{t.status}">
                {#if blocked && t.blocker}
                  <button
                    type="button"
                    class="row hit"
                    aria-expanded={expanded.has(k)}
                    onclick={() => toggleBlocker(k)}
                  >
                    <span class="ring" aria-hidden="true"></span>
                    <span class="content truncate">{t.content}</span>
                    <span class="tag">Blocked</span>
                  </button>
                  {#if expanded.has(k)}
                    <p class="blocker">{t.blocker}</p>
                  {/if}
                {:else if blocked}
                  <!-- No blocker string: nothing to expand, so this row is static. -->
                  <span class="row static">
                    <span class="ring" aria-hidden="true"></span>
                    <span class="content truncate">{t.content}</span>
                    <span class="tag">Blocked</span>
                  </span>
                {:else}
                  <span class="row static">
                    {#if t.status === 'completed'}
                      <Icon name="check" size={14} />
                    {:else if t.status === 'in_progress'}
                      <Icon name="target" size={14} />
                    {:else}
                      <span class="ring" aria-hidden="true"></span>
                    {/if}
                    <span class="content truncate">{t.content}</span>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {:else if shown === 'agents'}
    <SubagentPanel />
  {:else}
    <div class="pane" role="tabpanel" id="plan-pane-activity" aria-labelledby="plan-tab-activity">
      {#if running.length === 0}
        <p class="empty">No tools running</p>
      {:else}
        <ul class="tools">
          {#each running as t (t.toolCallId)}
            <li>
              <Spinner />
              <span class="name mono">{t.toolName}</span>
              <span class="sum truncate">{t.summary}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .tabs {
    display: flex;
    gap: var(--s-1);
    padding: var(--s-2) var(--s-3) 0;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    padding: 0 var(--s-3);
    min-height: 36px;
    border-radius: var(--r-md) var(--r-md) 0 0;
    color: var(--ink-3);
    font-weight: 500;
    border-bottom: 2px solid transparent;
  }
  .tabs button:hover:not(:disabled):not([aria-selected='true']) {
    background: var(--hover);
    color: var(--ink);
  }
  .tabs button[aria-selected='true'] {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .tabs button:disabled {
    opacity: 0.45;
  }
  .frac {
    font-size: var(--fs-xs);
    color: var(--ink-3);
    margin-left: 2px;
  }
  .pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--s-3);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .progress {
    font-size: var(--fs-sm);
    color: var(--ink-2);
  }
  .bar {
    height: 4px;
    border-radius: 999px;
    background: var(--inset);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
    transition: width var(--dur) var(--ease);
  }
  .phase ul {
    display: grid;
    /* Track must be shrinkable or long task names size rows to max-content and overflow the panel. */
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .task {
    border-radius: var(--r-md);
  }
  .task.st-in_progress {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    min-height: 32px;
    padding: var(--s-2);
    text-align: left;
    color: var(--ink-2);
    line-height: 1.35;
  }
  button.row:hover {
    background: var(--hover);
  }
  button.row[aria-expanded='true'] {
    background: var(--press);
  }
  .task :global(svg) {
    flex: none;
    color: var(--ok);
  }
  .st-in_progress :global(svg) {
    color: var(--accent);
  }
  .ring {
    flex: none;
    width: 12px;
    height: 12px;
    margin: 0 1px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--ink-3);
  }
  .st-completed .content {
    color: var(--ink-3);
    text-decoration: line-through;
  }
  .st-in_progress .content {
    color: var(--ink);
  }
  .tag {
    flex: none;
    padding: 1px var(--s-2);
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: var(--fs-xs);
    font-weight: 600;
  }
  .blocker {
    margin: 0 var(--s-2) var(--s-1) 34px;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .empty {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .tools {
    display: grid;
    gap: var(--s-2);
  }
  .tools li {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
    color: var(--ink-2);
    font-size: var(--fs-sm);
  }
  .name {
    flex: none;
    color: var(--ink);
  }
  .sum {
    color: var(--ink-3);
  }
</style>
