import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
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
  'Maths',
  'World History',
  'Sub-continent History',
  'Geography',
  'World Religion & Mythology',
  'General Science',
  'Cricket',
  'Pop Culture & Sex Ed',
  'Sports',
  'World Politics',
  'Tech',
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

const pointsForCorrectWithLonda = (
  grade: Grade,
  playerId: string,
  londaPollPlayerId: string | null,
): number => {
  const base = pointsForCorrect(grade);
  if (playerId === londaPollPlayerId) return Math.round(base * 0.5 * 10) / 10;
  return base;
};

const formatScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

type ScorePopup = { id: string; playerId: string; delta: number; timestamp: number };
type GiftNotice = { id: string; text: string; timestamp: number };

const SUBJECT_ICONS: Record<string, string> = {
  'Maths': '🔢',
  'World History': '🏛️',
  'Sub-continent History': '🕌',
  'Geography': '🌍',
  'World Religion & Mythology': '⛩️',
  'General Science': '🔬',
  'Cricket': '🏏',
  'Pop Culture & Sex Ed': '🎭',
  'Sports': '⚽',
  'World Politics': '🏛️',
  'Tech': '💻',
};

/* ─── Timer Ring Component ─── */
const TimerRing = memo(function TimerRing({ timeLeft, total = TIMER_SECONDS_RELAXED }: { timeLeft: number; total?: number }) {
  const radius = 28;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.min(1, Math.max(0, timeLeft / total));
  const dashOffset = circumference * (1 - progress);
  const criticalAt = Math.max(1, Math.floor(total * 0.34));
  const warnAt = Math.max(criticalAt + 1, Math.ceil(total * 0.5));
  const isCritical = timeLeft <= criticalAt && timeLeft > 0;
  const isWarn = timeLeft <= warnAt && timeLeft > criticalAt;

  return (
    <div className={cn('relative flex items-center justify-center', isCritical && 'timer-critical')}>
      <svg width="72" height="72" viewBox="0 0 72 72" className="transform -rotate-90">
        <circle
          cx="36" cy="36" r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.1)"
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
      </svg>
      <span className={cn(
        'absolute text-xl font-black font-mono',
        isCritical ? 'text-red-400' : isWarn ? 'text-amber-glow' : 'text-white',
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
  const reduceMotion = useReducedMotion();
  const sorted = useMemo(
    () => [...players].sort((a, b) => b.totalScore - a.totalScore),
    [players],
  );
  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div className="space-y-2">
      {sorted.map((p, i) => (
        <motion.div
          key={p.id}
          initial={reduceMotion ? false : { opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { delay: i * 0.06, type: 'spring', stiffness: 220, damping: 26 }
          }
          className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-xl border transition-all',
            i === 0 ? 'bg-gradient-to-r from-amber-500/10 to-yellow-500/10 border-amber-500/30' :
            i === 1 ? 'bg-gradient-to-r from-slate-300/10 to-gray-300/10 border-slate-400/20' :
            i === 2 ? 'bg-gradient-to-r from-orange-600/10 to-amber-700/10 border-orange-500/20' :
            'bg-white/5 border-white/10',
          )}
        >
          <span className="text-2xl w-8 text-center">{medals[i] ?? `${i + 1}.`}</span>
          <span className="flex-1 font-black text-lg uppercase tracking-tight text-white">{p.name}</span>
          <div className="text-right">
            <span className="text-xl font-black font-mono text-neon-green">{formatScore(p.totalScore)}</span>
            {showSubjectScore && (
              <span className="block text-xs font-mono text-white/50">round: {formatScore(p.subjectScore)}</span>
            )}
          </div>
        </motion.div>
      ))}
    </div>
  );
});

/* ─── Score Popup Float ─── */
const ScoreFloat = memo(function ScoreFloat({ popup }: { popup: ScorePopup }) {
  return (
    <div className="score-popup fixed top-1/3 left-1/2 -translate-x-1/2 z-[100]">
      <span className={cn(
        'text-5xl font-display',
        popup.delta > 0 ? 'text-neon-green' : 'text-red-400',
      )}>
        {popup.delta > 0 ? `+${formatScore(popup.delta)}` : formatScore(popup.delta)}
      </span>
    </div>
  );
});

