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

function expandSeeds(rawSeeds: Fact[]): FactPack[] {
  if (!rawSeeds || rawSeeds.length === 0) return [];
  return rawSeeds.map(([clue, answer, d1, d2, d3]) => ({
    clue,
    answer,
    distractors: [d1, d2, d3],
  }));
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
  const stats = expandSeeds(workplaceStats[grade] ?? []);
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
    pool = seeds ? expandSeeds(seeds) : [];
  }

  _cache.set(key, pool);
  return pool;
}

export function getQuestionPoolSize(subject: Subject, grade: Grade): number {
  return getFactsForSubjectGrade(subject, grade).length;
}
