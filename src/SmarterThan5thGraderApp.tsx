import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Trophy,
  Trash2,
  Home,
  Settings2,
  Plus,
  Crown,
  Zap,
  Star,
  Flag,
  Laugh,
  Link2,
  Gift,
} from 'lucide-react';

/** Lazy-load confetti so initial JS stays smaller and main thread work is deferred. */
function fireConfetti(opts: {
  particleCount?: number;
  spread?: number;
  origin?: { x?: number; y?: number };
  colors?: string[];
}) {
  void import('canvas-confetti').then(({ default: confetti }) => {
    confetti(opts);
  });
}

import { cn } from './lib/utils';
import type { GameState, Grade, Player, Prize, PresentationMode, Question, Subject } from './types';
import { pickRandomInformalRoast } from './informalRoasts';
import { cancelInformalSpeech, speakInformalRoast, warmupSpeechSynthesis } from './informalRoastVoice';
import { playWrongAnswerSound } from './wrongAnswerSound';
import {
  appendLogLine,
  buildTextFileContent,
  clearPersistedSession,
  deserializeGameState,
  downloadTextFile,
  loadPersistedSession,
  randomSessionName,
  savePersistedSession,
  serializeGameState,
  type PersistedSession,
} from './gameSessionLog';

const SUBJECTS: Subject[] = [
  'Stats & Maths',
  'World History',
  'World Geography',
  'World Religion & Mythology',
  'General Science',
  'NBA',
  'NHL',
  'Pop Culture',
  'Canadian History',
  'Sports',
  'World Politics',
  'FinTech',
];

const GRADES: Grade[] = [1, 2, 3, 4, 5, 6];
const QUESTIONS_PER_SUBJECT = 5;

/** Grades 1–3: full clock. Grades 4–6: rapid-fire round. Fast pacing. */
const TIMER_SECONDS_RELAXED = 14;
const TIMER_SECONDS_RAPID = 6;

/**
 * Informal mode is implemented but not publicly exposed yet.
 * Flip this to `true` later to re-enable: mode selector, mode URLs, and voice roasts.
 */
const ENABLE_INFORMAL_MODE = false;

function readInitialPresentationMode(): PresentationMode {
  if (!ENABLE_INFORMAL_MODE) return 'formal';
  if (typeof window === 'undefined') return 'formal';
  try {
    const m = new URLSearchParams(window.location.search).get('mode');
    if (m === 'informal') return 'informal';
    if (m === 'formal') return 'formal';
  } catch {
    /* ignore */
  }
  return 'formal';
}

function shareUrlForMode(mode: PresentationMode): string {
  if (typeof window === 'undefined') return '';
  const u = new URL(window.location.href);
  u.searchParams.set('mode', mode);
  u.hash = '';
  return u.href;
}

function secondsForGrade(grade: Grade | null | undefined): number {
  if (grade == null) return TIMER_SECONDS_RELAXED;
  return grade >= 4 ? TIMER_SECONDS_RAPID : TIMER_SECONDS_RELAXED;
}

const PRIZE_TABLE: Prize[] = [
  { id: 'p1', name: 'Golden Pen', description: 'A high-quality writing instrument.' },
  { id: 'p2', name: 'Smart Watch', description: 'A sleek digital companion.' },
  { id: 'p3', name: 'Gift Card', description: 'A $20 shopping spree.' },
  { id: 'p4', name: 'Chocolate Box', description: 'Premium assorted treats.' },
  { id: 'p5', name: 'Notebook', description: 'A leather-bound journal.' },
  { id: 'p6', name: 'Wireless Earbuds', description: 'Crystal clear sound.' },
  { id: 'p7', name: 'Coffee Mug', description: 'A custom-designed mug.' },
  { id: 'p8', name: 'Backpack', description: 'Durable and stylish.' },
];

import { getFactsForSubjectGrade, getQuestionPoolSize } from './questionBank';
import { WowAmbience, type WowMode } from './WowAmbience';

const toSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const deterministicShuffle = (items: string[], seed: number): string[] => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const j = state % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
};

const factIndexForPool = (subject: Subject, grade: Grade, index: number, poolLen: number): number => {
  const subjSalt =
    subject.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7) % 1009;
  const n = Math.max(1, poolLen);
  return (index + grade * 7919 + subjSalt) % n;
};

const createOfflineQuestion = (subject: Subject, grade: Grade, index: number): Question => {
  const facts = getFactsForSubjectGrade(subject, grade);
  const n = Math.max(1, facts.length);
  const fi = factIndexForPool(subject, grade, index, n);
  const fact = facts[fi];

  return {
    id: `${toSlug(subject)}-${grade}-${index}`,
    subject,
    grade,
    question: fact.clue,
    answer: fact.answer,
    options: deterministicShuffle([fact.answer, ...fact.distractors], index + grade * 1000),
  };
};

const questionIdForIndex = (subject: Subject, grade: Grade, index: number) =>
  `${toSlug(subject)}-${grade}-${index}`;

const pickRandomQuestion = (
  subject: Subject,
  grade: Grade,
  usedIds: Set<string>,
  mustDifferFromId?: string | null,
): Question => {
  const poolSize = getQuestionPoolSize(subject, grade);
  const candidates: number[] = [];
  for (let i = 0; i < poolSize; i += 1) {
    const id = questionIdForIndex(subject, grade, i);
    if (usedIds.has(id)) continue;
    if (mustDifferFromId && id === mustDifferFromId) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) {
    for (let i = 0; i < poolSize; i += 1) {
      const id = questionIdForIndex(subject, grade, i);
      if (mustDifferFromId && id === mustDifferFromId) continue;
      candidates.push(i);
    }
  }
  if (candidates.length === 0) {
    const i = Math.floor(Math.random() * poolSize);
    return createOfflineQuestion(subject, grade, i);
  }
  const idx = candidates[Math.floor(Math.random() * candidates.length)];
  return createOfflineQuestion(subject, grade, idx);
};

/** Grade N = N points. Chooser wrong: -1. Others wrong: 0. */
const pointsForCorrect = (grade: Grade): number => grade;
const CHOOSER_WRONG_PENALTY = -1;

const formatScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

type ScorePopup = { id: string; playerId: string; delta: number; timestamp: number };
type GiftNotice = { id: string; text: string; timestamp: number };

const SUBJECT_ICONS: Record<string, string> = {
  'Stats & Maths': '📊',
  'World History': '🏛️',
  'World Geography': '🌍',
  'World Religion & Mythology': '⛩️',
  'General Science': '🔬',
  'NBA': '🏀',
  'NHL': '🏒',
  'Pop Culture': '🎭',
  'Canadian History': '🍁',
  'Sports': '⚽',
  'World Politics': '🏛️',
  'FinTech': '💳',
};

/* ─── Timer Ring Component ─── */
const TimerRing = memo(function TimerRing({
  timeLeft,
  total = TIMER_SECONDS_RELAXED,
  variant = 'light',
}: {
  timeLeft: number;
  total?: number;
  variant?: 'dark' | 'light';
}) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(1, Math.max(0, timeLeft / total));
  const dashOffset = circumference * (1 - progress);
  const criticalAt = Math.max(1, Math.floor(total * 0.34));
  const warnAt = Math.max(criticalAt + 1, Math.ceil(total * 0.5));
  const isCritical = timeLeft <= criticalAt && timeLeft > 0;
  const isWarn = timeLeft <= warnAt && timeLeft > criticalAt;
  const trackStroke = variant === 'light' ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255,255,255,0.1)';

  return (
    <div className="relative flex items-center justify-center">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <g transform="rotate(-90 36 36)">
          <circle
            cx="36" cy="36" r={radius}
            fill="none"
            stroke={trackStroke}
            strokeWidth="4"
          />
          <circle
            cx="36" cy="36" r={radius}
            fill="none"
            stroke={isCritical ? '#EF4444' : isWarn ? '#F59E0B' : '#00FF88'}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="timer-ring"
          />
        </g>
      </svg>
      <span className={cn(
        'absolute text-xl font-black font-mono',
        isCritical ? 'text-red-600' : isWarn ? (variant === 'light' ? 'text-amber-700' : 'text-amber-glow') : variant === 'light' ? 'text-slate-900' : 'text-white',
      )}>
        {timeLeft}
      </span>
    </div>
  );
});

