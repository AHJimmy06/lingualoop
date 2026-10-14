import type { ParameterCoverage } from './language-practice-client';
const labels = { met: 'Met', partial: 'Partially met', 'not-met': 'Not met', unassessed: 'Not assessed' };
const tones = { met: 'bg-emerald-50 text-emerald-950', partial: 'bg-amber-50 text-amber-950', 'not-met': 'bg-red-50 text-red-950', unassessed: 'bg-muted text-muted-foreground' };
export function ParameterCoverageView({ coverage }: { coverage: ParameterCoverage[] }) {
  return <section className="min-w-0" aria-labelledby="coverage-title">
    <h2 id="coverage-title" className="text-lg font-semibold">Conversational requirement coverage</h2>
    <p className="mt-2 text-sm text-muted-foreground">Coverage reflects saved conversational evidence, not keyword matching.</p>
    {coverage.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">This practice has no teacher-defined requirements.</p> : <div className="mt-4 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4">{coverage.map(item => <article key={item.parameterId} className="min-w-0 rounded-xl border bg-card p-5 [overflow-wrap:anywhere]">
      <h3 className="text-sm font-semibold">{item.requirement}</h3>
      <p className={`mt-3 w-fit rounded-md px-3 py-1 text-sm font-medium ${tones[item.status]}`}>{labels[item.status]}</p>
      {item.status === 'unassessed' && <p className="mt-2 text-sm text-muted-foreground">Insufficient evidence to assess; this is not a failed requirement.</p>}
      <dl className="mt-3 grid gap-3 text-sm"><div><dt className="font-semibold">Explanation</dt><dd className="mt-1">{item.explanation}</dd></div>
        <div><dt className="font-semibold">Turn evidence</dt><dd className="mt-1">{item.evidenceSequences.length ? item.evidenceSequences.map(sequence => `Turn ${sequence}`).join(', ') : 'No completed student turn evidence cited.'}</dd></div>
      </dl>
    </article>)}</div>}
  </section>;
}
