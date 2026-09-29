import type { ApprovalMode } from '../api/types';

export const APPROVAL_MODES: readonly { id: ApprovalMode; label: string; hint: string }[] = [
  { id: 'yolo', label: 'Yolo', hint: 'runs tools without asking' },
  { id: 'write', label: 'Write', hint: 'asks before edits and commands' },
  { id: 'always-ask', label: 'Always ask', hint: 'asks before every tool' },
];

export function approvalLabel(mode: string | null | undefined): string {
  return APPROVAL_MODES.find((m) => m.id === mode)?.label ?? 'Yolo';
}

/** Levels the running model accepts: `off` plus its own efforts, in the order it reports them. */
export function thinkingChoices(efforts: readonly string[] | null | undefined): string[] {
  if (!efforts?.length) return [];
  return ['off', ...efforts.filter((e) => e !== 'off')];
}
