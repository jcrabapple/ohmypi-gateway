import type { SavedSession, SessionInfo, SlashCommand } from '../../api/types';

export function session(gwId: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    gwId, cwd: `/work/${gwId}`, approvalMode: 'yolo', resumedFrom: null, ompSessionId: null, ompSessionFile: null,
    ompSessionName: null, model: null, thinkingLevel: null, isStreaming: false, idleSec: 0, exited: false,
    exitCode: null, protocolVersion: null, uptimeSec: 0, subscribers: 0, messageCount: 0,
    contextUsage: null, lastEventSeq: 0, pendingUi: [], ...over,
  };
}

export function saved(file: string, title: string, over: Partial<SavedSession> = {}): SavedSession {
  return { file, mtime: 1_700_000_000, sizeBytes: 1, cwdFolder: '-work-x', title, running: false, ...over };
}

export function command(name: string, description = '', over: Partial<SlashCommand> = {}): SlashCommand {
  return { name, description, source: 'builtin', ...over };
}
