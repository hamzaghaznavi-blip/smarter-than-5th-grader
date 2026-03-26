import { cn } from './lib/utils';

export type WowMode = 'off' | 'idle' | 'warm' | 'hot' | 'finale';

/**
 * Purely decorative “game show” ambience — pointer-events none, no game logic.
 * - idle: lobby / grade select
 * - warm: question grades 1–3 (cooler)
 * - hot: question grades 4–6 (screen “heats up”)
 * - finale: subject results / game over
 */
export function WowAmbience({ mode }: { mode: WowMode }) {
  if (mode === 'off') return null;
  const questionHeat = mode === 'warm' || mode === 'hot';

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[1] overflow-hidden"
      aria-hidden
    >
      {/* Slow-moving colour fields */}
      <div
        className={cn(
          'wow-mesh absolute inset-[-15%]',
          mode === 'warm' && 'wow-mesh--warm',
          mode === 'hot' && 'wow-mesh--hot',
          mode === 'finale' && 'wow-mesh--finale',
        )}
      />
      {/* Rotating conic wash — very subtle */}
      <div
        className={cn(
          'wow-beams absolute inset-0 opacity-40',
          mode === 'warm' && 'wow-beams--warm',
          mode === 'hot' && 'wow-beams--hot',
          mode === 'finale' && 'wow-beams--finale',
        )}
      />
      {/* Bokeh dots */}
      <div
        className={cn(
          'absolute inset-0 wow-particles',
          mode === 'hot' && 'wow-particles--hot',
          mode === 'warm' && 'wow-particles--warm',
        )}
      >
        {PARTICLE_SEEDS.map((s, i) => (
          <span
            key={i}
            className="wow-particle"
            style={{
              left: `${s.x}%`,
              top: `${s.y}%`,
              animationDelay: `${s.d}s`,
              animationDuration: `${10 + (i % 5) + (mode === 'hot' ? -2 : mode === 'warm' ? 2 : 0)}s`,
            }}
          />
        ))}
      </div>
      {/* Edge warmth — mild (G1–3) vs intense (G4–6) */}
      {questionHeat && (
        <div
          className={cn(
            'absolute inset-0 wow-heat-vignette',
            mode === 'warm' && 'wow-heat-vignette--warm',
            mode === 'hot' && 'wow-heat-vignette--hot',
          )}
        />
      )}
    </div>
  );
}

/** Fixed positions so layout is stable (no random per mount). */
const PARTICLE_SEEDS = [
  { x: 8, y: 12, d: 0 },
  { x: 18, y: 78, d: 0.4 },
  { x: 92, y: 18, d: 0.8 },
  { x: 85, y: 65, d: 1.2 },
  { x: 45, y: 8, d: 1.6 },
  { x: 62, y: 88, d: 2 },
  { x: 30, y: 42, d: 2.4 },
  { x: 72, y: 35, d: 2.8 },
  { x: 12, y: 52, d: 3.2 },
  { x: 55, y: 22, d: 3.6 },
  { x: 38, y: 92, d: 4 },
  { x: 95, y: 48, d: 4.4 },
  { x: 5, y: 88, d: 4.8 },
  { x: 68, y: 12, d: 5.2 },
];
