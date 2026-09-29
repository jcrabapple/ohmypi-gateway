import { afterEach, describe, expect, it } from 'vitest';
import type { FileChange } from '../../lib/render/diff2';
import type { ToolItem } from '../../lib/transcript/types';
import ToolGroup from '../items/ToolGroup.svelte';
import { cleanup, render, settle } from './mount';

const file: FileChange = {
  path: 'src/greeter.py',
  op: 'update',
  diff: ' 1|alpha\n-2|beta\n+2|delta\n 3|gamma',
  adds: 1,
  dels: 1,
  created: false,
};

const editor: ToolItem = {
  kind: 'tool',
  id: 'tool:e1',
  toolCallId: 'e1',
  toolName: 'edit',
  args: { path: 'src/greeter.py' },
  summary: 'src/greeter.py',
  output: 'Edited src/greeter.py',
  status: 'done',
  files: [file, { ...file, path: 'src/other.py', adds: 3 }],
};

const runner: ToolItem = {
  kind: 'tool',
  id: 'tool:b1',
  toolCallId: 'b1',
  toolName: 'bash',
  args: { command: 'ls' },
  summary: 'ls',
  output: 'src\nREADME.md',
  status: 'done',
};

afterEach(cleanup);

describe('ToolGroup file changes', () => {
  it('shows a +n -m stat chip when the tool changed files', () => {
    const { target } = render(ToolGroup, { tools: [editor] });
    const stat = target.querySelector('.stat')!;
    expect(stat.textContent).toContain('+4');
    expect(stat.textContent).toContain('-2');
  });

  it('renders diff blocks instead of the raw output for file tools', async () => {
    const { target } = render(ToolGroup, { tools: [editor] });
    (target.querySelector('button.line') as HTMLButtonElement).click();
    await settle();
    expect(target.querySelectorAll('.block').length).toBe(2);
    expect(target.querySelector('pre.out')).toBeNull();
  });

  it('keeps the plain output and no chip for tools without files', async () => {
    const { target } = render(ToolGroup, { tools: [runner] });
    expect(target.querySelector('.stat')).toBeNull();
    (target.querySelector('button.line') as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector('pre.out')).not.toBeNull();
    expect(target.querySelector('.block')).toBeNull();
  });

  it('falls back to the plain output and hides the stat chip when the tool failed', async () => {
    const { target } = render(ToolGroup, { tools: [{ ...editor, status: 'error' }] });
    expect(target.querySelector('.stat')).toBeNull();
    (target.querySelector('button.line') as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector('pre.out')).not.toBeNull();
    expect(target.querySelector('.block')).toBeNull();
  });
});
