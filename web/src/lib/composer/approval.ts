// Answering a blocking extension dialog, and how its options are presented.
import { ApiError } from '../api/client';
import type { UiAnswer, UiRequest } from '../api/types';
import { active } from '../state/active.svelte';
import { ui } from '../state/ui.svelte';
import { tap } from '../platform/haptics';

export type OptionTone = 'approve' | 'deny' | 'neutral';

const APPROVE = /^(allow|approve|accept|yes|ok|okay|run|proceed|continue|confirm|apply|trust)\b/i;
const DENY = /^(deny|reject|refuse|block|decline|no|cancel|skip|abort|stop)\b/i;

export function optionTone(label: string): OptionTone {
  const s = label.trim();
  if (APPROVE.test(s)) return 'approve';
  if (DENY.test(s)) return 'deny';
  return 'neutral';
}

/** First line is the headline; the rest is the command or path, shown in a mono block. */
export function splitTitle(title: string | undefined): { headline: string; detail: string } {
  const lines = (title ?? '').replace(/\r\n/g, '\n').split('\n');
  const headline = (lines.shift() ?? '').trim();
  return { headline, detail: lines.join('\n').trim() };
}

export function editorStart(req: Pick<UiRequest, 'prefill' | 'text'>): string {
  return typeof req.prefill === 'string' ? req.prefill : typeof req.text === 'string' ? req.text : '';
}

export type AnswerOutcome = 'answered' | 'dropped' | 'failed';

/**
 * Send the answer. A 409 means someone else answered first (or the request timed out), so the
 * dialog is dropped without a word. Other errors are shown and the dialog stays.
 */
export async function submitAnswer(req: Pick<UiRequest, 'id'>, answer: UiAnswer): Promise<AnswerOutcome> {
  tap();
  try {
    await active.answerUi(req.id, answer);
    active.dropUi(req.id);
    return 'answered';
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      active.dropUi(req.id);
      return 'dropped';
    }
    ui.error(e instanceof Error ? e.message : 'Could not send your answer');
    return 'failed';
  }
}
