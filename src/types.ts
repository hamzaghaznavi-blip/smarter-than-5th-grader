export type Subject =
  | 'Maths'
  | 'World History'
  | 'Sub-continent History'
  | 'Geography'
  | 'World Religion & Mythology'
  | 'General Science'
  | 'Cricket'
  | 'Pop Culture & Sex Ed'
  | 'Sports'
  | 'World Politics'
  | 'Tech';

export type Grade = 1 | 2 | 3 | 4 | 5 | 6;

export interface Question {
  id: string;
  subject: Subject;
  grade: Grade;
  question: string;
  answer: string;
  options: string[];
}

export interface Player {
  id: string;
  name: string;
  totalScore: number;
  subjectScore: number;
  /** Number of gifts earned from host milestones (every +20 total points). */
  giftsEarned: number;
  hasUsedUneesBees: boolean;
  /** Londa poll: half points if correct; once per game per player */
  hasUsedLondaPoll: boolean;
}

export interface Prize {
  id: string;
  name: string;
  description: string;
}

/** `formal` = default show. `informal` = same rules + wrong-answer buzzer + Urdu roast lines (G4–6). */
export type PresentationMode = 'formal' | 'informal';

export interface GameState {
  players: Player[];
  categoryChooserId: string | null;
  currentSubject: Subject | null;
  currentGrade: Grade | null;
  currentQuestion: Question | null;
  gamePhase: 'SETUP' | 'CATEGORY_SELECTION' | 'GRADE_SELECTION' | 'QUESTION' | 'SUBJECT_RESULTS' | 'GAME_OVER';
  prizes: Prize[];
  selectedPrize: Prize | null;
  usedQuestionIds: Set<string>;
  questionsAnsweredInSubject: number;
  hiddenOptions: string[];
  uneesBeesActive: boolean;
  uneesBeesSelections: string[];
  /** Player who called Londa poll this question (½ points if they score correct) */
  londaPollPlayerId: string | null;
  presentationMode: PresentationMode;
}

