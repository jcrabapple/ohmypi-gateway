<script lang="ts">
  import { contrast, isHex, readableInk } from '../../lib/color';
  import { ACCENTS, FALLBACK_ACCENT } from '../../lib/state/accents';
  import { settings, THEMES, type Density, type ProseFont, type Theme, type Width } from '../../lib/state/settings.svelte';
  import { Icon, Segmented } from '../../lib/ui';
  import Section from './Section.svelte';

  const THEME_INFO: Record<Theme, { label: string; note: string }> = {
    terminal: { label: 'Terminal', note: 'Dark, green' },
    graphite: { label: 'Graphite', note: 'Dark, blue' },
    paper: { label: 'Paper', note: 'Light' },
    contrast: { label: 'Contrast', note: 'Dark, high contrast' },
  };

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Both read the page's live custom properties, so they follow the theme and accent as they change.
  const themeAccent = $derived.by(() => {
    void settings.effectiveTheme;
    void settings.data.accent;
    return cssVar('--accent');
  });
  const accent = $derived(settings.data.accent);
  const shownAccent = $derived(accent ?? themeAccent);
  const lowContrast = $derived.by(() => {
    void settings.effectiveTheme;
    const canvas = cssVar('--canvas');
    return !!accent && isHex(accent) && isHex(canvas) && contrast(accent, canvas) < 3;
  });
  const customValue = $derived(isHex(shownAccent) ? shownAccent : FALLBACK_ACCENT);
  const isPreset = $derived(!!accent && ACCENTS.some((a) => a.hex.toLowerCase() === accent.toLowerCase()));

  const densities = [
    { id: 'comfortable', label: 'Comfortable' },
    { id: 'compact', label: 'Compact' },
  ] as const satisfies readonly { id: Density; label: string }[];
  const widths = [
    { id: 'reading', label: 'Reading' },
    { id: 'wide', label: 'Wide' },
  ] as const satisfies readonly { id: Width; label: string }[];
  const fonts = [
    { id: 'sans', label: 'Sans' },
    { id: 'mono', label: 'Mono' },
  ] as const satisfies readonly { id: ProseFont; label: string }[];
</script>

