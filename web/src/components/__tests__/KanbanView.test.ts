import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Endpoints from '../../lib/api/endpoints';
import { kanban as kanbanApi } from '../../lib/api/endpoints';
import type { KanbanBoard } from '../../lib/api/types';
import { nav, ui } from '../../lib/state';
import { kanbanStore } from '../../lib/state/kanban.svelte';
import KanbanView from '../KanbanView.svelte';
import { buttonNamed, cleanup, render, settle } from './mount';

const sampleBoard: KanbanBoard = {
  version: 1,
  next_id: 3,
  columns: ['todo', 'doing', 'review', 'done'],
  cwd: '/work/alpha',
  path: '/work/alpha/.omp/kanban/board.json',
  exists: true,
  tickets: [
    {
      id: 'K-1',
      title: 'Fix login redirect',
      body: 'Preserve hash after auth',
      column: 'todo',
      priority: 10,
      tags: ['auth'],
      blocked_by: [],
      created: '2026-11-16T00:00:00.000Z',
      updated: '2026-11-16T00:00:00.000Z',
      notes: [],
    },
    {
      id: 'K-2',
      title: 'Verify cookie flags',
      body: '',
      column: 'doing',
      priority: 20,
      tags: ['security'],
      blocked_by: ['K-1'],
      created: '2026-11-16T00:00:00.000Z',
      updated: '2026-11-16T00:00:00.000Z',
      notes: [{ at: '2026-11-16T00:10:00.000Z', text: 'Investigating' }],
      claimed_by: 'omp-web',
      claimed_at: new Date().toISOString(),
    },
  ],
};

vi.mock('../../lib/api/endpoints', async (importOriginal) => {
  const actual = await importOriginal<typeof Endpoints>();
  return {
    ...actual,
    kanban: {
      boards: vi.fn(async () => ({
        boards: [
          {
            cwd: '/work/alpha',
            name: 'alpha',
            path: '/work/alpha/.omp/kanban/board.json',
            counts: { todo: 1, doing: 1, review: 0, done: 0 },
            total: 2,
            updated: '2026-11-16T00:10:00.000Z',
          },
        ],
      })),
      board: vi.fn(async () => sampleBoard),
      init: vi.fn(async (cwd: string) => ({ ...sampleBoard, cwd, tickets: [], next_id: 1 })),
      archiveList: vi.fn(async (cwd: string) => ({ cwd, tickets: [] })),
      add: vi.fn(async (body: { title: string }) => ({
        ticket: { ...sampleBoard.tickets[0]!, id: 'K-3', title: body.title },
        board: {
          ...sampleBoard,
          next_id: 4,
          tickets: [
            ...sampleBoard.tickets,
            { ...sampleBoard.tickets[0]!, id: 'K-3', title: body.title },
          ],
        },
      })),
      move: vi.fn(async () => ({ ticket: sampleBoard.tickets[0]!, board: sampleBoard })),
      update: vi.fn(async () => ({ ticket: sampleBoard.tickets[0]!, board: sampleBoard })),
      note: vi.fn(async () => ({ ticket: sampleBoard.tickets[0]!, board: sampleBoard })),
      claim: vi.fn(async () => ({ ticket: sampleBoard.tickets[0]!, board: sampleBoard })),
      release: vi.fn(async () => ({ ticket: sampleBoard.tickets[1]!, board: sampleBoard })),
      delete: vi.fn(async () => ({ deleted: sampleBoard.tickets[0]!, board: sampleBoard })),
      archive: vi.fn(async () => ({ moved: 0, archivedIds: [], board: sampleBoard })),
    },
  };
});

beforeEach(() => {
  nav.kanban = true;
  nav.kanbanCwd = null;
});

afterEach(() => {
  cleanup();
  kanbanStore.clearBoard();
  kanbanStore.boards = [];
  kanbanStore.boardsLoaded = false;
  kanbanStore.boardsError = null;
  nav.kanban = false;
  nav.kanbanCwd = null;
  ui.toasts.forEach((t) => ui.dismissToast(t.id));
  vi.clearAllMocks();
});

describe('KanbanView', () => {
  it('renders discovered boards index and opens a project board on click', async () => {
    const openSpy = vi.spyOn(nav, 'openKanban').mockImplementation((cwd = null) => {
      nav.kanbanCwd = cwd ?? null;
    });
    const { target } = render(KanbanView, {});
    await settle();
    expect(kanbanApi.boards).toHaveBeenCalledOnce();
    expect(target.textContent).toContain('alpha');
    expect(target.textContent).toContain('2 open');

    target.querySelector<HTMLButtonElement>('button.board-card')!.click();
    await settle();
    expect(openSpy).toHaveBeenCalledWith('/work/alpha');
  });

  it('renders columns, blocker/claimed state, filters by tag and text, and creates a ticket', async () => {
    nav.kanbanCwd = '/work/alpha';
    const { target } = render(KanbanView, {});
    await settle();

    expect(kanbanApi.board).toHaveBeenCalledWith('/work/alpha', expect.any(AbortSignal));
    expect(target.textContent).toContain('K-1');
    expect(target.textContent).toContain('Fix login redirect');
    expect(target.textContent).toContain('K-2');
    expect(target.textContent).toContain('blocked by K-1');
    expect(target.textContent).toContain('claimed');

    // Tag filter narrows to K-1 only.
    const authTag = buttonNamed(target, '#auth');
    expect(authTag).toBeDefined();
    authTag!.click();
    await settle();
    expect(target.textContent).toContain('Fix login redirect');
    expect(target.textContent).not.toContain('Verify cookie flags');

    // Clear tag filter via "All".
    buttonNamed(target, 'All')!.click();
    await settle();
    expect(target.textContent).toContain('Verify cookie flags');

    // Text filter matches K-2.
    const filterInput = target.querySelector<HTMLInputElement>('input[aria-label="Filter tickets"]')!;
    filterInput.value = 'cookie';
    filterInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
    expect(target.textContent).not.toContain('Fix login redirect');
    expect(target.textContent).toContain('Verify cookie flags');

    // Clear text filter before creating so K-3 shows once added.
    buttonNamed(target, 'Clear filter')!.click();
    await settle();

    // Create a new ticket through the sheet.
    buttonNamed(target, 'New ticket')!.click();
    await settle();
    const titleInput = document.querySelector<HTMLInputElement>('input[placeholder="Short imperative title"]')!;
    titleInput.value = 'Add web tests';
    titleInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const createBtn = buttonNamed(document.body, 'Create')!;
    createBtn.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    await settle();

    expect(kanbanApi.add).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/work/alpha',
      title: 'Add web tests',
    }));
    expect(target.textContent).toContain('K-3');
  });

  it('offers Create board when board.json does not exist yet', async () => {
    vi.mocked(kanbanApi.board).mockResolvedValue({
      version: 1,
      next_id: 1,
      columns: ['todo', 'doing', 'review', 'done'],
      tickets: [],
      cwd: '/work/empty',
      path: '/work/empty/.omp/kanban/board.json',
      exists: false,
    });
    nav.kanbanCwd = '/work/empty';
    const { target } = render(KanbanView, {});
    await settle();
    await settle();

    expect(target.textContent).toContain('No kanban board in this project yet.');
    buttonNamed(target, 'Create board')!.click();
    await settle();
    expect(kanbanApi.init).toHaveBeenCalledWith('/work/empty');
  });
});
