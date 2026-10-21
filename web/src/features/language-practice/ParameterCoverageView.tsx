import type { ParameterCoverage } from './language-practice-client';

const labels = { met: 'Met', partial: 'Partially met', 'not-met': 'Not met', unassessed: 'Not assessed' };
const tones = { met: 'bg-emerald-50 text-emerald-950', partial: 'bg-amber-50 text-amber-950', 'not-met': 'bg-red-50 text-red-950', unassessed: 'bg-muted text-muted-foreground' };

export function ParameterCoverageView({ coverage, turnLinksAvailable = false }: { coverage: ParameterCoverage[]; turnLinksAvailable?: boolean }) {
  return <section className="min-w-0" aria-labelledby="coverage-title">
    <h2 id="coverage-title" className="text-lg font-semibold">Practice goal coverage</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">This table shows whether the conversation included evidence for each teacher-defined goal. It is based on the recognized student text, not keyword counts. A turn number is the order of a completed student speaking attempt; select it to find that transcript above.</p>
    {coverage.length === 0 ? <p className="mt-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">This practice has no teacher-defined requirements.</p> : <div className="mt-4 overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[48rem] table-fixed border-collapse text-left text-sm">
        <caption className="sr-only">Teacher-defined practice goals, evidence status, explanation and relevant completed turns</caption>
        <thead className="bg-muted"><tr>
          <th className="w-[28%] border-b px-4 py-3 font-semibold" scope="col">Practice goal</th>
          <th className="w-[16%] border-b px-4 py-3 font-semibold" scope="col">Evidence status</th>
          <th className="w-[36%] border-b px-4 py-3 font-semibold" scope="col">What the evidence means</th>
          <th className="w-[20%] border-b px-4 py-3 font-semibold" scope="col">Turn references</th>
        </tr></thead>
        <tbody>{coverage.map(item => <tr key={item.parameterId} className="align-top even:bg-muted/30">
          <th className="border-b px-4 py-4 font-medium" scope="row">{item.requirement}</th>
          <td className="border-b px-4 py-4"><span className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${tones[item.status]}`}>{labels[item.status]}</span>
            {item.status === 'unassessed' && <p className="mt-2 text-xs leading-5 text-muted-foreground">Not assessed. This is not a failed requirement.</p>}</td>
          <td className="whitespace-pre-wrap border-b px-4 py-4 leading-6">{item.explanation}</td>
          <td className="border-b px-4 py-4">{item.evidenceSequences.length > 0 ? <div className="flex flex-wrap gap-2">{item.evidenceSequences.map(sequence => turnLinksAvailable
            ? <a key={sequence} className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary underline underline-offset-2" href={`#turn-${sequence}`}>Turn {sequence}</a>
            : <span key={sequence} className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium">Turn {sequence}</span>)}</div> : <span className="text-sm text-muted-foreground">No completed student turn evidence cited.</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}
