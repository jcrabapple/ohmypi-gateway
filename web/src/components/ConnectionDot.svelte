<script lang="ts">
  type State = 'live' | 'connecting' | 'offline';
  const TEXT: Record<State, string> = { live: 'Connected', connecting: 'Reconnecting', offline: 'Offline' };

  let { state, label = true }: { state: State; label?: boolean } = $props();
</script>

<span class="wrap" role="status">
  <span class="dot {state}" aria-hidden="true"></span>
  <span class:sr-only={!label}>{TEXT[state]}</span>
</span>

<style>
  .wrap {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
  }
  .connecting {
    background: var(--warn);
    animation: pulse 1.2s var(--ease) infinite;
  }
  .offline {
    background: var(--err);
  }
  @keyframes pulse {
    50% { opacity: 0.35; }
  }
</style>
