import type { Grade, Subject } from './types';
import { worldHistory, geography } from './seeds/group1';
import { wrm, science } from './seeds/group2';
import { nba, nhl, sports, canadianHistory, popCulture } from './seeds/group3';
import { worldPolitics, fintech } from './seeds/group4';
import { workplaceStats } from './seeds/workplaceStats';
import type { Fact } from './seeds/group1';

export type FactPack = {
  clue: string;
  answer: string;
  distractors: [string, string, string];
};

type AnswerKind = 'year' | 'number' | 'percent' | 'acronym' | 'short' | 'name' | 'phrase';

function answerKind(s: string): AnswerKind {
  const t = s.trim();
  if (/^\d{4}$/.test(t)) return 'year';
  if (/^\d+(\.\d+)?%$/.test(t)) return 'percent';
  if (/^\d+(\.\d+)?$/.test(t)) return 'number';
  if (/^[A-Z0-9]{2,10}$/.test(t)) return 'acronym';
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1 && t.length <= 6) return 'short';
  if (words.length >= 2 && words.every((w) => /^[A-Z][a-z'.-]*$/.test(w))) return 'name';
  if (words.length >= 2) return 'phrase';
  return 'short';
}

const NUMBER_WORDS = new Set([
  'zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty',
  'thirty','forty','fifty','sixty','seventy','eighty','ninety','hundred','thousand',
]);

function isNumberLike(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (/^\d+(\.\d+)?%?$/.test(t)) return true;
  if (NUMBER_WORDS.has(t)) return true;
  if (/^\d+(st|nd|rd|th)$/.test(t)) return true; // 19th
  return false;
}

function isProperNounLike(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!/^[A-Z]/.test(t)) return false;
  // avoid abstract -isms etc when looking for places/people
  if (/(ism|ology|ocracy|acy|ence|ness|tion|sion|ment|ship|tude|ity)$/i.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  // allow "New York", "East African Plateau", etc.
  const connectors = new Set(['and', 'of', 'the', '&', 'de', 'da', 'di', 'la', 'le', 'van', 'von', 'no']);
  return words.every((w, i) => {
    if (i > 0 && connectors.has(w.toLowerCase())) return true;
    return /^[A-Z][A-Za-z'.-]*$/.test(w) || /^[A-Z]{2,5}$/.test(w);
  });
}

type Desired = 'numeric' | 'person' | 'place' | 'anything';

function desiredTypeFromClue(clue: string): Desired {
  const c = clue.toLowerCase();
  if (/(how many|how long|what year|which year|which century|in what year|approximately how many|what number|what percent|%|ratio|fraction)/.test(c)) {
    return 'numeric';
  }
  if (/(^|\W)(who|founded by|invented by|reformer|emperor|leader|general|president|prime minister)(\W|$)/.test(c) || /\bking\b|\bqueen\b/.test(c)) {
    return 'person';
  }
  if (/(capital|city|country|continent|island|river|mountain|sea|ocean|plateau|desert|passage|strait|bay|gulf|lake|empire|kingdom|dynasty)/.test(c)) {
    return 'place';
  }
  return 'anything';
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9% ]+/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length >= 3 && x !== 'the' && x !== 'and' && x !== 'with' && x !== 'from');
}

function similarityScore(answer: string, candidate: string): number {
  if (!candidate || candidate === answer) return -1e9;
  const a = answer.trim();
  const b = candidate.trim();

  const ka = answerKind(a);
  const kb = answerKind(b);
  let score = 0;
  if (ka === kb) score += 3;
  if ((ka === 'year' || ka === 'number' || ka === 'percent') && kb === ka) {
    const na = Number(a.replace('%', ''));
    const nb = Number(b.replace('%', ''));
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      const diff = Math.abs(na - nb);
      score += Math.max(0, 3 - Math.min(3, diff / (ka === 'year' ? 10 : 5)));
    }
  }

  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length > 0 && tb.length > 0) {
    const setA = new Set(ta);
    let inter = 0;
    for (const t of tb) if (setA.has(t)) inter += 1;
    const union = new Set([...ta, ...tb]).size || 1;
    score += (inter / union) * 4;
  }

  const lenA = a.length;
  const lenB = b.length;
  const ratio = Math.min(lenA, lenB) / Math.max(lenA, lenB);
  score += ratio * 1.5;

  // Penalize obviously-giveaway distractors in higher grades
  const giveaway = /\b(always|never|only|just|forever|nothing happened)\b/i.test(b);
  if (giveaway) score -= 1.25;

  return score;
}

