import type { Fact } from './group1';
import { grade1, grade2, grade3 } from './pop_part1';
import { grade4, grade5, grade6 } from './pop_part2';

/** Toronto diaspora pop culture: ~65% Western / 35% Desi, difficulty scales by grade. */
export const popCulture: Record<number, Fact[]> = {
  1: grade1,
  2: grade2,
  3: grade3,
  4: grade4,
  5: grade5,
  6: grade6,
};
