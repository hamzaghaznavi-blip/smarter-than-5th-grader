/** Solid full-viewport backdrop — same in every phase (matches published gh-pages build; avoids question-only paint mismatch). */
export type WowMode = 'idle' | 'finale' | 'question';

export function WowAmbience({ mode: _mode }: { mode: WowMode }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
      <div className="absolute inset-0 bg-slate-100" />
    </div>
  );
}
