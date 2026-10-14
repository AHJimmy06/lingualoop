import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { authSession } from '../../auth-session';
import { Button } from '../../components/ui/button';
import { RoleHeader } from '../auth/RoleHeader';
import { LanguagePracticeClient, LanguagePracticeClientError, LANGUAGE_PRACTICE_LEVELS, LANGUAGE_PRACTICE_DURATIONS, LANGUAGE_PRACTICE_DIFFICULTIES, type CreatePractice } from '../language-practice/language-practice-client';
import { validateCreatePractice, validatePracticeImage } from '../language-practice/practice-contract';
import { difficultyLabel } from '../language-practice/practice-preferences';
import { PracticeCardPreview } from '../language-practice/PracticeCardPreview';
import { TeacherPracticesDialog } from './TeacherPracticesDialog';

export function TeacherPracticesView() {
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [catalogueVersion, setCatalogueVersion] = useState(0);
  const [title, setTitle] = useState('');
  const [setup, setSetup] = useState<CreatePractice['setup']>({ level: 'A1', durationMinutes: 5, difficulty: 'medium' });
  const [image, setImage] = useState<File | undefined>();
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [imageError, setImageError] = useState('');
  const imagePicker = useRef<HTMLInputElement>(null);
  const [requirements, setRequirements] = useState(['']);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!image) { setPreview(null); return; }
    const url = URL.createObjectURL(image);
    setPreview({ file: image, url });
    return () => URL.revokeObjectURL(url);
  }, [image]);
  function removeImage() {
    if (pending.current) return;
    setImage(undefined); setImageError('');
    if (imagePicker.current) imagePicker.current.value = '';
  }
  function chooseImage(file: File | undefined) {
    if (pending.current) return;
    setImage(undefined); setImageError('');
    if (!file) return;
    try { validatePracticeImage(file); setImage(file); }
    catch { setImageError('Choose a JPEG, PNG or WebP image no larger than 2 MiB.'); }
  }
  const input = { title: title.trim(), setup, parameters: requirements.map(requirement => ({ requirement: requirement.trim() })) };
  let valid = true;
  try { validateCreatePractice(input); } catch { valid = false; }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || imageError || pending.current) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await client.createPractice(input, image);
      setImage(undefined); setImageError('');
      if (imagePicker.current) imagePicker.current.value = '';
      setTitle(''); setRequirements(['']); setMessage('Practice created and available to all students.');
      setCatalogueVersion(value => value + 1);
    } catch (failure) {
      setError(failure instanceof LanguagePracticeClientError ? failure.message : 'The practice was not confirmed. Try again.');
    } finally { pending.current = false; setBusy(false); }
  }
  return <main className="w-full min-w-0 px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
    <RoleHeader title="Your practices" description="Create guided conversations for all students. Settings stay fixed when students start." />
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,42rem)_minmax(0,1fr)] xl:gap-8">
    <form className="grid w-full min-w-0 max-w-3xl gap-5 rounded-xl border bg-card p-4 sm:p-6" onSubmit={event => void submit(event)} aria-label="Create practice">
      <h2 className="text-lg font-semibold">Create practice</h2>
      <label className="grid gap-2 text-sm">Conversation theme<input className="rounded-md border bg-background p-3" required maxLength={120} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2"><legend className="mb-3 text-sm font-semibold">Fixed conversation settings</legend>
        <label className="grid gap-2 text-sm">CEFR target level<select className="rounded-md border bg-background p-3" value={setup.level} onChange={event => setSetup({ ...setup, level: event.target.value as CreatePractice['setup']['level'] })}>{LANGUAGE_PRACTICE_LEVELS.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="grid gap-2 text-sm">Duration<select className="rounded-md border bg-background p-3" value={setup.durationMinutes} onChange={event => setSetup({ ...setup, durationMinutes: Number(event.target.value) as CreatePractice['setup']['durationMinutes'] })}>{LANGUAGE_PRACTICE_DURATIONS.map(value => <option key={value} value={value}>{value} minutes</option>)}</select></label>
        <label className="grid gap-2 text-sm">Task difficulty<select className="rounded-md border bg-background p-3" value={setup.difficulty} onChange={event => setSetup({ ...setup, difficulty: event.target.value as CreatePractice['setup']['difficulty'] })}>{LANGUAGE_PRACTICE_DIFFICULTIES.map(value => <option key={value} value={value}>{difficultyLabel(value)}</option>)}</select></label>
        <p className="text-sm text-muted-foreground sm:col-span-2">Difficulty is fixed task demand, not assessed proficiency. It does not change the CEFR target.</p>
      </fieldset>
      <fieldset disabled={busy} className="grid gap-3"><legend className="mb-3 text-sm font-semibold">Conversational requirements (1–20)</legend>
        {requirements.map((value, index) => <div key={index} className="grid gap-2">
          <label className="grid gap-2 text-sm">Requirement {index + 1}<textarea className="rounded-md border bg-background p-3" rows={2} required maxLength={500} value={value} onChange={event => setRequirements(current => current.map((item, at) => at === index ? event.target.value : item))} /></label>
          <Button type="button" variant="outline" disabled={requirements.length === 1} onClick={() => setRequirements(current => current.filter((_, at) => at !== index))}>Remove requirement {index + 1}</Button>
        </div>)}
        <Button type="button" variant="outline" disabled={requirements.length >= 20} onClick={() => setRequirements(current => [...current, ''])}>Add requirement</Button>
      </fieldset>
      <fieldset disabled={busy} className="grid min-w-0 gap-3">
        <legend className="mb-3 text-sm font-semibold">Cover image (optional)</legend>
        <label className="grid min-w-0 gap-2 text-sm">JPEG, PNG or WebP · up to 2 MiB
          <input ref={imagePicker} className="w-full min-w-0 rounded-md border p-3" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => chooseImage(event.target.files?.[0])} />
        </label>
        <p className="text-sm text-muted-foreground">Cover only; not used by the conversation or report AI.</p>
        {(image || imageError) && <Button type="button" variant="outline" onClick={removeImage}>Remove image</Button>}
        {imageError && <p role="alert">{imageError}</p>}
      </fieldset>
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <Button type="submit" disabled={!valid || !!imageError || busy}>{busy ? 'Creating…' : 'Create practice'}</Button>
    </form>
    <PracticeCardPreview title={title} setup={setup} requirements={requirements}
      imageUrl={preview && preview.file === image ? preview.url : undefined}
      onImageError={() => { setImage(undefined); setImageError('This image could not be displayed. Choose another image or remove it.'); }} />
    </div>
    <div className="mt-6"><TeacherPracticesDialog catalogueVersion={catalogueVersion} /></div>
  </main>;
}
