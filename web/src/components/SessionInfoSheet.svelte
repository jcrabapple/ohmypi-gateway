<script lang="ts">
  // Everything about the open session in one place: where it runs, what it costs, how it queues.
  import { onMount } from 'svelte';
  import { sessions as api } from '../lib/api/endpoints';
  import { approvalLabel } from '../lib/composer/modes';
  import { compactNumber, money, sessionTitle, uptime } from '../lib/format';
  import type { OverlayProps } from '../lib/overlays';
  import { copyText } from '../lib/platform/clipboard';
  import { active, sessionsStore } from '../lib/state';
  import { Loader } from '../lib/state/loader.svelte';
  import { Icon, Sheet, toast } from '../lib/ui';
  import ContextMeter from './ContextMeter.svelte';

  let { onclose }: OverlayProps = $props();

  const queue = new Loader<Awaited<ReturnType<typeof api.state>>>();
  const info = $derived(active.info);
  const stats = $derived(active.stats);

  onMount(() => {
    void active.refreshInfo();
    void active.refreshStats();
    load();
  });

  function load() {
    if (active.gwId) void queue.run(() => api.state(active.gwId!));
  }

  async function copy(label: string, text: string) {
    toast((await copyText(text)) ? `${label} copied` : `Could not copy ${label.toLowerCase()}`);
  }

  const tokenRows = $derived(
    stats
      ? [
          ['Input', stats.tokens.input],
          ['Output', stats.tokens.output],
          ['Reasoning', stats.tokens.reasoning],
          ['Cache read', stats.tokens.cacheRead],
          ['Cache write', stats.tokens.cacheWrite],
        ].filter(([, n]) => (n as number) > 0)
      : [],
  );
  const usage = $derived(stats?.contextUsage ?? info?.contextUsage ?? null);
  const model = $derived(info?.model?.name ?? info?.model?.id ?? 'Not set');
</script>

<Sheet open {onclose} title="Session info" size="md">
  {#if !info}
    <p class="none">No session is open.</p>
  {:else}
    <div class="stack">
      <section aria-labelledby="si-where">
        <h3 id="si-where" class="eyebrow">Where</h3>
        <dl>
          <dt>Name</dt>
          <dd>{sessionTitle(info, sessionsStore.saved)}</dd>
          <dt>Folder</dt>
          <dd class="mono path">
            {info.cwd}
            <button type="button" class="icon-btn" aria-label="Copy folder" onclick={() => copy('Folder', info.cwd)}><Icon name="copy" size={15} /></button>
          </dd>
          {#if info.ompSessionFile}
            <dt>Session file</dt>
            <dd class="mono path">
              {info.ompSessionFile}
              <button type="button" class="icon-btn" aria-label="Copy session file path" onclick={() => copy('Path', info.ompSessionFile!)}><Icon name="copy" size={15} /></button>
            </dd>
          {/if}
          <dt>Running for</dt>
          <dd>{uptime(info.uptimeSec) || 'Just started'}</dd>
        </dl>
      </section>

      <section aria-labelledby="si-model">
        <h3 id="si-model" class="eyebrow">Model</h3>
        <dl>
          <dt>Model</dt>
          <dd>{model}{#if info.model?.provider}<span class="dim"> · {info.model.provider}</span>{/if}</dd>
          <dt>Thinking</dt>
          <dd>{info.thinkingLevel ?? 'Off'}</dd>
          <dt>Approval</dt>
          <dd>{approvalLabel(info.approvalMode)}</dd>
          <dt>Context</dt>
          <dd>
            {#if usage}
              <ContextMeter percent={usage.percent} tokens={usage.tokens} window={usage.contextWindow} />
              <span class="dim ctx">
                {usage.tokens != null ? `${compactNumber(usage.tokens)} of ` : ''}{compactNumber(usage.contextWindow)} tokens
              </span>
            {:else}
              Not reported yet
            {/if}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="si-use">
        <h3 id="si-use" class="eyebrow">Usage</h3>
        {#if stats}
          <dl>
            <dt>Cost</dt>
            <dd>{money(stats.cost)}</dd>
            <dt>Messages</dt>
            <dd>{stats.totalMessages} <span class="dim">({stats.userMessages} yours, {stats.assistantMessages} replies, {stats.toolCalls} tool calls)</span></dd>
            <dt>Tokens</dt>
            <dd>{compactNumber(stats.tokens.total)}</dd>
            {#each tokenRows as [label, n] (label)}
              <dt class="sub">{label}</dt>
              <dd class="sub">{compactNumber(n as number)}</dd>
            {/each}
          </dl>
        {:else}
          <dl>
            <dt>Messages</dt>
            <dd>{info.messageCount}</dd>
          </dl>
          <div class="sk" aria-hidden="true"><span class="skeleton"></span><span class="skeleton"></span></div>
        {/if}
      </section>

      <section aria-labelledby="si-queue">
        <h3 id="si-queue" class="eyebrow">Queue and protocol</h3>
        {#if queue.data}
          <dl>
            <dt>Steering</dt>
            <dd>{queue.data.steeringMode}</dd>
            <dt>Follow-ups</dt>
            <dd>{queue.data.followUpMode}</dd>
            <dt>Interrupts</dt>
            <dd>{queue.data.interruptMode}</dd>
            <dt>Waiting</dt>
            <dd>{queue.data.queuedMessageCount} queued</dd>
            <dt>Protocol</dt>
            <dd>{info.protocolVersion ?? 'Unknown'}</dd>
          </dl>
        {:else if queue.error}
          <p class="err" role="alert">{queue.error} <button type="button" class="btn btn-sm" onclick={load}>Try again</button></p>
        {:else}
          <div class="sk" aria-hidden="true"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>
        {/if}
      </section>
    </div>
  {/if}
</Sheet>

<style>
  .stack {
    display: grid;
    gap: var(--s-5);
  }
  dl {
    display: grid;
    grid-template-columns: minmax(0, 116px) minmax(0, 1fr);
    gap: var(--s-2) var(--s-4);
    margin: var(--s-2) 0 0;
    align-items: baseline;
  }
  dt {
    color: var(--ink-3);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .sub {
    font-size: var(--fs-sm);
  }
  dt.sub {
    padding-left: var(--s-3);
  }
  .path {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-2);
    font-size: var(--fs-sm);
  }
  .path .icon-btn {
    flex: none;
    margin: -6px 0;
  }
  .dim {
    color: var(--ink-3);
  }
  .ctx {
    margin-left: var(--s-2);
  }
  .none {
    color: var(--ink-3);
  }
  .sk {
    display: grid;
    gap: var(--s-2);
    margin-top: var(--s-2);
  }
  .sk .skeleton {
    height: 14px;
    width: 60%;
  }
  .err {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-3);
    color: var(--err);
  }
  @media (max-width: 480px) {
    dl {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
    dd {
      margin-bottom: var(--s-3);
    }
    dt.sub {
      padding-left: 0;
    }
  }
</style>
