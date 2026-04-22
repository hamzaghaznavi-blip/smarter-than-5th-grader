export type Subject =
  | 'Stats & Maths'
  | 'World History'
  | 'World Geography'
  | 'World Religion & Mythology'
  | 'General Science'
  | 'NBA'
  | 'NHL'
  | 'Pop Culture'
  | 'Canadian History'
  | 'Sports'
  | 'World Politics'
  | 'FinTech';

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
  presentationMode: PresentationMode;
}