function pickBetterDistractors(
  clue: string,
  answer: string,
  existing: string[],
  corpus: string[],
): [string, string, string] {
  const candidates = new Set<string>();
  for (const d of existing) if (d && d !== answer) candidates.add(d);

  // Add corpus answers (same subject+grade) as plausible distractors
  for (let i = 0; i < corpus.length; i += 1) {
    const c = corpus[i];
    if (c && c !== answer) candidates.add(c);
    if (candidates.size >= 500) break; // keep scoring cheap but allow global fallbacks
  }

  const desired = desiredTypeFromClue(clue);
  const aKind = answerKind(answer);
  const ansTokens = tokenize(answer);
  const filtered = [...candidates].filter((c) => {
    if (c === answer) return false;
    if (desired === 'numeric') return isNumberLike(c);
    if (desired === 'person') return answerKind(c) === 'name' || isProperNounLike(c);
    if (desired === 'place') return isProperNounLike(c);
    return true;
  });

  const filteredByShape = (filtered.length >= 6 ? filtered : [...candidates]).filter((c) => {
    const k = answerKind(c);
    // If the answer is a multi-word phrase, avoid acronyms/numbers/single-word distractors.
    if (aKind === 'phrase') {
      if (!(k === 'phrase' || k === 'name')) return false;
      // If the answer has meaningful tokens, require at least one token overlap to avoid random fillers.
      if (ansTokens.length >= 2) {
        const candTokens = tokenize(c);
        const setA = new Set(ansTokens);
        const overlap = candTokens.some((t) => setA.has(t));
        if (!overlap) return false;
      }
      return true;
    }
    // If the answer is an acronym, keep acronym-like.
    if (aKind === 'acronym') return k === 'acronym';
    // If the answer is a year/number/percent, keep numeric-like.
    if (aKind === 'year') return k === 'year';
    if (aKind === 'percent') return k === 'percent' || k === 'number';
    if (aKind === 'number') return k === 'number' || k === 'percent' || isNumberLike(c);
    // If the answer is a person/place name, prefer proper-noun-like distractors.
    if (aKind === 'name') return isProperNounLike(c);
    // If answer is a short token, avoid long phrases.
    if (aKind === 'short') return k === 'short' || k === 'acronym' || k === 'number' || k === 'year';
    return true;
  });

  const pool = filteredByShape.length >= 10 ? filteredByShape : (filtered.length >= 10 ? filtered : [...candidates]);

  const ranked = pool
    .map((c) => ({ c, s: similarityScore(answer, c) }))
    .filter((x) => x.s > -1e8)
    .sort((x, y) => y.s - x.s)
    .map((x) => x.c);

  // If we still don't have enough, fall back to existing (already included) and then harmless fillers.
  const out: string[] = [];
  for (const c of ranked) {
    if (c === answer) continue;
    if (out.includes(c)) continue;
    out.push(c);
    if (out.length >= 3) break;
  }

  while (out.length < 3) out.push('None of the above');
  return [out[0], out[1], out[2]];
}

function matchesDesired(desired: Desired, option: string): boolean {
  if (!option) return false;
  if (desired === 'numeric') return isNumberLike(option);
  if (desired === 'person') return answerKind(option) === 'name' || isProperNounLike(option);
  if (desired === 'place') return isProperNounLike(option);
  return true;
}

