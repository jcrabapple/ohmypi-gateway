<script lang="ts">
  import type { ApprovalMode, CatalogModel, ThinkingLevel } from '../lib/api/types';
  import { THINKING_LEVELS } from '../lib/api/types';
  import { clearDraft, loadDraft, saveDraft } from '../lib/composer/drafts';
  import { APPROVAL_MODES } from '../lib/composer/modes';
  import { basename, uniqueCwds } from '../lib/format';
  import { device } from '../lib/platform/storage';
  import { nav, sessionsStore, ui } from '../lib/state';
  import { Icon, Sheet, Spinner } from '../lib/ui';
  import ModelPicker from './ModelPicker.svelte';

  const LAST_CWD = 'lastCwd';
  const DEFAULT_CWD = '~/projects';

  let { onclose }: { onclose: () => void } = $props();

  const stored = device.get<unknown>(LAST_CWD, DEFAULT_CWD);
  let cwd = $state(typeof stored === 'string' && stored ? stored : DEFAULT_CWD);
  let model = $state<CatalogModel | null>(null);
  let thinking = $state<ThinkingLevel | ''>('');
  let approval = $state<ApprovalMode>('yolo');
  let advisor = $state(false);
  let starting = $state(false);
  let error = $state<string | null>(null);
  let pickerOpen = $state(false);
  let modelBtn: HTMLButtonElement | undefined = $state();

  const suggestions = $derived(uniqueCwds(sessionsStore.live).slice(0, 5));
  const carried = $derived.by(() => {
    const g = nav.lastGone;
    if (!g) return '';
    return loadDraft(g.gwId);
  });
  let bringDraft = $state(true);

  const uid = $props.id();

  async function start(e?: SubmitEvent) {
    e?.preventDefault();
    if (starting) return;
    const dir = cwd.trim() || DEFAULT_CWD;
    starting = true;
    error = null;
    const gone = nav.lastGone;
    const draft = bringDraft && carried ? carried : '';
    try {
      await nav.create(
        {
          cwd: dir,
          ...(model ? { model: model.selector } : {}),
          ...(thinking ? { thinking } : {}),
          approvalMode: approval,
          ...(advisor ? { advisor: true } : {}),
        },
        (info) => {
          if (draft) saveDraft(info.gwId, draft);
        },
      );
      device.set(LAST_CWD, dir);
      if (draft && gone) clearDraft(gone.gwId);
      nav.lastGone = null;
      ui.close('new-session');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not start the session';
      starting = false;
    }
  }
</script>

<Sheet open={true} {onclose} title="New session" size="md">
  <form class="form" onsubmit={start}>
    <div class="group">
      <label class="lbl" for="{uid}-cwd">Folder</label>
      <input
        id="{uid}-cwd"
        class="field mono"
        type="text"
        bind:value={cwd}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder={DEFAULT_CWD}
      />
      {#if suggestions.length}
        <div class="chips" role="group" aria-label="Recent folders">
          {#each suggestions as dir (dir)}
            <button type="button" class="chip" class:on={cwd.trim() === dir} title={dir} onclick={() => (cwd = dir)}>
              {basename(dir) || dir}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="group">
      <span class="lbl" id="{uid}-model">Model</span>
      <button
        type="button"
        class="pick"
        bind:this={modelBtn}
        aria-labelledby="{uid}-model"
        aria-haspopup="dialog"
        onclick={() => (pickerOpen = true)}
      >
        <span class:muted={!model}>{model ? model.name : 'Default model'}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      <ModelPicker
        open={pickerOpen}
        onclose={() => (pickerOpen = false)}
        anchor={modelBtn}
        current={model}
        defaultLabel="Default model"
        onpick={(m) => {
          model = m;
          pickerOpen = false;
        }}
      />
    </div>

    <fieldset class="group">
      <legend class="lbl">Thinking</legend>
      <div class="chips">
        {#each [{ id: '', label: 'Default' }, ...THINKING_LEVELS.map((l) => ({ id: l, label: l }))] as t (t.id)}
          <label class="chip" class:on={thinking === t.id}>
            <input class="sr-only" type="radio" name="{uid}-think" value={t.id} bind:group={thinking} />
            {t.label}
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset class="group">
      <legend class="lbl">Approval</legend>
      <div class="cards">
        {#each APPROVAL_MODES as m (m.id)}
          <label class="card" class:on={approval === m.id}>
            <input class="sr-only" type="radio" name="{uid}-appr" value={m.id} bind:group={approval} />
            <span class="name">{m.label}</span>
            <span class="hint">{m.hint}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    {#if carried}
      <label class="carry">
        <input type="checkbox" bind:checked={bringDraft} />
        <span>Bring over the unsent message from the ended session</span>
      </label>
    {/if}

    <label class="carry" title="omp's advisor runtime passively reviews each turn and injects notes. Applies to this session only.">
      <input type="checkbox" bind:checked={advisor} />
      <span>Enable advisor</span>
    </label>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="btn btn-ghost" onclick={onclose}>Cancel</button>
      <button type="submit" class="btn btn-primary" disabled={starting}>
        {#if starting}<Spinner size={14} />{/if}
        Start
      </button>
    </div>
  </form>
</Sheet>

<style>
  .form {
    display: grid;
    gap: var(--s-4);
    padding: var(--s-1) 0;
  }
  .group {
    display: grid;
    gap: var(--s-2);
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .lbl {
    font-size: var(--fs-sm);
    color: var(--ink-2);
    padding: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 var(--s-3);
    border-radius: 999px;
    background: var(--inset);
    box-shadow: var(--ring);
    font-size: var(--fs-sm);
    color: var(--ink-2);
    text-transform: capitalize;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease);
  }
  .chip:hover {
    background: var(--hover);
  }
  .chip.on {
    background: var(--accent-soft);
    box-shadow: 0 0 0 1px var(--accent);
    color: var(--ink);
  }
  .chip:has(:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  @media (pointer: coarse) {
    .chip {
      min-height: var(--hit);
    }
  }
  .pick {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--hit);
    padding: 0 var(--s-3);
    background: var(--field);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    text-align: left;
  }
  .muted {
    color: var(--ink-3);
  }
  .cards {
    display: grid;
    gap: var(--s-2);
  }
  .card {
    display: grid;
    gap: 2px;
    padding: var(--s-2) var(--s-3);
    min-height: var(--hit);
    border-radius: var(--r-md);
    background: var(--inset);
    box-shadow: var(--ring);
    cursor: pointer;
  }
  .card.on {
    background: var(--accent-soft);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .card:has(:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .name {
    font-weight: 600;
  }
  .hint {
    font-size: var(--fs-sm);
    color: var(--ink-3);
  }
  .carry {
    display: flex;
    gap: var(--s-2);
    align-items: center;
    font-size: var(--fs-sm);
    color: var(--ink-2);
    min-height: var(--hit);
  }
  .error {
    color: var(--err);
    font-size: var(--fs-sm);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
  }
</style>
