<script lang="ts">
  import type { CatalogModel, ThinkingLevel } from '../lib/api/types';
  import { APPROVAL_MODES, approvalLabel, thinkingChoices } from '../lib/composer/modes';
  import { active, ui } from '../lib/state';
  import { Adaptive, Icon, Menu, type MenuItem } from '../lib/ui';
  import ModelPicker from './ModelPicker.svelte';

  const info = $derived(active.info);
  const model = $derived(info?.model ?? null);
  const levels = $derived(thinkingChoices(model?.thinking?.efforts));
  const level = $derived(String(info?.thinkingLevel ?? 'off'));

  let modelBtn: HTMLButtonElement | undefined = $state();
  let thinkBtn: HTMLButtonElement | undefined = $state();
  let approvalBtn: HTMLButtonElement | undefined = $state();
  let modelOpen = $state(false);
  let thinkOpen = $state(false);
  let approvalOpen = $state(false);

  async function pickModel(m: CatalogModel | null) {
    if (!m) return;
    try {
      await active.setModel(m.provider, m.id);
    } catch (e) {
      ui.error(e instanceof Error ? e.message : 'Could not change the model');
    }
  }

  async function pickLevel(l: string) {
    try {
      await active.setThinking(l as ThinkingLevel);
    } catch (e) {
      ui.error(e instanceof Error ? e.message : 'Could not change thinking');
    }
  }

  const thinkItems = $derived<MenuItem[]>(
    levels.map((l) => ({ id: l, label: l, checked: l === level, onselect: () => pickLevel(l) })),
  );
  const mode = $derived(info?.approvalMode);
</script>

<div class="chips">
  <button
    bind:this={modelBtn}
    type="button"
    class="chip"
    aria-haspopup="dialog"
    aria-expanded={modelOpen}
    title="Change model"
    disabled={!info}
    onclick={() => (modelOpen = !modelOpen)}
  >
    <span class="truncate lab">{model?.name ?? model?.id ?? 'Model'}</span>
    <Icon name="chevron-down" size={13} />
  </button>

  {#if levels.length}
    <button
      bind:this={thinkBtn}
      type="button"
      class="chip"
      aria-haspopup="menu"
      aria-expanded={thinkOpen}
      title="Thinking level"
      onclick={() => (thinkOpen = !thinkOpen)}
    >
      <Icon name="sparkle" size={13} />
      <span class="lab">{level}</span>
    </button>
  {/if}

  <button
    bind:this={approvalBtn}
    type="button"
    class="chip"
    aria-haspopup="dialog"
    aria-expanded={approvalOpen}
    title="Approval mode"
    disabled={!info}
    onclick={() => (approvalOpen = !approvalOpen)}
  >
    <Icon name="shield" size={13} />
    <span class="lab">{approvalLabel(mode)}</span>
  </button>
</div>

<ModelPicker
  open={modelOpen}
  onclose={() => (modelOpen = false)}
  anchor={modelBtn}
  current={model}
  onpick={pickModel}
/>
<Menu open={thinkOpen} onclose={() => (thinkOpen = false)} anchor={thinkBtn} title="Thinking level" items={thinkItems} align="start" />
<Adaptive open={approvalOpen} onclose={() => (approvalOpen = false)} anchor={approvalBtn} title="Approval mode" width={320}>
  <div class="modes">
    <ul>
      {#each APPROVAL_MODES as m (m.id)}
        <li class:on={m.id === mode}>
          <span class="tick">{#if m.id === mode}<Icon name="check" size={15} />{/if}</span>
          <span><strong>{m.label}</strong> <span class="hint">{m.hint}</span></span>
        </li>
      {/each}
    </ul>
    <p class="fixed">Approval mode is set when a session starts. Start a new session to change it.</p>
  </div>
</Adaptive>

<style>
  .chips {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: max-content;
  }
  .chips .chip {
    flex: none;
  }
  .lab {
    text-transform: none;
  }
  .chips .chip:first-child {
    max-width: min(200px, 42vw);
  }
  .modes {
    display: grid;
    gap: var(--s-3);
  }
  @media (min-width: 900px) {
    .modes {
      padding: var(--s-3);
    }
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  li {
    display: flex;
    gap: var(--s-2);
    color: var(--ink-2);
  }
  li.on {
    color: var(--ink);
  }
  .tick {
    flex: none;
    width: 16px;
    color: var(--accent);
  }
  .hint {
    color: var(--ink-3);
  }
  .fixed {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
</style>
