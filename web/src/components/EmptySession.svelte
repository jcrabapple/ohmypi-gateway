<script lang="ts">
  import { Kbd } from '../lib/ui';

  let { onpick }: { onpick: (text: string) => void } = $props();

  const STARTERS = [
    { label: 'Tour this codebase', text: 'Give me a short tour of this codebase: what it does and how it is laid out.' },
    { label: 'Review my changes', text: 'Review the uncommitted changes in this repo and point out anything risky.' },
    { label: 'Find a cleanup', text: 'Look for dead code or repeated logic here and suggest one small cleanup.' },
  ];
</script>

<div class="empty">
  <p class="lead">What should we work on?</p>
  <div class="starters">
    {#each STARTERS as s (s.label)}
      <button type="button" class="starter" onclick={() => onpick(s.text)}>{s.label}</button>
    {/each}
  </div>
  <p class="hint">Type <Kbd>/</Kbd> for commands</p>
</div>

<style>
  .empty {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: var(--s-4);
    min-height: 100%;
    padding: var(--s-7) var(--s-4);
    text-align: center;
  }
  .lead {
    font-size: var(--fs-xl);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .starters {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--s-2);
  }
  .starter {
    min-height: max(36px, var(--hit));
    padding: 0 var(--s-4);
    border-radius: 999px;
    box-shadow: var(--ring);
    color: var(--ink-2);
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  .starter:hover {
    background: var(--hover);
    color: var(--ink);
  }
  .hint {
    color: var(--ink-3);
    font-size: var(--fs-sm);
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
</style>
