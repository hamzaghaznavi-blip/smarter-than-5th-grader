/** Static, GPU-cheap backdrop only — no particles, no spinning beams, no drift animations. */
export type WowMode = 'idle' | 'finale' | 'question';

export function WowAmbience({ mode }: { mode: WowMode }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[1] overflow-hidden" aria-hidden>
      {mode === 'question' ? (
        <div className="absolute inset-0 bg-[#050608]" />
      ) : (
        <>
          <div className="absolute inset-0 bg-gradient-to-b from-[#0a0a0f] via-[#08090e] to-[#0a0a0f]" />
          <div className="absolute inset-0 opacity-[0.28] bg-[radial-gradient(ellipse_100%_75%_at_50%_-5%,rgba(59,130,246,0.16),transparent_55%)]" />
          {mode === 'finale' && (
            <div className="absolute inset-0 opacity-[0.22] bg-[radial-gradient(ellipse_80%_55%_at_50%_100%,rgba(139,92,246,0.14),transparent_55%)]" />
          )}
        </>
      )}
    </div>
  );
}
