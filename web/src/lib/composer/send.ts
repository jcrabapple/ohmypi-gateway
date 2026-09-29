// Which prompt mode a send uses, decided by whether the agent is running.
import type { PromptMode } from '../api/endpoints';

export interface SendPlan {
  primary: { mode: PromptMode; label: string };
  /** Only while streaming: queue the message for after the turn. */
  secondary: { mode: PromptMode; label: string } | null;
}

export function sendPlan(streaming: boolean): SendPlan {
  return streaming
    ? { primary: { mode: 'steer', label: 'Steer' }, secondary: { mode: 'follow_up', label: 'Queue' } }
    : { primary: { mode: 'prompt', label: 'Send' }, secondary: null };
}

/** Enter sends the primary action; Ctrl/Cmd+Enter queues while streaming. */
export function modeForKey(streaming: boolean, queueModifier: boolean): PromptMode {
  const plan = sendPlan(streaming);
  return queueModifier && plan.secondary ? plan.secondary.mode : plan.primary.mode;
}
