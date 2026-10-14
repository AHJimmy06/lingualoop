import type { CreatePractice } from './language-practice-client';
import { difficultyLabel } from './practice-preferences';

/** A draft presenter, not a persisted practice or an interactive student card. */
export function PracticeCardPreview({ title, setup, requirements, imageUrl, onImageError }: {
  title: string;
  setup: CreatePractice['setup'];
  requirements: string[];
  imageUrl?: string;
  onImageError?: () => void;
}) {
  const visibleRequirements = requirements.filter(requirement => requirement.trim());
  return <section className="min-w-0 rounded-xl border bg-card p-4 [overflow-wrap:anywhere] sm:p-6" aria-labelledby="draft-preview-title">
    <h2 id="draft-preview-title" className="text-lg font-semibold">Student-facing preview</h2>
    <p className="mt-2 text-sm text-muted-foreground">Not saved · This draft shows the theme, fixed settings and requirements students will see. It cannot start a session.</p>
    <article className="mt-5 min-w-0 rounded-xl border p-5">
      {imageUrl ? <img src={imageUrl} alt="Selected cover preview" className="mb-4 h-40 w-full rounded-lg object-cover" onError={onImageError} />
        : <div className="mb-4 flex h-40 items-center justify-center rounded-lg border border-dashed bg-muted/30 p-4 text-center text-sm text-muted-foreground">Preview placeholder · No cover selected. This placeholder is not saved.</div>}
      <h3 className="text-lg font-semibold whitespace-pre-wrap">{title.trim() ? title : 'Your conversation theme'}</h3>
      <dl className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
        <div><dt>CEFR target</dt><dd>{setup.level}</dd></div>
        <div><dt>Task difficulty</dt><dd>{difficultyLabel(setup.difficulty)}</dd></div>
        <div><dt>Duration</dt><dd>{setup.durationMinutes} minutes</dd></div>
      </dl>
      <h4 className="mt-4 text-sm font-semibold">Conversational requirements</h4>
      {visibleRequirements.length ? <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">{visibleRequirements.map((requirement, index) => <li key={index} className="whitespace-pre-wrap">{requirement}</li>)}</ol>
        : <p className="mt-2 text-sm text-muted-foreground">Add requirements to see them here.</p>}
    </article>
  </section>;
}