/* ─── Leaderboard Component ─── */
const Leaderboard = memo(function Leaderboard({
  players,
  showSubjectScore = false,
}: {
  players: Player[];
  showSubjectScore?: boolean;
}) {
  const sorted = useMemo(
    () => [...players].sort((a, b) => b.totalScore - a.totalScore),
    [players],
  );
  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div className="space-y-2">
      {sorted.map((p, i) => (
        <div
          key={p.id}
          className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-xl border transition-all shadow-sm',
            i === 0 ? 'bg-amber-50 border-amber-300' :
            i === 1 ? 'bg-slate-100 border-slate-300' :
            i === 2 ? 'bg-orange-50 border-orange-200' :
            'bg-white border-slate-200',
          )}
        >
          <span className="text-2xl w-8 text-center">{medals[i] ?? `${i + 1}.`}</span>
          <span className="flex-1 font-black text-lg uppercase tracking-tight text-slate-900">{p.name}</span>
          <div className="text-right">
            <span className="text-xl font-black font-mono text-emerald-700 tabular-nums">{formatScore(p.totalScore)}</span>
            {showSubjectScore && (
              <span className="block text-xs font-mono text-slate-500">round: {formatScore(p.subjectScore)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

/* ─── Score Popup Float ─── */
const ScoreFloat = memo(function ScoreFloat({ popup }: { popup: ScorePopup }) {
  return (
    <div className="score-popup fixed top-1/3 left-1/2 z-[100] -translate-x-1/2">
      <span className={cn(
        'text-5xl font-display drop-shadow-[0_2px_8px_rgba(0,0,0,0.35)]',
        popup.delta > 0 ? 'text-emerald-600' : 'text-red-600',
      )}>
        {popup.delta > 0 ? `+${formatScore(popup.delta)}` : formatScore(popup.delta)}
      </span>
    </div>
  );
});

/* ─── Progress Dots ─── */
const ProgressDots = memo(function ProgressDots({
  current,
  total,
  variant = 'light',
}: {
  current: number;
  total: number;
  variant?: 'dark' | 'light';
}) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-3 w-3 rounded-full transition-[background-color,transform] duration-300',
            i < current ? 'scale-100 bg-neon-green' : variant === 'light' ? 'scale-75 bg-slate-300' : 'scale-75 bg-[#4b5563]',
          )}
        />
      ))}
      <span className={cn(
        'ml-2 font-mono text-xs font-semibold',
        variant === 'light' ? 'text-slate-600' : 'text-[#c4cad6]',
      )}>{current}/{total}</span>
    </div>
  );
});

