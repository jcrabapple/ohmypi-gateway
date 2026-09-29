<script lang="ts">
  import { keyLabels, SHORTCUTS, type ShortcutDef, type ShortcutGroup } from '../../lib/keymap';
  import { Kbd } from '../../lib/ui';
  import Section from './Section.svelte';

  const GROUPS: ShortcutGroup[] = ['General', 'Sessions', 'Composer', 'Approvals'];
  const grouped = GROUPS.map((g) => ({ group: g, items: SHORTCUTS.filter((s) => s.group === g) }));

  // "1" stands for a range of digits, so show it as such.
  function caps(s: ShortcutDef): string[] {
    return s.id === 'approval-pick' ? ['1', '2', '3'] : keyLabels(s.chord);
  }
</script>

<Section
  id="keys"
  title="Keyboard shortcuts"
  hint="Single-key shortcuts pause while you type in a box. Ctrl or Cmd shortcuts and Esc always work."
>
  {#each grouped as g (g.group)}
    <div class="group">
      <h4 class="eyebrow">{g.group}</h4>
      <ul>
        {#each g.items as s (s.id)}
          <li>
            <span>{s.label}</span>
            <span class="keys">
              {#each caps(s) as k, i (i)}
                {#if s.chord.includes(' ') && i > 0}<span class="then">then</span>{/if}
                <Kbd>{k}</Kbd>
              {/each}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</Section>

<style>
  .group + .group {
    margin-top: var(--s-3);
  }
  ul {
    list-style: none;
    margin: var(--s-1) 0 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-4);
    min-height: 36px;
    padding: 0 var(--s-1);
    border-bottom: 1px solid var(--line);
  }
  .keys {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    flex: none;
  }
  .then {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
</style>
