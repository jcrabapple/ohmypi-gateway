import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../lib/api/__fixtures__/ledger.json';
import type * as Endpoints from '../../lib/api/endpoints';
import type { LedgerResponse, LedgerSessionsResponse } from '../../lib/api/types';
import { host } from '../../lib/api/endpoints';
import UsageView from '../UsageView.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

const aggregate = fixture.aggregate as unknown as LedgerResponse;
const sessions = fixture.sessions as unknown as LedgerSessionsResponse;
const empty7 = fixture.empty as unknown as LedgerResponse;

vi.mock('../../lib/api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof Endpoints>();
  return {
    ...actual,
    host: {
      ...actual.host,
      ledger: vi.fn(async () => aggregate),
      ledgerSessions: vi.fn(async () => sessions),
    },
  };
});

const ledgerMock = vi.mocked(host.ledger);
const sessionsMock = vi.mocked(host.ledgerSessions);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UsageView', () => {
  it('renders fixture aggregates: totals cards, per-model and per-session tables', async () => {
    const { target } = render(UsageView, {});
    await settle();
    expect(ledgerMock).toHaveBeenCalledWith(30, expect.any(AbortSignal));
    expect(sessionsMock).toHaveBeenCalledWith(30, expect.any(AbortSignal));

    const text = target.textContent ?? '';
    // Totals cards: compactNumber + money formats.
    expect(text).toContain('154k');
    expect(text).toContain('21k');
    expect(text).toContain('903k');
    expect(text).toContain('$1.28');
    // Subtitle counts turns for the selected range.
    expect(text).toContain('12 turns in the last 30 days');
    // Per-model table with provider sublines.
    expect(text).toContain('glm-5.3-flashx');
    expect(text).toContain('devstral-small-2:24b-cloud');
    expect(text).toContain('z-ai');
    expect(text).toContain('ollama');
    // Per-session table: named session falls back to its folder when unnamed.
    expect(text).toContain('usage ledger build');
    expect(text).toContain('ohmypi-gateway');
    expect(text).toContain('probe');
    // The daily chart rendered with both segments present.
    expect(target.querySelectorAll('svg .seg.in').length).toBeGreaterThan(0);
    expect(target.querySelectorAll('svg .seg.out').length).toBeGreaterThan(0);
  });

  it('refetches with the picked range and repaints from the new data', async () => {
    ledgerMock.mockImplementation(async (d) => (d === 7 ? empty7 : aggregate));
    sessionsMock.mockImplementation(async (d) =>
      d === 7 ? { days: 7, sessions: [] } : sessions,
    );
    const { target } = render(UsageView, {});
    await settle();
    expect(target.textContent).toContain('glm-5.3-flashx');

    buttonNamed(target, '7d')!.click();
    await settle();
    await settle();

    expect(ledgerMock).toHaveBeenCalledWith(7, expect.any(AbortSignal));
    const text = target.textContent ?? '';
    expect(text).toContain('No turns recorded in this range.');
    expect(text).toContain('0 turns in the last 7 days');
    expect(text).not.toContain('glm-5.3-flashx');
    expect(target.querySelector('svg.chart')).toBeNull();
  });

  it('shows the first-run empty state with zeroed cards and no chart', async () => {
    ledgerMock.mockImplementation(async () => empty7);
    sessionsMock.mockImplementation(async () => ({ days: 7, sessions: [] }));
    const { target } = render(UsageView, {});
    await settle();

    const text = target.textContent ?? '';
    expect(text).toContain('$0.00');
    expect(text).toContain('No turns recorded in this range.');
    expect(target.querySelector('svg.chart')).toBeNull();
    expect(target.querySelector('table')).toBeNull();
  });

  it('sizes the chart viewBox from the range and lays out one 10px slot per day', async () => {
    for (const n of [7, 30]) {
      const perDay = Array.from({ length: n }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        input: (i + 1) * 100,
        output: 10,
        cost: 0.1,
      }));
      const ranged: LedgerResponse = { ...aggregate, days: n, perDay };
      ledgerMock.mockImplementation(async () => ranged);
      sessionsMock.mockImplementation(async () => ({ days: n, sessions: [] }));
      const { target } = render(UsageView, {});
      await settle();

      const svg = target.querySelector('svg.chart')!;
      expect(svg.getAttribute('viewBox')).toBe(`0 0 ${n * 10} 96`);
      const xs = [...target.querySelectorAll('rect.seg.in')].map((r) => r.getAttribute('x'));
      expect(xs.length).toBe(n);
      expect(xs[0]).toBe('1.5');
      expect(xs[n - 1]).toBe(`${(n - 1) * 10 + 1.5}`);
      cleanup();
    }
  });

  it('shows a visible banner and keeps stale data when a refetch fails', async () => {
    ledgerMock.mockImplementation(async (d) => {
      if (d === 7) throw new Error('socket hang up');
      return aggregate;
    });
    sessionsMock.mockImplementation(async (d) => {
      if (d === 7) throw new Error('socket hang up');
      return sessions;
    });
    const { target } = render(UsageView, {});
    await settle();
    expect(target.textContent).toContain('glm-5.3-flashx');

    buttonNamed(target, '7d')!.click();
    await settle();
    await settle();

    const banner = target.querySelector('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('Could not refresh usage');
    expect(banner!.textContent).toContain('socket hang up');
    // Stale rows stay on screen next to the banner.
    expect(target.textContent).toContain('glm-5.3-flashx');
  });
});
