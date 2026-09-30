<script lang="ts">
  import { isAbortError } from '../lib/api/client';
  import { host } from '../lib/api/endpoints';
  import type { LedgerResponse, LedgerSessionsResponse } from '../lib/api/types';
  import { basename, compactNumber, money, relativeTime } from '../lib/format';
  import { ui } from '../lib/state';
  import { Icon, Spinner } from '../lib/ui';
  import { viewport } from '../lib/ui/media.svelte';

  const RANGES = [7, 30, 90] as const;

  let days = $state<number>(30);
  let agg = $state<LedgerResponse | null>(null);
  let roll = $state<LedgerSessionsResponse | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  // One shared tick so "2h" stamps in the session table stay honest.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  // Stale beats loading: switching the range keeps the old numbers on screen
  // until the refetch answers, and an in-flight request is aborted on switch.
  $effect(() => {
    const d = days;
    const ctrl = new AbortController();
    loading = true;
    error = null;
    Promise.all([host.ledger(d, ctrl.signal), host.ledgerSessions(d, ctrl.signal)])
      .then(([a, s]) => {
        agg = a;
        roll = s;
        error = null;
      })
      .catch((e) => {
        if (!isAbortError(e)) error = e instanceof Error ? e.message : 'Could not load usage';
      })
      .finally(() => {
        if (!ctrl.signal.aborted) loading = false;
      });
    return () => ctrl.abort();
  });

  interface ChartDay {
    date: string;
    input: number;
    output: number;
    cost: number;
  }

  /**
   * The gateway groups by ITS OWN local calendar day and returns exactly
   * `days` buckets, zero-filled, keyed by ISO date. Use those keys as-is:
   * re-deriving dates in browser-local time drifts across timezones and
   * crashes on DST boundaries.
   */
  const chartDays = $derived<ChartDay[]>(agg?.perDay ?? []);

  const chartMax = $derived.by(() => {
    const list = chartDays;
    if (!list) return 1;
    return Math.max(1, ...list.map((d) => d.input + d.output));
  });

  const totals = $derived(agg?.totals ?? null);
  const empty = $derived(totals !== null && totals.turns === 0);

  function shortDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function barTitle(d: ChartDay): string {
    const bits = [shortDate(d.date), `${compactNumber(d.input)} in`, `${compactNumber(d.output)} out`];
    if (d.cost > 0) bits.push(money(d.cost));
    return bits.join(' · ');
  }

  function sessionLabel(name: string | null, cwd: string | null): string {
    return name?.trim() || (cwd ? basename(cwd) : '') || 'Unnamed';
  }

  function openDrawer(e: MouseEvent) {
    ui.open('drawer', e.currentTarget as HTMLElement);
  }

  // viewBox scales with the range: one 10px slot per day, bars 7px wide. A
  // hardcoded width would squash 7d bars into a corner of a 30d chart.
  const chartW = $derived((agg?.days ?? 30) * 10);
  const CHART_H = 96;
</script>

