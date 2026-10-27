import type { ReportLearningSupport } from './language-practice-client';


type LearningNote = ReportLearningSupport['strengths'][number];

/** English observations stay in evidence-linked rows; Spanish is available on demand. */
export function ReportLearningNotes({ id, title, notes, legacyNotes, emptyMessage, turnLinksAvailable }: {
  id: string;
  title: string;
  notes?: LearningNote[];
  legacyNotes: string[];
  emptyMessage: string;
  turnLinksAvailable: boolean;
}) {
  return <section className="min-w-0 rounded-xl border bg-card p-5 shadow-sm sm:p-6" aria-labelledby={id}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 id={id} className="text-lg font-semibold">{title}</h2>
    </div>
    {notes ? notes.length > 0 ? <div className="mt-4 overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[30rem] table-fixed border-collapse text-left text-sm">
        <caption className="sr-only">{title}: English annotations and supporting conversation turns</caption>
        <thead className="bg-muted"><tr>
          <th className="w-[60%] border-b px-3 py-3 font-semibold" scope="col">English annotation</th>
          <th className="w-[16%] border-b px-3 py-3 font-semibold" scope="col">Turn</th>

        </tr></thead>
        <tbody>{notes.map((note, index) => <tr className="align-top even:bg-muted/30" key={index}>
          <td lang="en" className="whitespace-pre-wrap border-b px-3 py-4 leading-6">{note.textEn}</td>
          <td className="border-b px-3 py-4 leading-6">{note.evidenceSequences.length ? <ul className="grid gap-1">{note.evidenceSequences.map(sequence => <li key={sequence}>{turnLinksAvailable
            ? <a className="text-primary underline underline-offset-2" href={`#turn-${sequence}`}>Turn {sequence}</a> : `Turn ${sequence}`}</li>)}</ul>
            : <span className="text-muted-foreground">Session-wide</span>}</td>

        </tr>)}</tbody>
      </table>
    </div> : <p className="mt-3 text-sm leading-6 text-muted-foreground">{emptyMessage}</p>
      : <div className="mt-3 text-sm leading-6 text-muted-foreground">
        <p>Original saved annotations are available below.</p>
        {legacyNotes.length > 0 && <details className="mt-3 rounded-lg border p-3"><summary className="cursor-pointer font-medium">Saved notes</summary>
          <ul lang="en" className="mt-2 grid list-disc gap-2 pl-5">{legacyNotes.map((note, index) => <li className="whitespace-pre-wrap" key={index}>{note}</li>)}</ul>
        </details>}
      </div>}
  </section>;
}