function shouldRewriteDistractors(clue: string, answer: string, existing: string[], grade: Grade): boolean {
  if (grade < 4) return false;
  const desired = desiredTypeFromClue(clue);
  const cleaned = existing.filter((x) => x && x !== answer);
  if (cleaned.length < 3) return true;

  // If distractors contain obvious giveaway phrasing, rewrite.
  const giveaway = cleaned.some((d) => /\b(always|never|only|just|forever|nothing happened)\b/i.test(d));
  if (giveaway) return true;

  // For higher-grade definition questions, generic "A ___" distractors are too easy.
  const isDefinitiony =
    answerKind(answer) === 'phrase' ||
    /^(what is|what does|what is the|define)\b/i.test(clue.trim());
  const genericA = cleaned.filter((d) => /^\s*a[n]?\b/i.test(d)).length;
  if (isDefinitiony && genericA >= 2) return true;

  // If this is a phrase answer and the existing distractors are already semantically close (token overlap),
  // keep them to avoid rewriting into unrelated phrases.
  if (answerKind(answer) === 'phrase') {
    const aTok = tokenize(answer);
    if (aTok.length >= 2) {
      const setA = new Set(aTok);
      const overlapCount = cleaned.filter((d) => tokenize(d).some((t) => setA.has(t))).length;
      if (overlapCount >= 2) return false;
    }
  }

  // If at least 2 distractors match the desired type AND are reasonably similar in "shape", keep them.
  const matchCount = cleaned.filter((d) => matchesDesired(desired, d)).length;
  if (desired !== 'anything' && matchCount < 2) return true;
  // For person/place questions, token overlap is not expected; type-correct distractors are sufficient.
  if ((desired === 'person' || desired === 'place') && matchCount === 3) return false;
  const sims = cleaned.map((d) => similarityScore(answer, d)).sort((a, b) => b - a);
  const strong = matchCount >= 2 && (sims[0] ?? 0) >= 2.0;
  if (strong) return false;

  // Otherwise, rewrite (this is where the original seeds tend to be too easy).
  return true;
}

function expandSeeds(rawSeeds: Fact[], grade?: Grade): FactPack[] {
  if (!rawSeeds || rawSeeds.length === 0) return [];

  // For higher grades, we strongly prefer plausible distractors from the same subject+grade pool
  const useSmart = grade != null && grade >= 4;
  const corpusAll = useSmart ? rawSeeds.map(([, ans]) => ans).filter(Boolean) : [];
  const corpusByDesired: Record<Desired, string[]> | null = useSmart
    ? rawSeeds.reduce(
        (acc, [clue, ans]) => {
          const d = desiredTypeFromClue(clue);
          acc[d].push(ans);
          return acc;
        },
        { numeric: [], person: [], place: [], anything: [] } as Record<Desired, string[]>,
      )
    : null;

  return rawSeeds.map(([clue, answer, d1, d2, d3]) => {
    const existing = [d1, d2, d3];
    const distractors =
      useSmart
        ? (
          shouldRewriteDistractors(clue, answer, existing, grade as Grade)
            ? pickBetterDistractors(
                clue,
                answer,
                existing,
                // Prefer same-type corpus; if too small, fall back to global then full grade corpus.
                (() => {
                  const d = desiredTypeFromClue(clue);
                  const sub = corpusByDesired?.[d] ?? [];
                  if (d === 'anything') {
                    // Definition-style questions benefit from a broader pool across subjects.
                    return [...sub, ...getGlobalCorpus('anything')];
                  }
                  if (sub.length >= 8) return sub;
                  const global = getGlobalCorpus(d);
                  return global.length >= 12 ? global : corpusAll;
                })(),
              )
            : (existing as [string, string, string])
        )
        : ([d1, d2, d3] as [string, string, string]);

    return {
      clue,
      answer,
      distractors,
    };
  });
}

/* ──────────────────────────────────────────────
   Stats & Maths: workplace stats seeds + 8,000+ arithmetic items per grade
   ────────────────────────────────────────────── */

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

const d3 = (a: string, b: string, c: string): [string, string, string] => [a, b, c];

