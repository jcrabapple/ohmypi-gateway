<script lang="ts">
  import type { SkillItem } from '../../lib/transcript/types';
  import { Icon } from '../../lib/ui';

  let { item }: { item: SkillItem } = $props();

  let open = $state(false);
  const uid = $props.id();
</script>

<div class="skill">
  <button type="button" class="chip" aria-expanded={open} aria-controls="{uid}-c" onclick={() => (open = !open)}>
    <Icon name="sparkle" size={13} />
    <span>Skill: {item.name}</span>
    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
  </button>
  {#if open}
<!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable region must be keyboard focusable) -->
    <pre id="{uid}-c" class="body" tabindex="0">{item.content}</pre>
  {/if}
</div>

<style>
  .skill {
    display: grid;
    justify-items: start;
    gap: var(--s-2);
  }
  .body {
    max-width: 100%;
    max-height: 320px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--s-3);
    background: var(--inset);
    border-radius: var(--r-md);
    color: var(--ink-2);
    font-size: var(--fs-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