<Section id="theme" title="Theme" hint="Changes apply right away and stay on this device.">
  <div class="cards" role="radiogroup" aria-label="Theme">
    {#each THEMES as t (t)}
      <label class="card">
        <input
          type="radio"
          class="sr-only"
          name="theme"
          value={t}
          checked={settings.data.theme === t}
          onchange={() => settings.update({ theme: t })}
        />
        <span class="preview" data-theme={t} aria-hidden="true">
          <span class="p-head"><i class="p-dot"></i><i class="p-bar"></i></span>
          <span class="p-line w70"></span>
          <span class="p-line w45 dim"></span>
          <span class="p-pill">Aa</span>
        </span>
        <span class="name">
          {THEME_INFO[t].label}
          {#if settings.data.theme === t}<Icon name="check" size={14} />{/if}
        </span>
        <span class="note">{THEME_INFO[t].note}</span>
      </label>
    {/each}
  </div>
</Section>

<Section id="follow-system" title="Follow system appearance" hint="Use Paper when your device is set to light.">
  <label class="switch">
    <input
      type="checkbox"
      role="switch"
      checked={settings.data.followSystem}
      onchange={(e) => settings.update({ followSystem: e.currentTarget.checked })}
    />
    <span class="track" aria-hidden="true"></span>
    <span>{settings.data.followSystem ? 'On' : 'Off'}</span>
  </label>
</Section>

<Section id="accent" title="Accent colour" hint="Used for the send button, links and focus rings.">
  <div class="swatches" role="radiogroup" aria-label="Accent colour">
    <label class="swatch" title="Theme default">
      <input
        type="radio"
        class="sr-only"
        name="accent"
        checked={accent === null}
        onchange={() => settings.update({ accent: null })}
      />
      <span class="dot" style:background={themeAccent}>
        {#if accent === null}<Icon name="check" size={14} />{/if}
      </span>
      <span class="sr-only">Theme default</span>
    </label>
    {#each ACCENTS as a (a.id)}
      {@const on = accent?.toLowerCase() === a.hex}
      <label class="swatch" title={a.label}>
        <input type="radio" class="sr-only" name="accent" checked={on} onchange={() => settings.update({ accent: a.hex })} />
        <span class="dot" style:background={a.hex} style:color={readableInk(a.hex)}>
          {#if on}<Icon name="check" size={14} />{/if}
        </span>
        <span class="sr-only">{a.label}</span>
      </label>
    {/each}
    <label class="custom" class:on={!!accent && !isPreset}>
      <input
        type="color"
        value={customValue}
        aria-label="Custom accent colour"
        oninput={(e) => settings.update({ accent: e.currentTarget.value })}
      />
      <span>Custom</span>
    </label>
  </div>
  {#if lowContrast}
    <p class="warn" role="status">This colour is hard to see on the current theme. Pick a lighter or darker one.</p>
  {/if}
</Section>

<Section id="density" title="Density" hint="Compact fits more of a conversation on screen.">
  <Segmented label="Density" value={settings.data.density} options={densities} onchange={(v) => settings.update({ density: v })} />
</Section>

<Section id="width" title="Transcript width" hint="Wide suits big screens and long code.">
  <Segmented label="Transcript width" value={settings.data.width} options={widths} onchange={(v) => settings.update({ width: v })} />
</Section>

<Section id="prose" title="Prose font" hint="Code always stays monospace.">
  <Segmented label="Prose font" value={settings.data.proseFont} options={fonts} onchange={(v) => settings.update({ proseFont: v })} />
</Section>

<div class="reset">
  <button type="button" class="btn btn-ghost" onclick={() => settings.reset()}>Reset appearance</button>
</div>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--s-3);
  }
  .card {
    display: grid;
    gap: 2px;
    cursor: pointer;
  }
  .preview {
    display: grid;
    align-content: start;
    gap: 5px;
    height: 84px;
    padding: var(--s-2);
    border-radius: var(--r-md);
    background: var(--canvas);
    color: var(--ink);
    box-shadow: 0 0 0 1px var(--line-strong);
    transition: box-shadow var(--dur-fast) var(--ease);
  }
  .card:hover .preview {
    box-shadow: 0 0 0 1px var(--ink-3);
  }
  .card:has(input:checked) .preview {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .card:has(input:focus-visible) .preview {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .p-head {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .p-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .p-bar {
    width: 38%;
    height: 5px;
    border-radius: 3px;
    background: var(--ink-3);
  }
  .p-line {
    height: 6px;
    border-radius: 3px;
    background: var(--ink);
  }
  .p-line.dim {
    background: var(--ink-2);
  }
  .w70 { width: 70%; }
  .w45 { width: 45%; }
  .p-pill {
    justify-self: start;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink);
    font: 600 var(--fs-xs) / 16px var(--sans);
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    margin-top: var(--s-1);
    font-weight: 600;
  }
  .name :global(svg) {
    color: var(--accent);
  }
  .note {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }

  .switch {
    display: inline-flex;
    align-items: center;
    gap: var(--s-3);
    min-height: var(--hit);
    cursor: pointer;
  }
  .switch input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }
  .track {
    position: relative;
    width: 38px;
    height: 22px;
    border-radius: 999px;
    background: var(--inset);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    transition: background var(--dur-fast) var(--ease);
  }
  .track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--ink-2);
    transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
  }
  .switch input:checked + .track {
    background: var(--accent);
    box-shadow: none;
  }
  .switch input:checked + .track::after {
    transform: translateX(16px);
    background: var(--accent-ink);
  }
  .switch input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
  .swatch {
    display: grid;
    place-items: center;
    min-width: var(--hit);
    min-height: var(--hit);
    cursor: pointer;
  }
  .dot {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px var(--line-strong);
    transition: transform var(--dur-fast) var(--ease);
  }
  .swatch:hover .dot {
    transform: scale(1.08);
  }
  .swatch:has(input:checked) .dot {
    box-shadow: 0 0 0 2px var(--canvas), 0 0 0 4px var(--ink);
  }
  .swatch:has(input:focus-visible) .dot {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
  }
  .custom {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    min-height: var(--hit);
    padding: 0 var(--s-3) 0 var(--s-2);
    border-radius: 999px;
    color: var(--ink-2);
    box-shadow: var(--ring);
    cursor: pointer;
  }
  .custom.on {
    color: var(--ink);
    box-shadow: 0 0 0 2px var(--ink);
  }
  .custom input {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    cursor: pointer;
  }
  .warn {
    color: var(--warn);
    font-size: var(--fs-sm);
  }
  .reset {
    padding-top: var(--s-4);
    border-top: 1px solid var(--line);
  }
</style>