/* ─── Progress Dots ─── */
const ProgressDots = memo(function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'w-3 h-3 rounded-full transition-all duration-300',
            i < current ? 'bg-neon-green scale-100' : 'bg-white/20 scale-75',
          )}
        />
      ))}
      <span className="text-xs font-mono text-white/50 ml-2">{current}/{total}</span>
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
    uneesBeesActive: false,
    uneesBeesSelections: [],
    londaPollPlayerId: null,
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
        hasUsedLondaPoll: false,
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
        uneesBeesActive: false,
        uneesBeesSelections: [],
        londaPollPlayerId: null,
      };
    });
    setShowAnswer(false);
    resetQuestionUI();
    setTimeLeft(secondsForGrade(grade));
    setIsTimerRunning(true);
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
        uneesBeesActive: false,
        uneesBeesSelections: [],
        londaPollPlayerId: null,
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
        uneesBeesActive: false,
        uneesBeesSelections: [],
        londaPollPlayerId: null,
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
    const pts = pointsForCorrectWithLonda(grade, playerId, gameState.londaPollPlayerId);

    if (isCorrect) {
      fireConfetti({ particleCount: 120, spread: 70, origin: { y: 0.6 }, colors: ['#00FF88', '#3B82F6', '#F59E0B'] });
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
      const londaNote = playerId === gameState.londaPollPlayerId ? ' [Londa ½]' : '';
      logScoreEvent(`${playerName}: CORRECT (+${pts}) [grade ${grade}]${londaNote}`);
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
          uneesBeesActive: false,
          londaPollPlayerId: null,
        };
      }

      return {
        ...prev,
        players: newPlayers,
        gamePhase: 'GRADE_SELECTION',
        questionsAnsweredInSubject: nextQuestionsAnswered,
        currentQuestion: null,
        uneesBeesActive: false,
        londaPollPlayerId: null,
      };
    });
    setShowAnswer(false);
  }, [
    gameState.currentGrade,
    gameState.categoryChooserId,
    gameState.londaPollPlayerId,
    gameState.players,
    gameState.presentationMode,
    logScoreEvent,
    logScoreSnapshot,
    showScorePopup,
  ]);

  const activateUneesBees = useCallback((playerId: string) => {
    if (!gameState.currentQuestion) return;
    const p = gameState.players.find((x) => x.id === playerId);
    if (!p || p.hasUsedUneesBees === true) return;
    setGameState((prev) => ({
      ...prev,
      players: prev.players.map((p) => (p.id === playerId ? { ...p, hasUsedUneesBees: true } : p)),
      uneesBeesActive: true,
      uneesBeesSelections: [],
    }));
  }, [gameState.currentQuestion, gameState.players]);

  const toggleUneesBeesSelection = useCallback((option: string) => {
    setGameState((prev) => {
      const isSelected = prev.uneesBeesSelections.includes(option);
      if (isSelected) return { ...prev, uneesBeesSelections: prev.uneesBeesSelections.filter((o) => o !== option) };
      if (prev.uneesBeesSelections.length < 2) return { ...prev, uneesBeesSelections: [...prev.uneesBeesSelections, option] };
      return prev;
    });
  }, []);

  const activateLondaPoll = useCallback((playerId: string) => {
    if (!gameState.currentQuestion) return;
    const p = gameState.players.find((x) => x.id === playerId);
    if (!p || p.hasUsedLondaPoll === true || gameState.londaPollPlayerId != null) return;
    logScoreEvent(`Londa poll called by ${p.name} (½ pts if correct)`);
    setGameState((prev) => ({
      ...prev,
      londaPollPlayerId: playerId,
      players: prev.players.map((pl) =>
        pl.id === playerId ? { ...pl, hasUsedLondaPoll: true } : pl,
      ),
    }));
  }, [gameState.currentQuestion, gameState.players, gameState.londaPollPlayerId, logScoreEvent]);

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
      uneesBeesActive: false,
      uneesBeesSelections: [],
      londaPollPlayerId: null,
      presentationMode: 'formal',
    });
  }, []);

  const endGame = useCallback(() => {
    logScoreEvent('=== GAME OVER ===');
    logScoreSnapshot(gameState.players, 'FINAL');
    fireConfetti({ particleCount: 300, spread: 120, origin: { y: 0.4 }, colors: ['#00FF88', '#3B82F6', '#F59E0B', '#EC4899', '#8B5CF6'] });
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
    <div className="min-h-screen bg-brutal-black text-gallery-white font-sans relative">
      <WowAmbience mode={wowMode} />

      {/* Score popups (plain DOM — no layout animation cost) */}
      {scorePopups.map((p) => (
        <ScoreFloat key={p.id} popup={p} />
      ))}

      {/* Gift milestone notices */}
      <AnimatePresence>
        {giftNotices.slice(-2).map((n) => (
          <motion.div
            key={n.id}
            role="status"
            initial={{ opacity: 0, y: 30, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="fixed top-24 left-1/2 z-[92] w-[min(92vw,34rem)] -translate-x-1/2 px-5 py-4 rounded-2xl border border-amber-glow/35 bg-[#141008]/95 shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-glow/15 border border-amber-glow/25 flex items-center justify-center shrink-0">
                <Gift className="w-5 h-5 text-amber-glow" aria-hidden />
              </div>
              <div>
                <p className="text-base sm:text-lg font-black text-white leading-snug">{n.text}</p>
                <p className="text-[10px] font-mono text-white/35 mt-1 uppercase tracking-wider">Host gift milestone · every +20 points</p>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Informal mode: roast line (G4–6 wrong answers) */}
      <AnimatePresence>
        {informalRoast && (
          <motion.div
            key={informalRoast}
            role="status"
            initial={{ opacity: 0, y: 40, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="fixed bottom-8 left-1/2 z-[95] w-[min(92vw,28rem)] -translate-x-1/2 px-5 py-4 rounded-2xl border border-hot-pink/40 bg-[#1a0f16]/95 shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
          >
            <p className="flex items-start gap-3 text-left">
              <Laugh className="w-6 h-6 text-hot-pink shrink-0 mt-0.5" aria-hidden />
              <span className="text-lg sm:text-xl font-bold leading-snug text-white" dir="auto">
                {informalRoast}
              </span>
            </p>
            <p className="text-[10px] font-mono text-white/40 mt-2 uppercase tracking-wider">Informal · grades 4–6</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Resume banner */}
      {resumeOffered && resumeSessionName && (
        <motion.div
          initial={{ y: -60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="relative z-50 bg-amber-glow/10 border-b border-amber-glow/30 px-6 py-4 flex flex-wrap items-center justify-between gap-3 max-w-7xl mx-auto"
        >
          <p className="font-mono text-sm font-bold text-amber-glow">
            Recover previous game &quot;{resumeSessionName}&quot;?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resumeSession}
              className="px-5 py-2 bg-amber-glow text-brutal-black font-mono text-xs font-bold uppercase rounded-lg hover:brightness-110 transition-all"
            >
              Resume
            </button>
            <button
              type="button"
              onClick={dismissResume}
              className="px-5 py-2 bg-white/10 text-white font-mono text-xs font-bold uppercase rounded-lg border border-white/20 hover:bg-white/20 transition-all"
            >
              Start fresh
            </button>
          </div>
        </motion.div>
      )}

      {/* ── Header ── */}
      <header className="relative z-40 border-b border-white/10 bg-[#0a0a0f]/95 sticky top-0">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="bg-gradient-to-br from-neon-green to-electric-blue p-3 rounded-2xl">
                <Trophy className="w-7 h-7 text-brutal-black" />
              </div>
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-neon-green rounded-full opacity-90" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl md:text-3xl font-display uppercase leading-none tracking-tight text-white">
                Class Room Trivia Game
              </h1>
              <p className="text-[10px] sm:text-xs font-mono uppercase tracking-widest text-white/45 font-bold mt-1">
                Smarter Than a 5th Grader
              </p>
              <p className="text-[10px] sm:text-xs font-mono uppercase tracking-widest text-neon-green/90 font-bold mt-0.5">
                {ENABLE_INFORMAL_MODE && gameState.presentationMode === 'informal' ? (
                  <span className="text-hot-pink">Informal · buzzer + voice roasts (G4–6)</span>
                ) : (
                  <span className="text-neon-green/90">Formal · silent scoring · executive mode</span>
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
                    ? 'bg-electric-blue text-white border-electric-blue'
                    : 'bg-white/5 text-white/80 border-white/15 hover:bg-white/10',
                )}
              >
                <Settings2 className="w-4 h-4" />
                <span className="hidden sm:inline">Scores</span>
              </button>
              {sessionName && (
                <button
                  type="button"
                  onClick={exportSessionLog}
                  className="px-3 py-2 bg-white/5 border border-white/15 text-white/80 font-mono font-bold uppercase text-xs rounded-xl hover:bg-white/10 transition-all"
                >
                  Export
                </button>
              )}
              <button
                type="button"
                onClick={endGame}
                className="flex items-center gap-2 px-3 py-2 bg-red-500/15 border border-red-500/30 text-red-400 font-mono font-bold uppercase text-xs rounded-xl hover:bg-red-500/25 transition-all"
              >
                <Flag className="w-4 h-4" />
                <span className="hidden sm:inline">End</span>
              </button>
              <button
                onClick={resetGame}
                className="flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/15 text-white/80 font-mono font-bold uppercase text-xs rounded-xl hover:bg-white/10 transition-all"
              >
                <Home className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* Live scoreboard strip */}
        {gameState.gamePhase !== 'SETUP' && gameState.players.length > 0 && (
          <div className="max-w-7xl mx-auto px-6 pb-3">
            <div className="flex flex-wrap gap-2">
              {sortedPlayers.map((p, i) => (
                <span
                  key={p.id}
                  className={cn(
                    'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono font-bold border transition-all',
                    i === 0 ? 'bg-amber-glow/10 border-amber-glow/30 text-amber-glow' :
                    'bg-white/5 border-white/10 text-white/70',
                  )}
                >
                  {i === 0 && <Crown className="w-3 h-3" />}
                  {p.name}: <span className="text-neon-green">{formatScore(p.totalScore)}</span>
                  {p.giftsEarned > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-glow/10 border border-amber-glow/25 text-amber-glow/90">
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
      <main className="relative z-10 max-w-6xl mx-auto px-6 py-12 sm:py-16">
        <AnimatePresence mode="wait">

          {/* ── SETUP ── */}
          {gameState.gamePhase === 'SETUP' && (
            <motion.div
              key="setup"
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -30 }}
              transition={{ type: 'spring', stiffness: 100 }}
              className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center"
            >
              <div className="space-y-8">
                <div>
                  <motion.h2
                    initial={{ opacity: 0, x: -30 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 }}
                    className="text-5xl sm:text-7xl md:text-8xl font-display uppercase leading-[0.88] tracking-tighter"
                  >
                    <span className="text-gradient">READY TO PLAY</span>
                  </motion.h2>
                  <motion.p
                    initial={{ opacity: 0, x: -30 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 }}
                    className="text-white/55 font-mono text-sm mt-5 max-w-lg leading-relaxed"
                  >
                    Add players, pick Formal or Informal, and run a fast-paced live quiz.
                    Grade 1 = 1pt → Grade 6 = 6pts. Sharp timers. Built for the big screen.
                  </motion.p>
                </div>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="flex items-center gap-4 p-4 rounded-xl bg-neon-green/5 border border-neon-green/20"
                >
                  <Zap className="w-5 h-5 text-neon-green flex-shrink-0" />
                  <p className="font-mono text-xs font-bold text-neon-green/80 uppercase">
                    11 subjects · 6 grades · 2 lifelines · 5,000+ questions · rapid rounds
                  </p>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  className="text-xs font-mono text-white/40 space-y-1"
                >
                  <p>Lounda poll: ask the room, ½ pts for caller (once/game).</p>
                  <p>Unees Bees: contestant picks two answers (once/game).</p>
                  <p>Chooser wrong: −1 pt. Others wrong: 0 pts.</p>
                </motion.div>
              </div>

              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.2, type: 'spring' }}
                className="bg-[#0c0e14] border border-white/10 rounded-3xl p-8 sm:p-10 space-y-8 shadow-2xl shadow-black/40 ring-1 ring-white/[0.06]"
              >
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={newPlayerName}
                    onChange={(e) => setNewPlayerName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addPlayer()}
                    placeholder="Player name..."
                    className="flex-1 bg-white/5 border border-white/15 rounded-xl px-5 py-4 text-xl font-black text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-electric-blue/50 focus:border-electric-blue/50 transition-all"
                  />
                  <button
                    onClick={addPlayer}
                    className="bg-electric-blue text-white px-6 py-4 text-lg font-black uppercase rounded-xl hover:brightness-110 active:scale-95 transition-all"
                  >
                    <Plus className="w-6 h-6" />
                  </button>
                </div>

                <div className="space-y-3 max-h-[300px] overflow-y-auto">
                  <AnimatePresence>
                    {gameState.players.map((player, idx) => (
                      <motion.div
                        key={player.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        transition={{ delay: idx * 0.05 }}
                        className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-5 py-4 group hover:bg-white/8 transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-8 h-8 flex items-center justify-center rounded-lg bg-gradient-to-br from-electric-blue to-deep-purple text-white text-sm font-black">
                            {idx + 1}
                          </span>
                          <span className="text-xl font-black uppercase tracking-tight">{player.name}</span>
                        </div>
                        <button
                          onClick={() =>
                            setGameState((prev) => ({ ...prev, players: prev.players.filter((p) => p.id !== player.id) }))
                          }
                          className="text-white/30 hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>

                {ENABLE_INFORMAL_MODE && (
                  <>
                    <div className="space-y-3">
                      <p className="text-xs font-mono font-bold uppercase text-white/40 tracking-wider">Mode</p>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setGameState((prev) => ({ ...prev, presentationMode: 'formal' }))}
                          className={cn(
                            'py-4 px-4 rounded-xl border-2 font-mono text-xs font-bold uppercase transition-all',
                            gameState.presentationMode === 'formal'
                              ? 'border-neon-green bg-neon-green/10 text-neon-green'
                              : 'border-white/15 bg-white/5 text-white/50 hover:border-white/25',
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
                              ? 'border-hot-pink bg-hot-pink/10 text-hot-pink'
                              : 'border-white/15 bg-white/5 text-white/50 hover:border-white/25',
                          )}
                        >
                          <Laugh className="w-4 h-4" />
                          Informal
                        </button>
                      </div>
                      <p className="text-[11px] font-mono text-white/35 leading-relaxed">
                        Informal: loud buzzer + spoken roasts (Urdu male / Punjabi female mix, browser voices).
                        Grades 4–6. Formal: no sound.
                      </p>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 space-y-3">
                      <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-wider text-white/45">
                        <Link2 className="w-3.5 h-3.5" />
                        Direct links (bookmark or share)
                      </div>
                      <div className="space-y-1.5 text-[10px] font-mono text-white/30 break-all leading-snug">
                        <p>
                          <span className="text-neon-green/55 font-bold uppercase mr-1.5">Formal</span>
                          {shareUrlForMode('formal')}
                        </p>
                        <p>
                          <span className="text-hot-pink/55 font-bold uppercase mr-1.5">Informal</span>
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
              </motion.div>
            </motion.div>
          )}

          {/* ── CATEGORY SELECTION ── */}
          {gameState.gamePhase === 'CATEGORY_SELECTION' && (
            <motion.div
              key="cat"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 120 }}
              className="space-y-12"
            >
              <div className="text-center">
                <h2 className="text-6xl sm:text-8xl font-display uppercase tracking-tighter">
                  Who's <span className="text-gradient-warm">Choosing</span>?
                </h2>
                <p className="text-white/40 font-mono text-sm mt-3">Select the contestant who picks the subject</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
                {gameState.players.map((player, idx) => (
                  <motion.button
                    key={player.id}
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.08 }}
                    onClick={() =>
                      setGameState((prev) => ({
                        ...prev,
                        categoryChooserId: player.id,
                        gamePhase: 'GRADE_SELECTION',
                      }))
                    }
                    className="group p-8 bg-white/[0.03] border border-white/10 rounded-2xl text-center hover:bg-white/8 hover:border-electric-blue/40 active:scale-95 transition-all"
                  >
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-electric-blue to-deep-purple flex items-center justify-center text-2xl font-display text-white group-hover:scale-110 transition-transform">
                      {player.name[0]}
                    </div>
                    <span className="text-2xl font-display uppercase">{player.name}</span>
                    <p className="text-xs font-mono text-white/40 mt-2">{formatScore(player.totalScore)} pts</p>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── GRADE SELECTION ── */}
          {gameState.gamePhase === 'GRADE_SELECTION' && (
            <motion.div
              key="grade"
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -40 }}
              transition={{ type: 'spring', stiffness: 100 }}
              className="space-y-12"
            >
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
                <div>
                  <p className="text-xs font-mono uppercase text-electric-blue/80 tracking-widest mb-1">
                    {chooserName} is choosing · Q{gameState.questionsAnsweredInSubject + 1}/{QUESTIONS_PER_SUBJECT}
                  </p>
                  <h2 className="text-5xl sm:text-7xl font-display uppercase tracking-tighter">
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
                      'p-4 rounded-xl border text-left font-black uppercase text-sm transition-all active:scale-95',
                      gameState.currentSubject === subject
                        ? 'bg-electric-blue/15 border-electric-blue/50 text-electric-blue ring-1 ring-electric-blue/30'
                        : 'bg-white/[0.03] border-white/10 text-white/70 hover:bg-white/5 hover:border-white/20',
                    )}
                  >
                    <span className="text-lg mr-2">{SUBJECT_ICONS[subject] ?? '📚'}</span>
                    {subject}
                  </button>
                ))}
              </div>

              {gameState.currentSubject && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="grid grid-cols-3 sm:grid-cols-6 gap-4 pt-4"
                >
                  {GRADES.map((grade) => (
                    <button
                      key={grade}
                      onClick={() => selectGrade(grade)}
                      className={cn(
                        'relative overflow-hidden min-h-28 rounded-2xl border-2 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 group',
                        selectedGrade === grade
                          ? 'bg-electric-blue border-electric-blue text-white'
                          : 'bg-white/[0.03] border-white/15 hover:border-electric-blue/50 hover:bg-electric-blue/5',
                      )}
                    >
                      <span className="text-5xl font-display leading-none group-hover:scale-110 transition-transform">
                        {grade}
                      </span>
                      <span className="text-xs font-mono font-bold uppercase text-white/50">
                        +{grade} pts
                      </span>
                    </button>
                  ))}
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ── QUESTION ── */}
          {gameState.gamePhase === 'QUESTION' && gameState.currentQuestion && (
            <motion.div
              key="q"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: 'easeOut' }}
              className="space-y-8"
            >
              {/* Question header */}
              <div className="relative z-[5] flex justify-between items-center">
                <div>
                  <p className="text-xs font-mono uppercase text-white/40 tracking-widest">
                    {gameState.currentSubject} · Grade {gameState.currentGrade} · +{formatScore(pointsForCorrect(gameState.currentGrade ?? 1))} pts
                    {gameState.londaPollPlayerId &&
                      ` · Lounda: ${gameState.players.find((x) => x.id === gameState.londaPollPlayerId)?.name ?? '?'} (½)`}
                  </p>
                  <ProgressDots current={gameState.questionsAnsweredInSubject} total={QUESTIONS_PER_SUBJECT} />
                </div>
                <div className="flex items-center gap-3">
                  {(gameState.currentGrade ?? 1) >= 4 && (
                    <span className="hidden sm:inline font-mono text-[10px] font-black uppercase tracking-[0.2em] text-amber-glow/90 border border-amber-glow/35 px-2 py-1 rounded-md bg-amber-glow/10">
                      Rapid · {TIMER_SECONDS_RAPID}s
                    </span>
                  )}
                  <TimerRing
                    timeLeft={timeLeft}
                    total={secondsForGrade(gameState.currentGrade ?? 1)}
                  />
                </div>
              </div>

              {/* Question card — THE hero of the page (rim: calmer G1–3, intense G4–6) */}
              <div className="relative z-[5] rounded-3xl border border-white/10 bg-[#0B0F14] shadow-2xl shadow-black/60 ring-1 ring-white/[0.06] overflow-hidden">
                <div className="absolute inset-0 opacity-[0.22] bg-[radial-gradient(ellipse_120%_90%_at_50%_0%,rgba(255,255,255,0.06),transparent_60%)]" aria-hidden />
                <div className="relative p-8 sm:p-12 lg:p-14">
                <h3 className="text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-display leading-[1.1] tracking-tight mb-10 text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.55)]">
                  {gameState.currentQuestion.question}
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                  {gameState.currentQuestion.options.map((option, idx) => {
                    const isCorrectOpt = option === gameState.currentQuestion!.answer;
                    const uneesOn = gameState.uneesBeesActive;
                    return (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => {
                          if (uneesOn) toggleUneesBeesSelection(option);
                          else setHostRevealAll(true);
                        }}
                        className={cn(
                          'p-5 rounded-2xl border text-xl sm:text-2xl font-bold text-left transition-all active:scale-[0.98]',
                          hostRevealAll
                            ? isCorrectOpt
                              ? 'bg-neon-green/20 text-neon-green border-neon-green/50 ring-2 ring-neon-green/30'
                              : 'bg-red-500/10 text-red-300 border-red-500/30'
                            : uneesOn
                              ? gameState.uneesBeesSelections.includes(option)
                                ? 'bg-neon-green/15 border-neon-green/40 text-neon-green'
                                : 'bg-white/[0.03] border-white/10 text-white/75 hover:bg-white/5 hover:border-white/15'
                              : 'bg-white/[0.03] border-white/10 text-white/85 hover:bg-white/5 hover:border-white/15',
                        )}
                      >
                        <span className="text-electric-blue mr-3 font-mono text-base">{String.fromCharCode(65 + idx)}.</span>
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
                    className="px-4 py-2 bg-white/10 text-white font-mono text-xs font-bold uppercase rounded-lg border border-white/15 hover:bg-white/15 transition-all"
                  >
                    Reveal
                  </button>
                  <button
                    onClick={() => setShowAnswer(!showAnswer)}
                    className="px-4 py-2 bg-electric-blue/20 text-electric-blue font-mono text-xs font-bold uppercase rounded-lg border border-electric-blue/30 hover:bg-electric-blue/30 transition-all"
                  >
                    {showAnswer ? 'Hide' : 'Answer'}
                  </button>
                  <button
                    type="button"
                    onClick={nextQuestionSameRound}
                    className="px-4 py-2 bg-white/5 border border-white/15 text-white/70 font-mono font-bold uppercase text-xs rounded-lg hover:bg-white/10 transition-all"
                  >
                    Next Q
                  </button>
                  <button
                    type="button"
                    onClick={alternateQuestion}
                    className="px-4 py-2 bg-amber-glow/10 text-amber-glow border border-amber-glow/30 font-mono font-bold uppercase text-xs rounded-lg hover:bg-amber-glow/20 transition-all"
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
                        uneesBeesActive: false,
                        uneesBeesSelections: [],
                        londaPollPlayerId: null,
                      }));
                    }}
                    className="px-4 py-2 bg-white/5 border border-white/15 text-white/50 font-mono font-bold uppercase text-xs rounded-lg hover:bg-white/10 transition-all"
                  >
                    Back
                  </button>
                </div>

                {showAnswer && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="inline-block px-6 py-3 bg-neon-green/10 border border-neon-green/30 rounded-xl"
                  >
                    <span className="text-2xl sm:text-3xl font-display uppercase text-neon-green">
                      {gameState.currentQuestion.answer}
                    </span>
                  </motion.div>
                )}
                </div>
              </div>

              {/* Lifelines */}
              <div className="rounded-2xl border border-white/10 bg-[#0a0c12] p-5 sm:p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Star className="w-4 h-4 text-amber-glow" />
                  <h2 className="text-sm font-display uppercase tracking-wide text-white/60">
                    Lifelines
                  </h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <p className="font-mono text-[10px] font-bold text-white/40 mb-2 uppercase tracking-wider">
                      Unees Bees — pick two answers (once/game)
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {gameState.players.map((p) =>
                        p.hasUsedUneesBees !== true ? (
                          <button
                            key={`unees-${p.id}`}
                            type="button"
                            onClick={() => activateUneesBees(p.id)}
                            className="px-3 py-1.5 bg-electric-blue/15 text-electric-blue border border-electric-blue/30 font-mono text-xs font-bold uppercase rounded-lg hover:bg-electric-blue/25 transition-all"
                          >
                            {p.name}
                          </button>
                        ) : null,
                      )}
                      {gameState.players.every((p) => p.hasUsedUneesBees === true) && (
                        <p className="font-mono text-xs text-white/30">All used</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <p className="font-mono text-[10px] font-bold text-white/40 mb-2 uppercase tracking-wider">
                      Lounda poll — ask the room, ½ pts (once/game)
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {gameState.players.map((p) => {
                        const canUse =
                          p.hasUsedLondaPoll !== true && gameState.londaPollPlayerId == null;
                        if (!canUse) return null;
                        return (
                          <button
                            key={`londa-${p.id}`}
                            type="button"
                            onClick={() => activateLondaPoll(p.id)}
                            className="px-3 py-1.5 bg-deep-purple/15 text-deep-purple border border-deep-purple/30 font-mono text-xs font-bold uppercase rounded-lg hover:bg-deep-purple/25 transition-all"
                          >
                            {p.name}
                          </button>
                        );
                      })}
                      {gameState.londaPollPlayerId != null && (
                        <p className="font-mono text-xs font-bold text-deep-purple">
                          Active: {gameState.players.find((x) => x.id === gameState.londaPollPlayerId)?.name ?? '?'}
                        </p>
                      )}
                      {gameState.players.every((p) => p.hasUsedLondaPoll === true) &&
                        gameState.londaPollPlayerId == null && (
                          <p className="font-mono text-xs text-white/30">All used</p>
                        )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Score buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {gameState.players.map((player) => (
                  <div key={player.id} className="space-y-2">
                    <button
                      type="button"
                      onClick={() => handleScore(player.id, true)}
                      className={cn(
                        'w-full p-6 rounded-xl border-2 text-xl font-black uppercase transition-all active:scale-[0.97]',
                        player.id === gameState.categoryChooserId
                          ? 'bg-electric-blue/15 border-electric-blue/40 text-electric-blue hover:bg-electric-blue/25'
                          : 'bg-white/[0.03] border-white/10 text-white/80 hover:bg-neon-green/10 hover:border-neon-green/30 hover:text-neon-green',
                      )}
                    >
                      {player.name}{' '}
                      <span className="text-neon-green">
                        (+{formatScore(pointsForCorrectWithLonda(gameState.currentGrade ?? 1, player.id, gameState.londaPollPlayerId))})
                      </span>
                    </button>

                    {player.id === gameState.categoryChooserId && (
                      <button
                        type="button"
                        onClick={() => handleScore(player.id, false)}
                        className="w-full py-3 bg-red-500/10 text-red-400 border border-red-500/30 font-mono font-bold uppercase text-xs rounded-xl hover:bg-red-500/20 transition-all"
                      >
                        Wrong (−1 chooser)
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── SUBJECT RESULTS ── */}
          {gameState.gamePhase === 'SUBJECT_RESULTS' && subjectWinner && (
            <motion.div
              key="res"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: 'spring', stiffness: 100 }}
              className="space-y-12 py-8"
            >
              <div className="text-center">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
                  className="inline-block mb-6"
                >
                  <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-amber-glow to-hot-pink flex items-center justify-center">
                    <Trophy className="w-10 h-10 text-white" />
                  </div>
                </motion.div>
                <h2 className="text-5xl sm:text-7xl font-display uppercase tracking-tighter">
                  Round <span className="text-gradient-warm">Winner</span>
                </h2>
                <p className="text-white/40 font-mono text-sm mt-2">{gameState.currentSubject}</p>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="max-w-md mx-auto text-center p-10 rounded-3xl bg-gradient-to-br from-amber-glow/10 to-hot-pink/5 border border-amber-glow/20"
              >
                <h3 className="text-5xl sm:text-6xl font-display uppercase mb-2">{subjectWinner.name}</h3>
                <p className="text-3xl font-mono font-bold text-neon-green">
                  {formatScore(subjectWinner.subjectScore)} Points
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="max-w-lg mx-auto"
              >
                <h3 className="text-sm font-mono uppercase text-white/40 tracking-widest mb-4 text-center">
                  Full Leaderboard
                </h3>
                <Leaderboard players={gameState.players} showSubjectScore />
              </motion.div>

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
                      uneesBeesActive: false,
                      uneesBeesSelections: [],
                    }));
                  }}
                  className="px-12 py-5 bg-gradient-to-r from-electric-blue to-deep-purple text-white text-2xl font-display uppercase rounded-2xl hover:brightness-110 active:scale-[0.98] transition-all shadow-lg shadow-electric-blue/20"
                >
                  Next Subject
                </button>
              </div>
            </motion.div>
          )}
          {/* ── GAME OVER ── */}
          {gameState.gamePhase === 'GAME_OVER' && (() => {
            const sorted = [...gameState.players].sort((a, b) => b.totalScore - a.totalScore);
            const champion = sorted[0];
            return (
              <motion.div
                key="game-over"
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 80 }}
                className="space-y-14 py-10"
              >
                <div className="text-center space-y-6">
                  <motion.div
                    initial={{ scale: 0, rotate: -20 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ delay: 0.2, type: 'spring', stiffness: 150 }}
                    className="inline-block"
                  >
                    <div className="w-28 h-28 mx-auto rounded-full bg-gradient-to-br from-amber-glow via-hot-pink to-deep-purple flex items-center justify-center shadow-[0_0_60px_rgba(245,158,11,0.35)]">
                      <Crown className="w-14 h-14 text-white drop-shadow-lg" />
                    </div>
                  </motion.div>

                  <h2 className="text-5xl sm:text-7xl lg:text-8xl font-display uppercase tracking-tighter">
                    Game <span className="text-gradient-warm">Over</span>
                  </h2>
                  <p className="text-white/40 font-mono text-sm tracking-widest uppercase">Final Results</p>
                </div>

                {champion && (
                  <motion.div
                    initial={{ opacity: 0, y: 40 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4 }}
                    className="max-w-lg mx-auto text-center p-12 rounded-3xl bg-gradient-to-br from-amber-glow/10 via-hot-pink/5 to-deep-purple/5 border border-amber-glow/20 shadow-[0_0_40px_rgba(245,158,11,0.1)]"
                  >
                    <p className="text-white/50 font-mono text-xs uppercase tracking-[0.3em] mb-3">Champion</p>
                    <h3 className="text-6xl sm:text-7xl font-display uppercase mb-4 text-gradient-warm">{champion.name}</h3>
                    <p className="text-4xl font-mono font-bold text-neon-green">
                      {formatScore(champion.totalScore)} Points
                    </p>
                  </motion.div>
                )}

                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.6 }}
                  className="max-w-lg mx-auto"
                >
                  <h3 className="text-sm font-mono uppercase text-white/40 tracking-widest mb-4 text-center">
                    Final Standings
                  </h3>
                  <div className="space-y-2">
                    {sorted.map((p, i) => (
                      <motion.div
                        key={p.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.7 + i * 0.1 }}
                        className={cn(
                          'flex items-center justify-between p-4 rounded-xl border',
                          i === 0
                            ? 'bg-amber-glow/10 border-amber-glow/30'
                            : i === 1
                              ? 'bg-white/[0.04] border-white/15'
                              : i === 2
                                ? 'bg-white/[0.03] border-white/10'
                                : 'bg-white/[0.02] border-white/5',
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <span className={cn(
                            'w-8 h-8 rounded-full flex items-center justify-center text-sm font-mono font-bold',
                            i === 0 ? 'bg-amber-glow/20 text-amber-glow' : 'bg-white/10 text-white/40',
                          )}>
                            {i + 1}
                          </span>
                          <span className="font-black uppercase text-sm">{p.name}</span>
                        </div>
                        <span className="font-mono font-bold text-neon-green text-lg">{formatScore(p.totalScore)}</span>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1 }}
                  className="flex flex-col sm:flex-row items-center justify-center gap-4"
                >
                  <button
                    type="button"
                    onClick={resetGame}
                    className="px-12 py-5 bg-gradient-to-r from-electric-blue to-deep-purple text-white text-2xl font-display uppercase rounded-2xl hover:brightness-110 active:scale-[0.98] transition-all shadow-lg shadow-electric-blue/20"
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
                    className="px-8 py-5 bg-white/5 border border-white/15 text-white/70 text-lg font-display uppercase rounded-2xl hover:bg-white/10 active:scale-[0.98] transition-all"
                  >
                    Download Log
                  </button>
                </motion.div>
              </motion.div>
            );
          })()}
        </AnimatePresence>
      </main>

      {/* ── Host Panel (Floating Bottom Sheet) ── */}
      <AnimatePresence>
        {hostPanelOpen && gameState.players.length > 0 && (
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed inset-x-0 bottom-0 z-[60] max-h-[60vh] overflow-y-auto border-t border-white/10 bg-[#0a0a0f] shadow-[0_-8px_30px_rgba(0,0,0,0.5)]"
          >
            <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-display uppercase text-white/80 flex items-center gap-2">
                  <Settings2 className="w-4 h-4 text-electric-blue" />
                  Host Controls · Adjust Points
                </h2>
                <button
                  type="button"
                  onClick={() => setHostPanelOpen(false)}
                  className="px-4 py-2 bg-white/10 text-white font-mono text-xs font-bold uppercase rounded-lg border border-white/15 hover:bg-white/15 transition-all"
                >
                  Close
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {gameState.players.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-col gap-3 border border-white/10 rounded-xl p-4 bg-white/[0.03]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-black uppercase text-sm">{p.name}</span>
                      <span className="text-neon-green font-mono font-bold text-lg">{formatScore(p.totalScore)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {[-5, -2, -1].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => hostAdjustTotal(p.id, d)}
                          className="px-3 py-2 bg-red-500/15 text-red-400 font-mono text-xs font-bold uppercase rounded-lg border border-red-500/20 hover:bg-red-500/25 transition-all min-w-[44px]"
                        >
                          {d}
                        </button>
                      ))}
                      {[1, 2, 5].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => hostAdjustTotal(p.id, d)}
                          className="px-3 py-2 bg-neon-green/15 text-neon-green font-mono text-xs font-bold uppercase rounded-lg border border-neon-green/20 hover:bg-neon-green/25 transition-all min-w-[44px]"
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
                        className="flex-1 bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-electric-blue/50 min-w-0"
                      />
                      <button
                        type="button"
                        onClick={() => handleCustomAdjust(p.id)}
                        className="px-3 py-2 bg-electric-blue/15 text-electric-blue font-mono text-xs font-bold uppercase rounded-lg border border-electric-blue/30 hover:bg-electric-blue/25 transition-all"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
