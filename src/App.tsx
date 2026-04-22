import { lazy, Suspense } from 'react';
import './smarter-than-5th-grader.css';

const SmarterThan5thGraderApp = lazy(() => import('./SmarterThan5thGraderApp'));

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center gap-4 text-slate-600 font-mono text-sm">
      <div
        className="w-10 h-10 rounded-full border-2 border-slate-300 border-t-emerald-600 animate-spin"
        aria-hidden
      />
      <span>Loading game…</span>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <SmarterThan5thGraderApp />
    </Suspense>
  );
}
