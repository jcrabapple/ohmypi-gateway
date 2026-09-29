<script lang="ts">
  import { active } from '../lib/state';
  import ApprovalPanel from './ApprovalPanel.svelte';
  import Composer from './Composer.svelte';
  import SessionHeader from './SessionHeader.svelte';
  import Transcript from './Transcript.svelte';

  let { gwId }: { gwId: string } = $props();

  let composer: ReturnType<typeof Composer> | undefined = $state();

  const request = $derived(active.pendingUi[0] ?? null);
</script>

<div class="view">
  <SessionHeader />
  <Transcript onstarter={(text) => composer?.setText(text)} />
  <div class="dock">
    {#if request}
      <div class="approval">
        <ApprovalPanel {request} index={1} total={active.pendingUi.length} />
      </div>
    {/if}
    <div class="composer" class:hidden={!!request} inert={!!request}>
      {#key gwId}
        <Composer bind:this={composer} {gwId} />
      {/key}
    </div>
  </div>
</div>

<style>
  .view {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
    min-width: 0;
    background: var(--canvas);
  }
  .dock {
    min-width: 0;
  }
  .approval {
    width: min(100%, var(--reading-w));
    margin: 0 auto;
    padding: var(--s-2) var(--s-3) max(var(--kb), var(--safe-b));
  }
  .composer.hidden {
    display: none;
  }
</style>