function mathsFacts(grade: Grade): FactPack[] {
  const out: FactPack[] = [];
  const add = (clue: string, ans: string, x: string, y: string, z: string) =>
    out.push({ clue, answer: ans, distractors: d3(x, y, z) });

  if (grade === 1) {
    for (let a = 0; a <= 20; a++) {
      for (let b = 0; b <= 20; b++) {
        if (a + b <= 30) add(`${a} + ${b} = ?`, String(a + b), String(a + b + 1), String(Math.max(0, a + b - 1)), String(a + b + 2));
      }
    }
    for (let n = 1; n <= 100; n++) {
      add(`What number comes after ${n}?`, String(n + 1), String(n + 2), String(n), String(n - 1 || 1));
    }
    for (let n = 1; n <= 100; n++) {
      add(`Is ${n} odd or even?`, n % 2 === 0 ? 'Even' : 'Odd', n % 2 === 0 ? 'Odd' : 'Even', 'Neither', 'Both');
    }
    for (let a = 0; a <= 20; a++) {
      for (let b = a + 1; b <= 20; b++) {
        add(`Which is bigger: ${a} or ${b}?`, String(b), String(a), 'Equal', String(a + b));
      }
    }
    return out.slice(0, 8500);
  }

  if (grade === 2) {
    for (let a = 0; a <= 50; a++) {
      for (let b = 0; b <= 50; b++) {
        if (a + b <= 100) add(`${a} + ${b} = ?`, String(a + b), String(a + b + 1), String(Math.max(0, a + b - 1)), String(a + b + 3));
      }
    }
    for (let a = 1; a <= 50; a++) {
      for (let b = 1; b <= a; b++) {
        add(`${a} − ${b} = ?`, String(a - b), String(a - b + 1), String(a - b + 2), String(a + b));
      }
    }
    for (let n = 1; n <= 50; n++) {
      add(`Double ${n} is?`, String(n * 2), String(n * 2 + 1), String(n + 1), String(n * 3));
    }
    for (let n = 1; n <= 50; n++) {
      const even = n * 2;
      add(`Half of ${even} is?`, String(n), String(n + 1), String(n - 1 || 1), String(even));
    }
    return out.slice(0, 8500);
  }

  if (grade === 3) {
    for (let a = 2; a <= 12; a++) {
      for (let b = 2; b <= 12; b++) {
        add(`${a} × ${b} = ?`, String(a * b), String(a * b + 1), String(a * b - 1), String(a * (b + 1)));
        const p = a * b;
        add(`${p} ÷ ${a} = ?`, String(b), String(b + 1), String(b - 1 || 1), String(a));
      }
    }
    for (let n = 2; n <= 12; n++) {
      for (let k = 1; k <= 20; k++) {
        add(`Skip counting by ${n}: what comes after ${n * k}?`, String(n * (k + 1)), String(n * k + 1), String(n * (k + 2)), String(n * k - 1 || 1));
      }
    }
    for (let a = 10; a <= 99; a++) {
      for (let b = 1; b <= 9; b++) {
        add(`${a} + ${b} = ?`, String(a + b), String(a + b + 1), String(a + b - 1), String(a - b));
      }
    }
    return out.slice(0, 8500);
  }

  if (grade === 4) {
    for (let a = 2; a <= 15; a++) {
      for (let b = 2; b <= 15; b++) {
        add(`${a} × ${b} = ?`, String(a * b), String(a * b + 1), String(a * b - 1), String((a + 1) * b));
      }
    }
    for (let i = 1; i <= 100; i++) {
      const den = 2 + (i % 8);
      const num = i % (den * 3) + 1;
      add(`Which is larger: ${num}/${den} or 1?`, num > den ? `${num}/${den}` : num === den ? 'Equal' : '1', num > den ? '1' : `${num}/${den}`, 'Equal', 'Cannot tell');
    }
    for (let n = 1; n <= 100; n++) {
      add(`${n}% of 100 is?`, String(n), String(n + 10), String(n - 10 < 0 ? 0 : n - 10), String(n * 2));
    }
    for (let a = 10; a <= 99; a++) {
      for (let b = 2; b <= 9; b++) {
        if (a % b === 0) add(`${a} ÷ ${b} = ?`, String(a / b), String(a / b + 1), String(a / b - 1 || 1), String(b));
      }
    }
    return out.slice(0, 8500);
  }

  if (grade === 5) {
    for (let a = 3; a <= 20; a++) {
      for (let b = 3; b <= 20; b++) {
        add(`${a} × ${b} = ?`, String(a * b), String(a * b + 1), String(a * b - 1), String((a + 1) * b));
      }
    }
    for (let n = 2; n <= 100; n++) {
      const yes = isPrime(n);
      add(`Is ${n} prime?`, yes ? 'Yes' : 'No', yes ? 'No' : 'Yes', 'Maybe', 'Sometimes');
    }
    for (let n = 1; n <= 20; n++) {
      add(`${n}² = ?`, String(n * n), String(n * n + 1), String(n * n - 1), String(n * 2));
    }
    for (let n = 1; n <= 12; n++) {
      add(`√${n * n} = ?`, String(n), String(n + 1), String(n - 1 || 1), String(n * 2));
    }
    for (let base = 2; base <= 10; base++) {
      for (let exp = 2; exp <= 5; exp++) {
        const val = Math.pow(base, exp);
        if (val <= 10000) add(`${base}^${exp} = ?`, String(val), String(val + 1), String(val - 1), String(base * exp));
      }
    }
    return out.slice(0, 8500);
  }

  // grade === 6
  for (let a = 5; a <= 25; a++) {
    for (let b = 5; b <= 25; b++) {
      add(`${a} × ${b} = ?`, String(a * b), String(a * b + 1), String(a * b - 1), String((a + 1) * (b + 1)));
    }
  }
  for (let n = 2; n <= 150; n++) {
    const yes = isPrime(n);
    add(`Is ${n} prime?`, yes ? 'Yes' : 'No', yes ? 'No' : 'Yes', 'Maybe', 'Sometimes');
  }
  for (let n = 1; n <= 25; n++) {
    add(`${n}² = ?`, String(n * n), String(n * n + 1), String(n * n - 1), String(n * 2));
  }
  for (let i = 0; i < 100; i++) {
    const den = 3 + (i % 9);
    const num = 2 * den + (i % 5);
    add(`Compare ${num}/${den} to 1`, num > den ? 'Greater than 1' : 'Less than 1', num > den ? 'Less than 1' : 'Greater than 1', 'Equal', 'Cannot tell');
  }
  for (let a = 1; a <= 20; a++) {
    for (let b = 1; b <= 20; b++) {
      const gcdVal = gcd(a, b);
      if (gcdVal > 1 && a !== b) add(`GCD of ${a} and ${b}?`, String(gcdVal), String(gcdVal + 1), String(Math.min(a, b)), String(1));
    }
  }
  return out.slice(0, 8500);
}

