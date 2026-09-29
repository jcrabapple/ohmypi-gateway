<script lang="ts">
  import { compactNumber, contextLevel } from '../lib/format';

  type Props = { percent: number | null; tokens?: number | null; window?: number | null };

  let { percent, tokens = null, window: ctxWindow = null }: Props = $props();

  const level = $derived(contextLevel(percent));
  const shown = $derived(percent == null ? null : Math.min(100, Math.max(0, Math.round(percent))));
  const detail = $derived(
    tokens != null && ctxWindow
      ? `${compactNumber(tokens)} of ${compactNumber(ctxWindow)} tokens`
      : ctxWindow
        ? `${compactNumber(ctxWindow)} token window`
        : 'Context use',
  );
</script>

<span
  class="meter {level}"
  role="meter"
  aria-label="Context used"
  aria-valuemin="0"
  aria-valuemax="100"
  aria-valuenow={shown ?? undefined}
  aria-valuetext={shown == null ? 'unknown' : `${shown} percent`}
  title={detail}
>
  <span class="bar" aria-hidden="true"><span class="fill" style:width="{shown ?? 0}%"></span></span>
  <span class="num mono">{shown == null ? '–' : `${shown}%`}</span>
</span>

<style>
  .meter {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .bar {
    width: 44px;
    height: 3px;
    border-radius: 2px;
    background: var(--line-strong);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--ink-2);
    border-radius: 2px;
    transition: width var(--dur-slow) var(--ease), background var(--dur) var(--ease);
  }
  .warn .fill { background: var(--warn); }
  .err .fill { background: var(--err); }
  .warn .num { color: var(--warn); }
  .err .num { color: var(--err); }
  .num {
    min-width: 3ch;
    text-align: right;
  }
</style>