<div class="page">
  {#if viewport.narrow}
    <button type="button" class="icon-btn menu" aria-label="Sessions" onclick={openDrawer}>
      <Icon name="menu" />
    </button>
  {/if}

  <header class="head">
    <div class="titles">
      <h1>Usage</h1>
      {#if totals}
        <p class="sub">{totals.turns} {totals.turns === 1 ? 'turn' : 'turns'} in the last {agg?.days} days</p>
      {/if}
    </div>
    <div class="ranges" role="group" aria-label="Time range">
      {#each RANGES as r (r)}
        <button type="button" class="btn range" aria-pressed={days === r} onclick={() => (days = r)}>
          {r}d
        </button>
      {/each}
    </div>
  </header>

  {#if error && agg}
    <div class="banner" role="alert">
      <p>Could not refresh usage. Showing results from the previous fetch.</p>
      <p class="banner-detail">{error}</p>
    </div>
  {/if}

  {#if loading && !agg}
    <div class="boot"><Spinner size={18} label="Loading usage" /></div>
  {:else if error && !agg}
    <p class="error" role="alert">{error}</p>
  {:else if totals && agg}
    <section class="cards" aria-label="Totals">
      <div class="card"><span class="k">Tokens in</span><span class="v">{compactNumber(totals.input)}</span></div>
      <div class="card"><span class="k">Tokens out</span><span class="v">{compactNumber(totals.output)}</span></div>
      <div class="card"><span class="k">Cache read</span><span class="v">{compactNumber(totals.cacheRead)}</span></div>
      <div class="card"><span class="k">Cost</span><span class="v">{money(totals.cost)}</span></div>
    </section>

    {#if empty}
      <p class="empty">No turns recorded in this range.</p>
    {:else}
      <section aria-label="Daily usage" class="chartbox">
        <svg
          class="chart"
          viewBox="0 0 {chartW} {CHART_H}"
          preserveAspectRatio="none"
          role="img"
          aria-label="Stacked daily input and output tokens for the last {agg.days} days"
        >
          {#each chartDays ?? [] as d, i (d.date)}
            <rect
              class="seg in"
              x={i * 10 + 1.5}
              y={CHART_H - (d.input / chartMax) * CHART_H}
              width="7"
              height={(d.input / chartMax) * CHART_H}
            >
              <title>{barTitle(d)}</title>
            </rect>
            <rect
              class="seg out"
              x={i * 10 + 1.5}
              y={CHART_H - ((d.input + d.output) / chartMax) * CHART_H}
              width="7"
              height={(d.output / chartMax) * CHART_H}
            >
              <title>{barTitle(d)}</title>
            </rect>
          {/each}
        </svg>
        <div class="axis" aria-hidden="true">
          <span>{chartDays?.length ? shortDate(chartDays[0]!.date) : ''}</span>
          <span>{chartDays?.length ? shortDate(chartDays[chartDays.length - 1]!.date) : ''}</span>
        </div>
        <p class="legend" aria-hidden="true">
          <span class="key"><i class="sw in"></i>in</span>
          <span class="key"><i class="sw out"></i>out</span>
        </p>
      </section>
    {/if}

    {#if agg.perModel.length}
      <section aria-label="By model" class="tbox">
        <h2 class="eyebrow">By model</h2>
        <div class="scroll-x">
          <table>
            <thead>
              <tr><th scope="col">Model</th><th scope="col" class="num">Turns</th><th scope="col" class="num">In</th>
                <th scope="col" class="num">Out</th><th scope="col" class="num">Cache read</th><th scope="col" class="num">Cost</th></tr>
            </thead>
            <tbody>
              {#each agg.perModel as m (m.model + '/' + m.provider)}
                <tr>
                  <td>
                    <span class="prime">{m.model ?? 'unknown'}</span>
                    {#if m.provider}<span class="sub2">{m.provider}</span>{/if}
                  </td>
                  <td class="num">{m.turns}</td>
                  <td class="num">{compactNumber(m.input)}</td>
                  <td class="num">{compactNumber(m.output)}</td>
                  <td class="num">{compactNumber(m.cacheRead)}</td>
                  <td class="num">{money(m.cost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    {#if roll?.sessions.length}
      <section aria-label="By session" class="tbox">
        <h2 class="eyebrow">By session</h2>
        <div class="scroll-x">
          <table>
            <thead>
              <tr><th scope="col">Session</th><th scope="col" class="num">Turns</th><th scope="col" class="num">In</th>
                <th scope="col" class="num">Out</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Last turn</th></tr>
            </thead>
            <tbody>
              {#each roll.sessions as s, i (i)}
                <tr>
                  <td>
                    <span class="prime">{sessionLabel(s.sessionName, s.cwd)}</span>
                    {#if s.sessionName?.trim() && s.cwd}<span class="sub2">{basename(s.cwd)}</span>{/if}
                  </td>
                  <td class="num">{s.turns}</td>
                  <td class="num">{compactNumber(s.input)}</td>
                  <td class="num">{compactNumber(s.output)}</td>
                  <td class="num">{money(s.cost)}</td>
                  <td class="num">{relativeTime(s.lastTs * 1000, now)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .page {
    position: relative;
    height: 100%;
    overflow-y: auto;
    padding: max(var(--safe-t), var(--s-4)) var(--s-4) var(--s-6);
    max-width: var(--reading-w);
    margin: 0 auto;
    display: grid;
    align-content: start;
    gap: var(--s-4);
  }
  .menu {
    position: absolute;
    top: max(var(--safe-t), var(--s-2));
    left: var(--s-2);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-2) var(--s-4);
    padding-left: var(--s-6);
  }
  .head h1 {
    font-size: var(--fs-xl);
    line-height: var(--lh);
  }
  .sub {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .ranges {
    display: inline-flex;
    gap: var(--s-1);
  }
  .range[aria-pressed='true'] {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .boot {
    display: grid;
    place-content: center;
    padding: var(--s-7) 0;
    color: var(--ink-3);
  }
  .error {
    color: var(--err);
  }
  .banner {
    display: grid;
    gap: var(--s-1);
    border: 1px solid var(--err);
    border-radius: var(--r-md);
    padding: var(--s-3);
    color: var(--err);
  }
  .banner-detail {
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .empty {
    color: var(--ink-3);
    padding: var(--s-5) 0;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--s-2);
  }
  .card {
    display: grid;
    gap: var(--s-1);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: var(--s-3);
  }
  .card .k {
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .card .v {
    font-size: var(--fs-lg);
    font-variant-numeric: tabular-nums;
  }
  .chartbox {
    display: grid;
    gap: var(--s-1);
  }
  .chart {
    width: 100%;
    height: 96px;
    display: block;
  }
  .chart .seg.in {
    fill: var(--accent);
  }
  .chart .seg.out {
    fill: var(--ok);
  }
  .axis {
    display: flex;
    justify-content: space-between;
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .legend {
    display: flex;
    gap: var(--s-3);
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    display: inline-block;
  }
  .sw.in {
    background: var(--accent);
  }
  .sw.out {
    background: var(--ok);
  }
  .tbox {
    display: grid;
    gap: var(--s-2);
  }
  .scroll-x {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  th,
  td {
    text-align: left;
    padding: var(--s-2) var(--s-2);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  th {
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--ink-3);
  }
  td.num,
  th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .prime {
    display: block;
  }
  .sub2 {
    display: block;
    font-size: var(--fs-xs);
    color: var(--ink-3);
  }

  @media (max-width: 599.98px) {
    .page {
      padding-top: max(var(--safe-t), var(--s-3));
    }
    .head {
      padding-left: 0;
    }
    .menu {
      position: static;
      order: -1;
      justify-self: start;
    }
  }
</style>