function gcd(a: number, b: number): number {
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function statsAndMathsFacts(grade: Grade): FactPack[] {
  const stats = expandSeeds(workplaceStats[grade] ?? [], grade);
  const maths = mathsFacts(grade);
  return [...stats, ...maths].slice(0, 8500);
}

/* ──────────────────────────────────────────────
   Seed map: subject → grade → Fact[]
   ────────────────────────────────────────────── */

const SEED_MAP: Record<string, Record<number, Fact[]>> = {
  'World History': worldHistory,
  'World Geography': geography,
  'World Religion & Mythology': wrm,
  'General Science': science,
  NBA: nba,
  NHL: nhl,
  Sports: sports,
  'Pop Culture': popCulture,
  'Canadian History': canadianHistory,
  'World Politics': worldPolitics,
  FinTech: fintech,
};

let _globalCorpus: Record<Desired, string[]> | null = null;

function getGlobalCorpus(desired: Desired): string[] {
  if (_globalCorpus) return _globalCorpus[desired] ?? [];

  const acc: Record<Desired, string[]> = { numeric: [], person: [], place: [], anything: [] };
  const add = (d: Desired, a: string) => {
    if (!a) return;
    acc[d].push(a);
  };

  for (const subject of Object.keys(SEED_MAP)) {
    const byGrade = SEED_MAP[subject];
    for (const gStr of Object.keys(byGrade)) {
      const facts = byGrade[Number(gStr)];
      for (const [clue, ans] of facts) {
        const d = desiredTypeFromClue(clue);
        add(d, ans);
      }
    }
  }

  // Deduplicate while preserving order
  for (const k of Object.keys(acc) as Desired[]) {
    const seen = new Set<string>();
    acc[k] = acc[k].filter((x) => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
  }

  _globalCorpus = acc;
  return _globalCorpus[desired] ?? [];
}

/* ──────────────────────────────────────────────
   Cache: avoid regenerating 8000+ items each call
   ────────────────────────────────────────────── */

const _cache = new Map<string, FactPack[]>();

export function getFactsForSubjectGrade(subject: Subject, grade: Grade): FactPack[] {
  const key = `${subject}-${grade}`;
  const cached = _cache.get(key);
  if (cached) return cached;

  let pool: FactPack[];
  if (subject === 'Stats & Maths') {
    pool = statsAndMathsFacts(grade);
  } else {
    const seeds = SEED_MAP[subject]?.[grade];
    pool = seeds ? expandSeeds(seeds, grade) : [];
  }

  _cache.set(key, pool);
  return pool;
}

export function getQuestionPoolSize(subject: Subject, grade: Grade): number {
  return getFactsForSubjectGrade(subject, grade).length;
}
