<script lang="ts">
  import { registerComposer } from '../lib/composer/bridge';
  import { active, nav, plan, settings } from '../lib/state';
  import { Sheet } from '../lib/ui';
  import { viewport } from '../lib/ui/media.svelte';
  import ApprovalPanel from './ApprovalPanel.svelte';
  import ChangesView from './ChangesView.svelte';
  import Composer from './Composer.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import PlanRibbon from './PlanRibbon.svelte';
  import SessionHeader from './SessionHeader.svelte';
  import Transcript from './Transcript.svelte';

  let { gwId }: { gwId: string } = $props();

  let composer: ReturnType<typeof Composer> | undefined = $state();

  $effect(() => {
    registerComposer(composer ?? null);
    return () => registerComposer(null);
  });

  const request = $derived(active.pendingUi[0] ?? null);
  const changes = $derived(nav.view === 'changes');
  // The desktop panel sits beside the transcript; on narrow screens the plan is a sheet instead.
  const panelOpen = $derived(settings.planPanelOpen && !viewport.narrow);
</script>

<div class="view">
  <SessionHeader />
  {#if changes}
    <ChangesView {gwId} items={active.transcript.items} />
  {:else}
    <div class="body">
      <div class="main">
        <Transcript onstarter={(text) => composer?.setText(text)}>
          {#snippet lead()}
            <PlanRibbon />
          {/snippet}
        </Transcript>
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
      {#if panelOpen}
        <aside class="plan" id="plan-panel">
          {#key gwId}
            <PlanPanel />
          {/key}
        </aside>
      {/if}
    </div>
  {/if}
</div>

{#if viewport.narrow}
  <Sheet open={plan.sheet} onclose={() => (plan.sheet = false)} title="Plan" size="md" fillNarrow flush>
    <div class="plan-sheet" id="plan-panel">
      {#key gwId}
        <PlanPanel />
      {/key}
    </div>
  </Sheet>
{/if}

<style>
  .view {
    display: grid;
    /* Same reason as .main below: the implicit auto column would size to the header's
       min-content and push everything wide. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-width: 0;
    background: var(--canvas);
  }
  .body {
    display: flex;
    min-height: 0;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: grid;
    /* minmax(0, 1fr): without an explicit column track the implicit auto column sizes to the
       transcript's min-content width and pushes the 300px plan panel off screen. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .plan {
    flex: none;
    width: 300px;
    border-left: 1px solid var(--line);
    background: var(--bg);
  }
  .plan-sheet {
    height: 100%;
    min-height: 0;
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
