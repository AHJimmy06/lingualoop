import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Settings, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import type { PracticeOptions } from './practice-options';
import { type PracticePreferences } from './practice-preferences';

export function PracticeSettingsDialog({ options, value, onSave, disabled = false }: {
  options: PracticeOptions | null; value: PracticePreferences; onSave: (value: PracticePreferences) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return <Dialog.Root open={open} onOpenChange={next => { if (next) setDraft(value); setOpen(next); }}>
    <span className="group relative inline-flex">
      <Dialog.Trigger render={<Button variant="outline" size="icon" />} disabled={disabled || !options} aria-label="Default practice settings" aria-describedby="settings-tooltip"><Settings className="size-4" aria-hidden="true" /></Dialog.Trigger>
      <span id="settings-tooltip" role="tooltip" className="pointer-events-none absolute right-0 top-full z-10 mt-2 w-44 rounded-md bg-foreground p-2 text-center text-xs text-background opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">Default practice settings</span>
    </span>
    <Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90svh] w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3"><Dialog.Title className="text-xl font-semibold">Default practice settings</Dialog.Title><Dialog.Close render={<Button size="icon" variant="ghost" />} aria-label="Close settings"><X className="size-4" aria-hidden="true" /></Dialog.Close></div>
        <Dialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">Apply these settings to default activities only. Teacher challenges always use their fixed settings. Choose difficulty on each activity card.</Dialog.Description>
        <form className="mt-5 grid gap-4" onSubmit={event => { event.preventDefault(); onSave(draft); setOpen(false); }}>
          <label className="grid gap-2 text-sm font-medium">CEFR target<select className="h-11 rounded-lg border bg-background px-3" value={draft.level} onChange={event => setDraft({ ...draft, level: event.target.value as PracticePreferences['level'] })}>{options?.levels.map(level => <option key={level}>{level}</option>)}</select></label>
          <label className="grid gap-2 text-sm font-medium">Practice duration<select className="h-11 rounded-lg border bg-background px-3" value={draft.durationMinutes} onChange={event => setDraft({ ...draft, durationMinutes: Number(event.target.value) as PracticePreferences['durationMinutes'] })}>{options?.durationsMinutes.map(duration => <option key={duration} value={duration}>{duration} minutes</option>)}</select></label>
          <Button type="submit" disabled={disabled || !options}>Save settings</Button>
        </form>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