export default function SmarterThan5thGraderApp() {
  const [gameState, setGameState] = useState<GameState>(() => ({
    players: [],
    categoryChooserId: null,
    currentSubject: null,
    currentGrade: null,
    currentQuestion: null,
    gamePhase: 'SETUP',
    prizes: PRIZE_TABLE,
    selectedPrize: null,
    usedQuestionIds: new Set<string>(),
    questionsAnsweredInSubject: 0,
    hiddenOptions: [],
    presentationMode: ENABLE_INFORMAL_MODE ? readInitialPresentationMode() : 'formal',
  }));

  const [newPlayerName, setNewPlayerName] = useState('');
  const [showAnswer, setShowAnswer] = useState(false);
  const [timeLeft, setTimeLeft] = useState(30);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [selectedGrade, setSelectedGrade] = useState<Grade | null>(null);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const persistedSessionRef = useRef<PersistedSession | null>(null);
  const [resumeOffered, setResumeOffered] = useState(false);
  const [resumeSessionName, setResumeSessionName] = useState<string | null>(null);
  const [hostRevealAll, setHostRevealAll] = useState(false);
  const [scorePopups, setScorePopups] = useState<ScorePopup[]>([]);
  const [giftNotices, setGiftNotices] = useState<GiftNotice[]>([]);
  const [hostPanelOpen, setHostPanelOpen] = useState(false);
  const [customAdjust, setCustomAdjust] = useState<Record<string, string>>({});
  /** Informal mode: random Urdu roast line (G4–6) after wrong answer */
  const [informalRoast, setInformalRoast] = useState<string | null>(null);

  useEffect(() => {
    if (!informalRoast) return;
    const t = window.setTimeout(() => setInformalRoast(null), 5200);
    return () => window.clearTimeout(t);
  }, [informalRoast]);

  /** Bookmarkable Formal / Informal entry (setup only). */
  useEffect(() => {
    if (!ENABLE_INFORMAL_MODE) return;
    if (gameState.gamePhase !== 'SETUP') return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('mode', gameState.presentationMode);
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* ignore */
    }
  }, [gameState.presentationMode, gameState.gamePhase]);

  const resetQuestionUI = useCallback(() => {
    setHostRevealAll(false);
  }, []);

  useEffect(() => {
    const saved = loadPersistedSession();
    if (saved?.gameState && saved.sessionName) {
      persistedSessionRef.current = saved;
      requestAnimationFrame(() => {
        setResumeOffered(true);
        setResumeSessionName(saved.sessionName);
      });
    }
  }, []);

  /** One interval while running — do NOT depend on `timeLeft` or the timer resets every second. */
  useEffect(() => {
    if (!isTimerRunning) return;
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setIsTimerRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isTimerRunning]);

  const persistNow = useCallback((gs: GameState, name: string | null) => {
    if (!name || !persistedSessionRef.current) return;
    const s = persistedSessionRef.current;
    s.gameState = serializeGameState(gs);
    savePersistedSession(s);
  }, []);

  const gameStateForPersistRef = useRef(gameState);
  useEffect(() => {
    gameStateForPersistRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    if (!sessionName) return;
    const id = window.setTimeout(() => {
      persistNow(gameStateForPersistRef.current, sessionName);
    }, 280);
    return () => {
      window.clearTimeout(id);
    };
  }, [gameState, sessionName, persistNow]);

  useEffect(() => {
    const onLeave = () => {
      if (sessionName && persistedSessionRef.current) {
        persistedSessionRef.current.gameState = serializeGameState(gameState);
        savePersistedSession(persistedSessionRef.current);
      }
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [gameState, sessionName]);

  const logScoreEvent = useCallback((line: string) => {
    if (!persistedSessionRef.current) return;
    appendLogLine(persistedSessionRef.current, line);
    savePersistedSession(persistedSessionRef.current);
  }, []);

  /** Log a full scoreboard snapshot */
  const logScoreSnapshot = useCallback((players: Player[], context: string) => {
    if (!persistedSessionRef.current) return;
    const board = players.map((p) => `${p.name}=${formatScore(p.totalScore)}`).join(', ');
    appendLogLine(persistedSessionRef.current, `[SNAPSHOT ${context}] ${board}`);
    savePersistedSession(persistedSessionRef.current);
  }, []);

  /** Each time a new question appears: snapshot scores to log + flush autosave (session must be started). */
  useEffect(() => {
    const gs = gameStateForPersistRef.current;
    if (gs.gamePhase !== 'QUESTION' || !gs.currentQuestion) return;
    const subj = gs.currentSubject ?? '?';
    const grade = gs.currentGrade ?? 1;
    const qid = gs.currentQuestion.id;
    logScoreSnapshot(gs.players, `Q on screen: ${subj} G${grade} [${qid}]`);
    if (sessionName) persistNow(gs, sessionName);
  }, [gameState.currentQuestion?.id, gameState.gamePhase, sessionName, logScoreSnapshot, persistNow]);

  const showScorePopup = useCallback((playerId: string, delta: number) => {
    const popup: ScorePopup = {
      id: Math.random().toString(36).slice(2, 9),
      playerId,
      delta,
      timestamp: Date.now(),
    };
    setScorePopups((prev) => [...prev, popup]);
    setTimeout(() => {
      setScorePopups((prev) => prev.filter((p) => p.id !== popup.id));
    }, 1500);
  }, []);

  const pushGiftNotice = useCallback((text: string) => {
    const n: GiftNotice = { id: Math.random().toString(36).slice(2, 9), text, timestamp: Date.now() };
    setGiftNotices((prev) => [...prev, n]);
    window.setTimeout(() => setGiftNotices((prev) => prev.filter((x) => x.id !== n.id)), 4200);
  }, []);

  const addPlayer = useCallback(() => {
    if (newPlayerName.trim() && gameState.players.length < 7) {
      const newPlayer: Player = {
        id: Math.random().toString(36).slice(2, 11),
        name: newPlayerName.trim(),
        totalScore: 0,
        subjectScore: 0,
        giftsEarned: 0,
        hasUsedUneesBees: false,
      };
      setGameState((prev) => ({ ...prev, players: [...prev.players, newPlayer] }));
      setNewPlayerName('');
    }
  }, [newPlayerName, gameState.players.length]);

  const selectGrade = useCallback((grade: Grade) => {
    if (!gameState.currentSubject) return;
    setSelectedGrade(grade);

    setGameState((prev) => {
      const q = pickRandomQuestion(prev.currentSubject!, grade, prev.usedQuestionIds);
      return {
        ...prev,
        currentGrade: grade,
        currentQuestion: q,
        gamePhase: 'QUESTION',
        usedQuestionIds: new Set(prev.usedQuestionIds).add(q.id),
        hiddenOptions: [],
      };
    });
    setShowAnswer(false);
    resetQuestionUI();
    setTimeLeft(secondsForGrade(grade));
    setIsTimerRunning(true);
    setHostPanelOpen(false);
  }, [gameState.currentSubject, resetQuestionUI]);

  const nextQuestionSameRound = useCallback(() => {
    setGameState((prev) => {
      if (!prev.currentSubject || !prev.currentGrade) return prev;
      const q = pickRandomQuestion(
        prev.currentSubject,
        prev.currentGrade,
        prev.usedQuestionIds,
        prev.currentQuestion?.id,
      );
      return {
        ...prev,
        currentQuestion: q,
        usedQuestionIds: new Set(prev.usedQuestionIds).add(q.id),
        hiddenOptions: [],
      };
    });
    setShowAnswer(false);
    resetQuestionUI();
    setTimeLeft(secondsForGrade(gameState.currentGrade));
    setIsTimerRunning(true);
    logScoreEvent('Next question (random)');
  }, [resetQuestionUI, logScoreEvent, gameState.currentGrade]);

  const alternateQuestion = useCallback(() => {
    setGameState((prev) => {
      if (!prev.currentSubject || !prev.currentGrade || !prev.currentQuestion) return prev;
      const q = pickRandomQuestion(
        prev.currentSubject,
        prev.currentGrade,
        prev.usedQuestionIds,
        prev.currentQuestion.id,
      );
      return {
        ...prev,
        currentQuestion: q,
        usedQuestionIds: new Set(prev.usedQuestionIds).add(q.id),
        hiddenOptions: [],
      };
    });
    setShowAnswer(false);
    resetQuestionUI();
    setTimeLeft(secondsForGrade(gameState.currentGrade));
    setIsTimerRunning(true);
    logScoreEvent('Alternate question (different prompt)');
  }, [resetQuestionUI, logScoreEvent, gameState.currentGrade]);

  const handleScore = useCallback((playerId: string, isCorrect: boolean) => {
    const grade = gameState.currentGrade ?? 1;
    const isCategoryChooser = playerId === gameState.categoryChooserId;
    const pts = pointsForCorrect(grade);

    if (isCorrect) {
      fireConfetti({ particleCount: 42, spread: 58, origin: { y: 0.6 }, colors: ['#00FF88', '#3B82F6', '#F59E0B'] });
    }
    if (ENABLE_INFORMAL_MODE && !isCorrect && gameState.presentationMode === 'informal') {
      cancelInformalSpeech();
      playWrongAnswerSound({ loud: true });
      if (grade >= 4) {
        const roast = pickRandomInformalRoast();
        setInformalRoast(roast.text);
        window.setTimeout(() => {
          speakInformalRoast(roast.text, roast.voice);
        }, 140);
      }
    }

    setIsTimerRunning(false);

    const playerName = gameState.players.find((p) => p.id === playerId)?.name ?? playerId;
    const prevTotal = gameState.players.find((p) => p.id === playerId)?.totalScore ?? 0;
    let scoreChange = 0;
    if (isCorrect) {
      logScoreEvent(`${playerName}: CORRECT (+${pts}) [grade ${grade}]`);
      scoreChange = pts;
    } else if (isCategoryChooser) {
      logScoreEvent(`${playerName}: WRONG (${CHOOSER_WRONG_PENALTY}) [chooser]`);
      scoreChange = CHOOSER_WRONG_PENALTY;
    } else {
      logScoreEvent(`${playerName}: WRONG (0) [non-chooser]`);
    }

    showScorePopup(playerId, scoreChange);

    // Gift milestones: every 20 total points earns 1 gift (40 = 2 gifts, etc.)
    const nextTotal = prevTotal + scoreChange;
    const prevMilestones = Math.floor(prevTotal / 20);
    const nextMilestones = Math.floor(nextTotal / 20);
    if (nextMilestones > prevMilestones) {
      const gained = nextMilestones - prevMilestones;
      const msg = `${playerName} earned ${gained} gift${gained === 1 ? '' : 's'}! Total gifts: ${nextMilestones}`;
      pushGiftNotice(msg);
      logScoreEvent(`[GIFT] ${msg}`);
    }

    setGameState((prev) => {
      const newPlayers = prev.players.map((p) => {
        if (p.id !== playerId) return p;
        const newTotal = p.totalScore + scoreChange;
        const newGifts = Math.max(p.giftsEarned ?? 0, Math.floor(newTotal / 20));
        return {
          ...p,
          totalScore: newTotal,
          subjectScore: p.subjectScore + scoreChange,
          giftsEarned: newGifts,
        };
      });

      const nextQuestionsAnswered = prev.questionsAnsweredInSubject + 1;

      // Autosave score snapshot after every scoring event
      logScoreSnapshot(newPlayers, `Q${nextQuestionsAnswered} ${prev.currentSubject} G${grade}`);

      if (nextQuestionsAnswered >= QUESTIONS_PER_SUBJECT) {
        return {
          ...prev,
          players: newPlayers,
          gamePhase: 'SUBJECT_RESULTS',
          questionsAnsweredInSubject: nextQuestionsAnswered,
          hiddenOptions: [],
        };
      }

      return {
        ...prev,
        players: newPlayers,
        gamePhase: 'GRADE_SELECTION',
        questionsAnsweredInSubject: nextQuestionsAnswered,
        currentQuestion: null,
        hiddenOptions: [],
      };
    });
    setShowAnswer(false);
    setSelectedGrade(null);
  }, [
    gameState.currentGrade,
    gameState.categoryChooserId,
    gameState.players,
    gameState.presentationMode,
    logScoreEvent,
    logScoreSnapshot,
    pushGiftNotice,
    showScorePopup,
  ]);

  const activateUneesBees = useCallback((playerId: string) => {
    const q = gameState.currentQuestion;
    if (!q) return;
    const p = gameState.players.find((x) => x.id === playerId);
    if (!p || p.hasUsedUneesBees === true) return;

    const wrong = q.options.filter((opt) => opt !== q.answer);
    const shuffled = [...wrong].sort(() => Math.random() - 0.5);
    const toHide = shuffled.slice(0, 2);

    setGameState((prev) => ({
      ...prev,
      players: prev.players.map((pl) => (pl.id === playerId ? { ...pl, hasUsedUneesBees: true } : pl)),
      hiddenOptions: toHide,
    }));
  }, [gameState.currentQuestion, gameState.players]);

  const resetGame = useCallback(() => {
    clearPersistedSession();
    persistedSessionRef.current = null;
    setSessionName(null);
    setGameState({
      players: [],
      categoryChooserId: null,
      currentSubject: null,
      currentGrade: null,
      currentQuestion: null,
      gamePhase: 'SETUP',
      prizes: PRIZE_TABLE,
      selectedPrize: null,
      usedQuestionIds: new Set<string>(),
      questionsAnsweredInSubject: 0,
      hiddenOptions: [],
      presentationMode: 'formal',
    });
  }, []);

  const endGame = useCallback(() => {
    logScoreEvent('=== GAME OVER ===');
    logScoreSnapshot(gameState.players, 'FINAL');
    fireConfetti({ particleCount: 72, spread: 90, origin: { y: 0.4 }, colors: ['#00FF88', '#3B82F6', '#F59E0B', '#EC4899', '#8B5CF6'] });
    setGameState((prev) => ({
      ...prev,
      gamePhase: 'GAME_OVER',
      currentQuestion: null,
      currentSubject: null,
      currentGrade: null,
    }));
    setIsTimerRunning(false);
  }, [gameState.players, logScoreEvent, logScoreSnapshot]);

  const resumeSession = useCallback(() => {
    const s = persistedSessionRef.current ?? loadPersistedSession();
    if (!s) return;
    persistedSessionRef.current = s;
    setSessionName(s.sessionName);
    setGameState(deserializeGameState(s.gameState));
    setResumeOffered(false);
  }, []);

  const dismissResume = useCallback(() => {
    setResumeOffered(false);
    clearPersistedSession();
    persistedSessionRef.current = null;
  }, []);

  const exportSessionLog = useCallback(() => {
    const s = persistedSessionRef.current ?? loadPersistedSession();
    if (!s) return;
    const text = buildTextFileContent(s);
    downloadTextFile(`${s.sessionName}.txt`, text);
  }, []);

  const hostAdjustTotal = useCallback((playerId: string, delta: number) => {
    const name = gameState.players.find((p) => p.id === playerId)?.name ?? playerId;
    logScoreEvent(`HOST ADJUST total: ${name} ${delta >= 0 ? '+' : ''}${delta}`);
    showScorePopup(playerId, delta);
    setGameState((prev) => ({
      ...prev,
      players: prev.players.map((p) =>
        p.id === playerId ? { ...p, totalScore: Math.max(0, p.totalScore + delta) } : p,
      ),
    }));
    logScoreSnapshot(
      gameState.players.map((p) =>
        p.id === playerId ? { ...p, totalScore: Math.max(0, p.totalScore + delta) } : p,
      ),
      'HOST-ADJUST',
    );
  }, [gameState.players, logScoreEvent, logScoreSnapshot, showScorePopup]);

  const handleCustomAdjust = useCallback((playerId: string) => {
    const val = parseInt(customAdjust[playerId] ?? '0', 10);
    if (isNaN(val) || val === 0) return;
    hostAdjustTotal(playerId, val);
    setCustomAdjust((prev) => ({ ...prev, [playerId]: '' }));
  }, [customAdjust, hostAdjustTotal]);

  const subjectWinner = useMemo(
    () => [...gameState.players].sort((a, b) => b.subjectScore - a.subjectScore)[0],
    [gameState.players],
  );

  const sortedPlayers = useMemo(
    () => [...gameState.players].sort((a, b) => b.totalScore - a.totalScore),
    [gameState.players],
  );

  const chooserName = useMemo(
    () => gameState.players.find((p) => p.id === gameState.categoryChooserId)?.name,
    [gameState.players, gameState.categoryChooserId],
  );

  /** Visual-only “game show” ambience — does not affect gameplay. */
  const wowMode = useMemo((): WowMode => {
    if (gameState.gamePhase === 'QUESTION') return 'question';
    if (gameState.gamePhase === 'GAME_OVER' || gameState.gamePhase === 'SUBJECT_RESULTS') {
      return 'finale';
    }
    return 'idle';
  }, [gameState.gamePhase]);

  return (
    <div className="min-h-[100dvh] bg-slate-100 text-slate-900 font-sans relative">
      <WowAmbience mode={wowMode} />

      {scorePopups.map((p) => (
        <ScoreFloat key={p.id} popup={p} />
      ))}

      {/* Gift milestone notices */}
      {giftNotices.slice(-2).map((n) => (
          <div
            key={n.id}
            role="status"
            className="fixed top-24 left-1/2 z-[92] w-[min(92vw,34rem)] -translate-x-1/2 px-5 py-4 rounded-2xl border-2 border-amber-400 bg-white shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-100 border border-amber-300 flex items-center justify-center shrink-0">
                <Gift className="w-5 h-5 text-amber-700" aria-hidden />
              </div>
              <div>
                <p className="text-base sm:text-lg font-black text-slate-900 leading-snug">{n.text}</p>
                <p className="text-[10px] font-mono text-slate-500 mt-1 uppercase tracking-wider">Host gift milestone · every +20 points</p>
              </div>
            </div>
          </div>
        ))}

      {/* Informal mode: roast line (G4–6 wrong answers) */}
      {informalRoast && (
          <div
            key={informalRoast}
            role="status"
            className="fixed bottom-8 left-1/2 z-[95] w-[min(92vw,28rem)] -translate-x-1/2 px-5 py-4 rounded-2xl border-2 border-pink-400 bg-pink-50 shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
          >
            <p className="flex items-start gap-3 text-left">
              <Laugh className="w-6 h-6 text-pink-600 shrink-0 mt-0.5" aria-hidden />
              <span className="text-lg sm:text-xl font-bold leading-snug text-slate-900" dir="auto">
                {informalRoast}
              </span>
            </p>
            <p className="text-[10px] font-mono text-slate-600 mt-2 uppercase tracking-wider">Informal · grades 4–6</p>
          </div>
        )}

      {/* Resume banner */}
      {resumeOffered && resumeSessionName && (
        <div
          className="relative z-50 bg-amber-50 border-b border-amber-300 px-6 py-4 flex flex-wrap items-center justify-between gap-3 max-w-7xl mx-auto"
        >
          <p className="font-mono text-sm font-bold text-amber-900">
            Recover previous game &quot;{resumeSessionName}&quot;?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resumeSession}
              className="px-5 py-2 bg-amber-500 text-white font-mono text-xs font-bold uppercase rounded-lg hover:bg-amber-600 transition-all"
            >
              Resume
            </button>
            <button
              type="button"
              onClick={dismissResume}
              className="px-5 py-2 bg-white text-slate-700 font-mono text-xs font-bold uppercase rounded-lg border border-slate-300 hover:bg-slate-50 transition-all"
            >
              Start fresh
            </button>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="border border-slate-200 bg-slate-50 p-3 rounded-xl">
                <Trophy className="w-7 h-7 text-emerald-600" />
              </div>
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full ring-2 ring-white" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl md:text-3xl font-display uppercase leading-none tracking-tight text-slate-900">
                Class Room Trivia Game
              </h1>
              <p className="text-[10px] sm:text-xs font-mono uppercase tracking-widest text-slate-500 font-bold mt-1">
                Smarter Than a 5th Grader
              </p>
              <p className="text-[10px] sm:text-xs font-mono uppercase tracking-widest text-emerald-700 font-bold mt-0.5">
                {ENABLE_INFORMAL_MODE && gameState.presentationMode === 'informal' ? (
                  <span className="text-pink-600">Informal · buzzer + voice roasts (G4–6)</span>
                ) : (
                  <span>Formal · silent scoring · executive mode</span>
                )}
              </p>
            </div>
          </div>

          {gameState.gamePhase !== 'SETUP' && (
            <div className="flex flex-wrap items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setHostPanelOpen((o) => !o)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 font-mono font-bold uppercase text-xs rounded-xl border transition-all',
                  hostPanelOpen
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-slate-100 text-slate-800 border-slate-300 hover:bg-slate-200',
                )}
              >
                <Settings2 className="w-4 h-4" />
                <span className="hidden sm:inline">Scores</span>
              </button>
              {sessionName && (
                <button
                  type="button"
                  onClick={exportSessionLog}
                  className="px-3 py-2 bg-slate-100 border border-slate-300 text-slate-800 font-mono font-bold uppercase text-xs rounded-xl hover:bg-slate-200 transition-all"
                >
                  Export
                </button>
              )}
              <button
                type="button"
                onClick={endGame}
                className="flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-300 text-red-700 font-mono font-bold uppercase text-xs rounded-xl hover:bg-red-100 transition-all"
              >
                <Flag className="w-4 h-4" />
                <span className="hidden sm:inline">End</span>
              </button>
              <button
                onClick={resetGame}
                className="flex items-center gap-2 px-3 py-2 bg-slate-100 border border-slate-300 text-slate-800 font-mono font-bold uppercase text-xs rounded-xl hover:bg-slate-200 transition-all"
              >
                <Home className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Live scoreboard strip — always light, large totals */}
        {gameState.gamePhase !== 'SETUP' && gameState.players.length > 0 && (
          <div className="max-w-7xl mx-auto px-6 pb-3 pt-2 border-t border-slate-100 bg-slate-50">
            <div className="flex flex-wrap gap-2">
              {sortedPlayers.map((p, i) => (
                <span
                  key={p.id}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-lg font-mono border shadow-sm px-4 py-2.5 text-sm sm:text-base font-black',
                    i === 0
                      ? 'bg-amber-100 border-amber-400 text-amber-950'
                      : 'bg-white border-slate-300 text-slate-900',
                  )}
                >
                  {i === 0 && <Crown className="shrink-0 w-4 h-4 text-amber-800" />}
                  <span className="uppercase tracking-tight">{p.name}</span>
                  <span className="tabular-nums text-emerald-700 text-lg sm:text-xl font-black">
                    {formatScore(p.totalScore)}
                  </span>
                  {p.giftsEarned > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-bold bg-amber-50 border-amber-300 text-amber-900">
                      <Gift className="w-3 h-3" aria-hidden />
                      {p.giftsEarned}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* ── Main ── */}
      <main
        className={cn(
          'relative z-10 mx-auto min-h-[100dvh] w-full max-w-6xl bg-transparent px-6 py-12 sm:py-16',
          hostPanelOpen && 'pb-[min(60vh,28rem)]',
        )}
      >
        {/* ── SETUP ── */}
          {gameState.gamePhase === 'SETUP' && (
            <div
              key="setup"
              className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center"
            >
              <div className="space-y-8">
                <div>
                  <h2
                    className="text-5xl sm:text-7xl md:text-8xl font-display uppercase leading-[0.88] tracking-tighter"
                  >
                    <span className="text-gradient">READY TO PLAY</span>
                  </h2>
                  <p className="text-slate-600 font-mono text-sm mt-5 max-w-lg leading-relaxed">
                    Add players, pick Formal or Informal, and run a fast-paced live quiz.
                    Grade 1 = 1pt → Grade 6 = 6pts. Sharp timers. Built for the big screen.
                  </p>
                </div>
                <div
                  className="flex items-center gap-4 p-4 rounded-xl bg-emerald-50 border border-emerald-200"
                >
                  <Zap className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <p className="font-mono text-xs font-bold text-emerald-900 uppercase">
                    11 subjects · 6 grades · 2 lifelines · 5,000+ questions · rapid rounds
                  </p>
                </div>
                <div
                  className="text-xs font-mono text-slate-500 space-y-1"
                >
                  <p>50/50: contestant picks two answers (once/game).</p>
                  <p>Chooser wrong: −1 pt. Others wrong: 0 pts.</p>
                </div>
              </div>

              <div
                className="bg-white border border-slate-200 rounded-3xl p-8 sm:p-10 space-y-8 shadow-xl shadow-slate-200/50 ring-1 ring-slate-100"
              >
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={newPlayerName}
                    onChange={(e) => setNewPlayerName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addPlayer()}
                    placeholder="Player name..."
                    className="flex-1 bg-slate-50 border border-slate-300 rounded-xl px-5 py-4 text-xl font-black text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-all"
                  />
                  <button
                    onClick={addPlayer}
                    className="bg-blue-600 text-white px-6 py-4 text-lg font-black uppercase rounded-xl hover:bg-blue-700 active:scale-95 transition-all"
                  >
                    <Plus className="w-6 h-6" />
                  </button>
                </div>

                <div className="space-y-3 max-h-[300px] overflow-y-auto">
                  {gameState.players.map((player, idx) => (
                      <div
                        key={player.id}
                        className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 group hover:bg-slate-100 transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-8 h-8 flex items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 text-white text-sm font-black">
                            {idx + 1}
                          </span>
                          <span className="text-xl font-black uppercase tracking-tight text-slate-900">{player.name}</span>
                        </div>
                        <button
                          onClick={() =>
                            setGameState((prev) => ({ ...prev, players: prev.players.filter((p) => p.id !== player.id) }))
                          }
                          className="text-slate-400 hover:text-red-600 transition-colors"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    ))}
                </div>

                {ENABLE_INFORMAL_MODE && (
                  <>
                    <div className="space-y-3">
                      <p className="text-xs font-mono font-bold uppercase text-slate-500 tracking-wider">Mode</p>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setGameState((prev) => ({ ...prev, presentationMode: 'formal' }))}
                          className={cn(
                            'py-4 px-4 rounded-xl border-2 font-mono text-xs font-bold uppercase transition-all',
                            gameState.presentationMode === 'formal'
                              ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                              : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300',
                          )}
                        >
                          Formal
                        </button>
                        <button
                          type="button"
                          onClick={() => setGameState((prev) => ({ ...prev, presentationMode: 'informal' }))}
                          className={cn(
                            'py-4 px-4 rounded-xl border-2 font-mono text-xs font-bold uppercase transition-all flex items-center justify-center gap-2',
                            gameState.presentationMode === 'informal'
                              ? 'border-pink-500 bg-pink-50 text-pink-800'
                              : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300',
                          )}
                        >
                          <Laugh className="w-4 h-4" />
                          Informal
                        </button>
                      </div>
                      <p className="text-[11px] font-mono text-slate-500 leading-relaxed">
                        Informal: loud buzzer + spoken roasts (Urdu male / Punjabi female mix, browser voices).
                        Grades 4–6. Formal: no sound.
                      </p>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-3">
                      <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-600">
                        <Link2 className="w-3.5 h-3.5" />
                        Direct links (bookmark or share)
                      </div>
                      <div className="space-y-1.5 text-[10px] font-mono text-slate-600 break-all leading-snug">
                        <p>
                          <span className="text-emerald-700 font-bold uppercase mr-1.5">Formal</span>
                          {shareUrlForMode('formal')}
                        </p>
                        <p>
                          <span className="text-pink-700 font-bold uppercase mr-1.5">Informal</span>
                          {shareUrlForMode('informal')}
                        </p>
                      </div>
                    </div>
                  </>
                )}

                <button
                  onClick={() => {
                    if (gameState.players.length < 1) return;
                    if (ENABLE_INFORMAL_MODE && gameState.presentationMode === 'informal') warmupSpeechSynthesis();
                    const next: GameState = { ...gameState, gamePhase: 'CATEGORY_SELECTION' };
                    setGameState(next);
                    const name = randomSessionName();
                    const session: PersistedSession = {
                      sessionName: name,
                      startedAt: Date.now(),
                      updatedAt: Date.now(),
                      logLines: [],
                      gameState: serializeGameState(next),
                    };
                    appendLogLine(session, `Session "${name}" started (${next.presentationMode})`);
                    next.players.forEach((p) => appendLogLine(session, `Player: ${p.name} (total 0)`));
                    persistedSessionRef.current = session;
                    setSessionName(name);
                    savePersistedSession(session);
                  }}
                  disabled={gameState.players.length < 1}
                  className="w-full relative overflow-hidden bg-gradient-to-r from-electric-blue to-deep-purple text-white py-6 text-3xl sm:text-4xl font-display uppercase rounded-2xl disabled:opacity-40 hover:brightness-110 active:scale-[0.98] transition-all shadow-lg shadow-electric-blue/20"
                >
                  <span className="relative z-10">Start Show</span>
                </button>
              </div>
            </div>
          )}

          {/* ── CATEGORY SELECTION ── */}
          {gameState.gamePhase === 'CATEGORY_SELECTION' && (
            <div
              key="cat"
              className="space-y-12"
            >
              <div className="text-center">
                <h2 className="text-6xl sm:text-8xl font-display uppercase tracking-tighter text-slate-900">
                  Who&apos;s <span className="text-gradient-warm">Choosing</span>?
                </h2>
                <p className="text-slate-600 font-mono text-sm mt-3">Select the contestant who picks the subject</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
                {gameState.players.map((player) => (
                  <button
                    key={player.id}
                    onClick={() =>
                      setGameState((prev) => ({
                        ...prev,
                        categoryChooserId: player.id,
                        gamePhase: 'GRADE_SELECTION',
                      }))
                    }
                    className="group p-8 bg-white border border-slate-200 rounded-2xl text-center hover:border-blue-400 hover:shadow-lg active:scale-95 transition-all shadow-sm"
                  >
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center text-2xl font-display text-white group-hover:scale-110 transition-transform">
                      {player.name[0]}
                    </div>
                    <span className="text-2xl font-display uppercase text-slate-900">{player.name}</span>
                    <p className="text-xs font-mono text-emerald-700 font-bold mt-2">{formatScore(player.totalScore)} pts</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── GRADE SELECTION ── */}
          {gameState.gamePhase === 'GRADE_SELECTION' && (
            <div
              key="grade"
              className="space-y-12"
            >
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
                <div>
                  <p className="text-xs font-mono uppercase text-blue-700 tracking-widest mb-1">
                    {chooserName} is choosing · Q{gameState.questionsAnsweredInSubject + 1}/{QUESTIONS_PER_SUBJECT}
                  </p>
                  <h2 className="text-5xl sm:text-7xl font-display uppercase tracking-tighter text-slate-900">
                    Pick the <span className="text-gradient">Battle</span>
                  </h2>
                </div>
                <ProgressDots current={gameState.questionsAnsweredInSubject} total={QUESTIONS_PER_SUBJECT} />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {SUBJECTS.map((subject) => (
                  <button
                    key={subject}
                    onClick={() => setGameState((prev) => ({ ...prev, currentSubject: subject }))}
                    className={cn(
                      'p-4 rounded-xl border text-left font-black uppercase text-sm transition-all active:scale-95 shadow-sm',
                      gameState.currentSubject === subject
                        ? 'bg-blue-100 border-blue-500 text-blue-900 ring-2 ring-blue-300'
                        : 'bg-white border-slate-200 text-slate-800 hover:bg-slate-50 hover:border-slate-300',
                    )}
                  >
                    <span className="text-lg mr-2">{SUBJECT_ICONS[subject] ?? '📚'}</span>
                    {subject}
                  </button>
                ))}
              </div>

              {gameState.currentSubject && (
                <div
                  className="grid grid-cols-3 sm:grid-cols-6 gap-4 pt-4"
                >
                  {GRADES.map((grade) => (
                    <button
                      key={grade}
                      onClick={() => selectGrade(grade)}
                      className={cn(
                        'relative overflow-hidden min-h-28 rounded-2xl border-2 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 group shadow-sm',
                        selectedGrade === grade
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'bg-white border-slate-200 text-slate-900 hover:border-blue-400 hover:bg-blue-50',
                      )}
                    >
                      <span className="text-5xl font-display leading-none group-hover:scale-110 transition-transform">
                        {grade}
                      </span>
                      <span className={cn(
                        'text-xs font-mono font-bold uppercase',
                        selectedGrade === grade ? 'text-white/90' : 'text-slate-500',
                      )}>
                        +{grade} pts
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── QUESTION — light panel + fixed scoring dock (portal) so names never scroll under compositor glitches */}
          {gameState.gamePhase === 'QUESTION' && gameState.currentQuestion && (
            <Fragment key="q-phase">
            <div
              className="relative space-y-8 rounded-2xl border border-slate-200 bg-white p-5 sm:p-8 pb-8 sm:pb-10 shadow-2xl shadow-black/20 ring-1 ring-slate-200/90 mb-[min(42vh,20rem)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div>
                  <p className="text-xs font-mono uppercase tracking-widest text-slate-600">
                    {gameState.currentSubject} · Grade {gameState.currentGrade} · +{formatScore(pointsForCorrect(gameState.currentGrade ?? 1))} pts
                  </p>
                  <ProgressDots variant="light" current={gameState.questionsAnsweredInSubject} total={QUESTIONS_PER_SUBJECT} />
                </div>
                <div className="flex items-center gap-3">
                  {(gameState.currentGrade ?? 1) >= 4 && (
                    <span className="hidden sm:inline font-mono text-[10px] font-black uppercase tracking-[0.2em] text-amber-900 border border-amber-400 px-2 py-1 rounded-md bg-amber-100">
                      Rapid · {TIMER_SECONDS_RAPID}s
                    </span>
                  )}
                  <TimerRing
                    variant="light"
                    timeLeft={timeLeft}
                    total={secondsForGrade(gameState.currentGrade ?? 1)}
                  />
                </div>
              </div>

              <div className="relative z-0 overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-inner">
                <div className="relative p-8 sm:p-12 lg:p-14">
                <h3
                  data-q-stem
                  className="mb-10 font-display text-4xl leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl xl:text-7xl text-slate-900"
                >
                  {gameState.currentQuestion.question}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                  {gameState.currentQuestion.options.map((option, idx) => {
                    const isCorrectOpt = option === gameState.currentQuestion!.answer;
                    const isHidden = gameState.hiddenOptions.includes(option);
                    return (
                      <button
                        key={idx}
                        type="button"
                        data-q-option={String(idx)}
                        disabled={isHidden}
                        onClick={() => {
                          setHostRevealAll(true);
                        }}
                        className={cn(
                          'p-5 rounded-2xl border text-xl sm:text-2xl font-bold text-left transition-colors duration-150',
                          isHidden && 'opacity-30 cursor-not-allowed',
                          hostRevealAll
                            ? isCorrectOpt
                              ? 'bg-emerald-100 text-emerald-900 border-emerald-500 ring-2 ring-emerald-300'
                              : 'bg-red-50 text-red-800 border-red-300'
                              : 'border border-slate-200 bg-white text-slate-900 hover:border-slate-300 hover:bg-slate-50',
                        )}
                      >
                        <span className="text-blue-600 mr-3 font-mono text-base font-black">{String.fromCharCode(65 + idx)}.</span>
                        {option}
                      </button>
                    );
                  })}
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <button
                    type="button"
                    onClick={() => setHostRevealAll(true)}
                    className="px-4 py-2 bg-slate-200 text-slate-900 font-mono text-xs font-bold uppercase rounded-lg border border-slate-300 hover:bg-slate-300 transition-all"
                  >
                    Reveal
                  </button>
                  <button
                    onClick={() => setShowAnswer(!showAnswer)}
                    className="px-4 py-2 bg-blue-100 text-blue-900 font-mono text-xs font-bold uppercase rounded-lg border border-blue-300 hover:bg-blue-200 transition-all"
                  >
                    {showAnswer ? 'Hide' : 'Answer'}
                  </button>
                  <button
                    type="button"
                    onClick={nextQuestionSameRound}
                    className="px-4 py-2 bg-white border border-slate-300 font-mono font-bold uppercase text-xs text-slate-800 rounded-lg hover:bg-slate-50 transition-all"
                  >
                    Next Q
                  </button>
                  <button
                    type="button"
                    onClick={alternateQuestion}
                    className="px-4 py-2 bg-amber-100 text-amber-950 border border-amber-400 font-mono font-bold uppercase text-xs rounded-lg hover:bg-amber-200 transition-all"
                  >
                    Alternate
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsTimerRunning(false);
                      setGameState((prev) => ({
                        ...prev,
                        gamePhase: 'GRADE_SELECTION',
                        currentQuestion: null,
                        hiddenOptions: [],
                      }));
                    }}
                    className="px-4 py-2 bg-white border border-slate-300 font-mono font-bold uppercase text-xs text-slate-600 rounded-lg hover:bg-slate-50 transition-all"
                  >
                    Back
                  </button>
                </div>

                {showAnswer && (
                  <div
                    className="inline-block px-6 py-3 bg-emerald-100 border border-emerald-400 rounded-xl"
                  >
                    <span className="text-2xl sm:text-3xl font-display uppercase text-emerald-900">
                      {gameState.currentQuestion.answer}
                    </span>
                  </div>
                )}
                </div>
              </div>

              <section
                className="relative rounded-2xl border border-slate-200 bg-slate-100 p-6 sm:p-8 shadow-sm"
                aria-label="Host controls"
              >
                <div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8 pb-8 border-b border-slate-300">
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Star className="w-5 h-5 text-amber-600 shrink-0" aria-hidden />
                      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-900">
                        Lifelines
                      </h2>
                    </div>
                    <p className="mb-3 font-mono text-[11px] font-bold uppercase tracking-wider text-slate-600">
                      50/50 — pick two answers on screen (once per player)
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {gameState.players.map((p) =>
                        p.hasUsedUneesBees !== true ? (
                          <button
                            key={`unees-${p.id}`}
                            type="button"
                            onClick={() => activateUneesBees(p.id)}
                            className="px-4 py-2 bg-slate-900 text-white border border-slate-900 font-mono text-xs font-bold uppercase rounded-lg hover:bg-slate-800 transition-colors"
                          >
                            {p.name}
                          </button>
                        ) : null,
                      )}
                      {gameState.players.every((p) => p.hasUsedUneesBees === true) && (
                        <p className="font-mono text-xs text-slate-500">All used</p>
                      )}
                    </div>
                    {gameState.hiddenOptions.length > 0 && (
                      <p className="mt-3 font-mono text-xs text-emerald-800 font-bold">
                        Active: two wrong answers hidden
                      </p>
                    )}
                  </div>
                </div>

                <p className="text-sm text-slate-600 font-mono">
                  <span className="font-bold text-slate-800">Scoring: </span>
                  use the bar fixed at the bottom of the screen — player names stay visible there.
                </p>
                </div>
              </section>
            </div>
            {typeof document !== 'undefined' &&
              createPortal(
                <div
                  className="fixed inset-x-0 bottom-0 z-[70] border-t-4 border-emerald-600 border-x-0 bg-white px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-12px_40px_rgba(0,0,0,0.18)] ring-1 ring-slate-200"
                  style={{ isolation: 'isolate', color: '#0f172a' }}
                  role="region"
                  aria-label="Score the question"
                >
                  <div className="max-w-6xl mx-auto">
                    <h2 className="text-center text-sm sm:text-base font-black uppercase tracking-wide text-slate-900 mb-1">
                      Tap who got it right
                    </h2>
                    <p className="text-center font-mono text-[10px] sm:text-xs text-slate-600 mb-3">
                      Chooser wrong: use the red button under their name.
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 sm:gap-3">
                      {gameState.players.map((player) => (
                        <div key={player.id} className="flex flex-col gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleScore(player.id, true)}
                            className={cn(
                              'min-h-[4.25rem] w-full rounded-xl border-2 px-2 py-2.5 text-left shadow-sm font-sans',
                              player.id === gameState.categoryChooserId
                                ? 'bg-sky-100 border-sky-600 hover:bg-sky-200'
                                : 'bg-slate-50 border-slate-400 hover:bg-white hover:border-emerald-500',
                            )}
                          >
                            <span
                              className="block text-sm sm:text-base font-black uppercase break-words leading-tight"
                              style={{ color: '#0f172a', WebkitTextFillColor: '#0f172a' }}
                            >
                              {player.name}
                            </span>
                            <span
                              className="mt-1 block text-lg sm:text-xl font-black tabular-nums"
                              style={{ color: '#047857', WebkitTextFillColor: '#047857' }}
                            >
                              +
                              {formatScore(
                                pointsForCorrect(gameState.currentGrade ?? 1),
                              )}
                            </span>
                          </button>
                          {player.id === gameState.categoryChooserId && (
                            <button
                              type="button"
                              onClick={() => handleScore(player.id, false)}
                              className="w-full rounded-lg border-2 border-red-500 bg-red-50 py-2 font-mono text-[10px] font-bold uppercase text-red-900 hover:bg-red-100"
                              style={{ color: '#7f1d1d', WebkitTextFillColor: '#7f1d1d' }}
                            >
                              Wrong (−1)
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>,
                document.body,
              )}
            </Fragment>
          )}

          {/* ── SUBJECT RESULTS ── */}
          {gameState.gamePhase === 'SUBJECT_RESULTS' && subjectWinner && (
            <div
              key="res"
              className="space-y-12 py-8"
            >
              <div className="text-center">
                <div
                  className="inline-block mb-6"
                >
                  <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-amber-400 to-pink-500 flex items-center justify-center shadow-lg">
                    <Trophy className="w-10 h-10 text-white" />
                  </div>
                </div>
                <h2 className="text-5xl sm:text-7xl font-display uppercase tracking-tighter text-slate-900">
                  Round <span className="text-gradient-warm">Winner</span>
                </h2>
                <p className="text-slate-600 font-mono text-sm mt-2">{gameState.currentSubject}</p>
              </div>

              <div
                className="max-w-md mx-auto text-center p-10 rounded-3xl bg-amber-50 border-2 border-amber-200 shadow-md"
              >
                <h3 className="text-5xl sm:text-6xl font-display uppercase mb-2 text-slate-900">{subjectWinner.name}</h3>
                <p className="text-3xl font-mono font-bold text-emerald-700">
                  {formatScore(subjectWinner.subjectScore)} Points
                </p>
              </div>

              <div
                className="max-w-lg mx-auto"
              >
                <h3 className="text-sm font-mono uppercase text-slate-500 tracking-widest mb-4 text-center">
                  Full Leaderboard
                </h3>
                <Leaderboard players={gameState.players} showSubjectScore />
              </div>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => {
                    logScoreEvent('--- Round end / Next subject ---');
                    logScoreSnapshot(gameState.players, 'ROUND-END');
                    setGameState((prev) => ({
                      ...prev,
                      players: prev.players.map((p) => ({ ...p, subjectScore: 0 })),
                      gamePhase: 'CATEGORY_SELECTION',
                      currentSubject: null,
                      currentGrade: null,
                      currentQuestion: null,
                      categoryChooserId: null,
                      questionsAnsweredInSubject: 0,
                      hiddenOptions: [],
                    }));
                  }}
                  className="px-12 py-5 bg-gradient-to-r from-blue-600 to-violet-600 text-white text-2xl font-display uppercase rounded-2xl hover:brightness-110 active:scale-[0.98] transition-all shadow-lg"
                >
                  Next Subject
                </button>
              </div>
            </div>
          )}
          {/* ── GAME OVER ── */}
          {gameState.gamePhase === 'GAME_OVER' && (() => {
            const sorted = [...gameState.players].sort((a, b) => b.totalScore - a.totalScore);
            const champion = sorted[0];
            return (
              <div
                key="game-over"
                className="space-y-14 py-10"
              >
                <div className="text-center space-y-6">
                  <div
                    className="inline-block"
                  >
                    <div className="w-28 h-28 mx-auto rounded-full bg-gradient-to-br from-amber-400 via-pink-500 to-violet-600 flex items-center justify-center shadow-xl">
                      <Crown className="w-14 h-14 text-white drop-shadow-lg" />
                    </div>
                  </div>

                  <h2 className="text-5xl sm:text-7xl lg:text-8xl font-display uppercase tracking-tighter text-slate-900">
                    Game <span className="text-gradient-warm">Over</span>
                  </h2>
                  <p className="text-slate-600 font-mono text-sm tracking-widest uppercase">Final Results</p>
                </div>

                {champion && (
                  <div
                    className="max-w-lg mx-auto text-center p-12 rounded-3xl bg-amber-50 border-2 border-amber-200 shadow-md"
                  >
                    <p className="text-slate-500 font-mono text-xs uppercase tracking-[0.3em] mb-3">Champion</p>
                    <h3 className="text-6xl sm:text-7xl font-display uppercase mb-4 text-gradient-warm">{champion.name}</h3>
                    <p className="text-4xl font-mono font-bold text-emerald-700">
                      {formatScore(champion.totalScore)} Points
                    </p>
                  </div>
                )}

                <div
                  className="max-w-lg mx-auto"
                >
                  <h3 className="text-sm font-mono uppercase text-slate-500 tracking-widest mb-4 text-center">
                    Final Standings
                  </h3>
                  <div className="space-y-2">
                    {sorted.map((p, i) => (
                      <div
                        key={p.id}
                        className={cn(
                          'flex items-center justify-between p-4 rounded-xl border shadow-sm',
                          i === 0
                            ? 'bg-amber-50 border-amber-300'
                            : i === 1
                              ? 'bg-slate-100 border-slate-300'
                              : i === 2
                                ? 'bg-orange-50 border-orange-200'
                                : 'bg-white border-slate-200',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <span className={cn(
                            'w-8 h-8 rounded-full flex items-center justify-center text-sm font-mono font-bold',
                            i === 0 ? 'bg-amber-200 text-amber-900' : 'bg-slate-200 text-slate-600',
                          )}>
                            {i + 1}
                          </span>
                          <span className="font-black uppercase text-sm text-slate-900">{p.name}</span>
                        </div>
                        <span className="font-mono font-bold text-emerald-700 text-lg tabular-nums">{formatScore(p.totalScore)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div
                  className="flex flex-col sm:flex-row items-center justify-center gap-4"
                >
                  <button
                    type="button"
                    onClick={resetGame}
                    className="px-12 py-5 bg-gradient-to-r from-blue-600 to-violet-600 text-white text-2xl font-display uppercase rounded-2xl hover:brightness-110 active:scale-[0.98] transition-all shadow-lg"
                  >
                    New Game
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const logs = localStorage.getItem('game_session_log');
                      if (!logs) return;
                      const blob = new Blob([logs], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `game-log-${new Date().toISOString().slice(0, 10)}.txt`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="px-8 py-5 bg-white border border-slate-300 text-slate-700 text-lg font-display uppercase rounded-2xl hover:bg-slate-50 active:scale-[0.98] transition-all shadow-sm"
                  >
                    Download Log
                  </button>
                </div>
              </div>
            );
          })()}
      </main>

      {/* ── Host Panel (Floating Bottom Sheet) ── */}
      {hostPanelOpen && gameState.players.length > 0 && (
          <div
            className="fixed inset-x-0 bottom-0 z-[80] max-h-[60vh] overflow-y-auto border-t-2 border-slate-200 bg-white shadow-[0_-12px_40px_rgba(0,0,0,0.12)]"
          >
            <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-display uppercase text-slate-900 flex items-center gap-2">
                  <Settings2 className="w-4 h-4 text-blue-600" />
                  Host Controls · Adjust Points
                </h2>
                <button
                  type="button"
                  onClick={() => setHostPanelOpen(false)}
                  className="px-4 py-2 bg-slate-100 text-slate-800 font-mono text-xs font-bold uppercase rounded-lg border border-slate-300 hover:bg-slate-200 transition-all"
                >
                  Close
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {gameState.players.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-col gap-3 border border-slate-200 rounded-xl p-4 bg-slate-50 shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-black uppercase text-sm text-slate-900">{p.name}</span>
                      <span className="text-emerald-700 font-mono font-bold text-lg tabular-nums shrink-0">{formatScore(p.totalScore)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {[-5, -2, -1].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => hostAdjustTotal(p.id, d)}
                          className="px-3 py-2 bg-red-50 text-red-700 font-mono text-xs font-bold uppercase rounded-lg border border-red-200 hover:bg-red-100 transition-all min-w-[44px]"
                        >
                          {d}
                        </button>
                      ))}
                      {[1, 2, 5].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => hostAdjustTotal(p.id, d)}
                          className="px-3 py-2 bg-emerald-50 text-emerald-800 font-mono text-xs font-bold uppercase rounded-lg border border-emerald-200 hover:bg-emerald-100 transition-all min-w-[44px]"
                        >
                          +{d}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={customAdjust[p.id] ?? ''}
                        onChange={(e) => setCustomAdjust((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        placeholder="Custom"
                        className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 min-w-0"
                      />
                      <button
                        type="button"
                        onClick={() => handleCustomAdjust(p.id)}
                        className="px-3 py-2 bg-blue-100 text-blue-900 font-mono text-xs font-bold uppercase rounded-lg border border-blue-300 hover:bg-blue-200 transition-all"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
