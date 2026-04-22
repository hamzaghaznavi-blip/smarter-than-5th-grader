/** Crash-safe session log: localStorage + optional .txt download (browser cannot write arbitrary paths). */

import type { GameState, Subject } from './types';

/** Older sessions stored renamed/removed category strings. */
const LEGACY_SUBJECT_MAP: Record<string, Subject> = {
  Geography: 'World Geography',
  'Sub-continent History': 'World History',
  Cricket: 'NBA',
  'Pop Culture & Sex Ed': 'Pop Culture',
  Maths: 'Stats & Maths',
  Tech: 'FinTech',
};

function migrateSubjectField(value: string | null | undefined): Subject | null {
  if (value == null || value === '') return null;
  return LEGACY_SUBJECT_MAP[value] ?? (value as Subject);
}

export const SESSION_STORAGE_KEY = 'smarter-than-5th-grader-session-v1';

export type SerializedGameState = Omit<GameState, 'usedQuestionIds'> & { usedQuestionIds: string[] };

export type PersistedSession = {
  sessionName: string;
  startedAt: number;
  updatedAt: number;
  logLines: string[];
  gameState: SerializedGameState;
};

export function serializeGameState(gs: GameState): SerializedGameState {
  return { ...gs, usedQuestionIds: [...gs.usedQuestionIds] };
}

export function deserializeGameState(s: SerializedGameState): GameState {
  const currentSubject = migrateSubjectField(s.currentSubject as unknown as string);
  const currentQuestion = s.currentQuestion
    ? {
        ...s.currentQuestion,
        subject: migrateSubjectField(s.currentQuestion.subject as unknown as string) ?? s.currentQuestion.subject,
      }
    : null;

  return {
    ...s,
    currentSubject,
    currentQuestion,
    presentationMode: s.presentationMode === 'informal' ? 'informal' : 'formal',
    usedQuestionIds: new Set(s.usedQuestionIds),
    players: s.players.map((p) => ({
      ...p,
      giftsEarned: (p as unknown as { giftsEarned?: number }).giftsEarned ?? 0,
      hasUsedUneesBees: p.hasUsedUneesBees ?? false,
    })),
  };
}

export function randomSessionName(): string {
  const part = () => Math.random().toString(36).slice(2, 8);
  return `show-${part()}-${part()}`;
}

export function loadPersistedSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
}

export function savePersistedSession(data: PersistedSession): void {
  try {
    data.updatedAt = Date.now();
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // quota / private mode
  }
}

export function clearPersistedSession(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function appendLogLine(session: PersistedSession, line: string): void {
  session.logLines.push(`${new Date().toISOString()}  ${line}`);
  if (session.logLines.length > 5000) {
    session.logLines = session.logLines.slice(-4000);
  }
}

export function buildTextFileContent(session: PersistedSession): string {
  const header = [
    `Game session: ${session.sessionName}`,
    `Started: ${new Date(session.startedAt).toISOString()}`,
    `Last updated: ${new Date(session.updatedAt).toISOString()}`,
    '---',
    '',
  ].join('\n');
  return header + session.logLines.join('\n');
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
