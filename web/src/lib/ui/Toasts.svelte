<script lang="ts">
  // Renders `ui.toasts`. Tell with `toast()` from lib/ui.
  import { ui } from '../state/ui.svelte';
  import Icon from './Icon.svelte';
</script>

<div class="toasts" role="status" aria-live="polite" aria-atomic="false">
  {#each ui.toasts as t (t.id)}
    <div class="toast" class:error={t.kind === 'error'}>
      {#if t.kind === 'error'}<Icon name="alert" size={16} />{/if}
      <span class="text">{t.text}</span>
      {#if t.action}
        <button
          type="button"
          class="act"
          onclick={() => {
            t.action?.run();
            ui.dismissToast(t.id);
          }}
        >
          {t.action.label}
        </button>
      {/if}
      <button type="button" class="icon-btn close" aria-label="Dismiss" onclick={() => ui.dismissToast(t.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    z-index: 100;
    left: 50%;
    bottom: calc(var(--kb) + var(--safe-b) + 96px);
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    width: min(440px, calc(100vw - 24px));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: var(--s-3);
    width: 100%;
    padding: var(--s-2) var(--s-2) var(--s-2) var(--s-4);
    background: var(--surface);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    animation: rise var(--dur) var(--ease);
  }
  .toast.error {
    color: var(--err);
  }
  .text {
    flex: 1;
    min-width: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .error .text {
    color: var(--ink);
  }
  .act {
    color: var(--accent);
    font-weight: 600;
    padding: 0 var(--s-2);
    min-height: var(--hit);
  }
  .close {
    min-width: 28px;
    min-height: 28px;
  }
  @media (pointer: coarse) {
    .close {
      min-width: var(--hit);
      min-height: var(--hit);
    }
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
  }
</style>
