<script module lang="ts">
  export type SessionStatus = 'needs' | 'running' | 'idle';
</script>

<script lang="ts">
  const LABEL: Record<SessionStatus, string> = { needs: 'Needs you', running: 'Running', idle: 'Idle' };

  let { status }: { status: SessionStatus } = $props();
</script>

<span class="glyph {status}" role="img" aria-label={LABEL[status]}></span>

<style>
  .glyph {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin: 0 2px;
  }
  .idle {
    box-shadow: inset 0 0 0 1.5px var(--ink-3);
  }
  .running {
    background: var(--accent);
    animation: pulse 1.6s var(--ease) infinite;
  }
  .needs {
    background: var(--warn);
    box-shadow: 0 0 0 3px var(--warn-soft);
  }
  @keyframes pulse {
    50% { opacity: 0.35; }
  }
</style>
