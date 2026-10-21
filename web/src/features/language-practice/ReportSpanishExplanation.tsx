import { Dialog } from '@base-ui/react/dialog';
import { Languages, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ReportSpeechButton } from './ReportSpeechButton';

/** Opens already-saved Spanish support; opening this dialog never requests AI or audio. */
export function ReportSpanishExplanation({ title, translation, explanations, label = 'Explain in Spanish' }: {
  title: string;
  translation?: string;
  explanations: string[];
  label?: string;
}) {
  return <Dialog.Root>
    <Dialog.Trigger render={<Button type="button" variant="outline" size="icon" />} title={label} aria-label={label}><Languages className="size-4" aria-hidden="true" /></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[85svh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-6 shadow-xl [overflow-wrap:anywhere]">
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title className="text-xl font-semibold">{title} · Español</Dialog.Title>
          <Dialog.Close render={<Button type="button" variant="ghost" size="icon" />} title="Close Spanish explanation" aria-label="Close Spanish explanation"><X className="size-4" aria-hidden="true" /></Dialog.Close>
        </div>
        <Dialog.Description className="mt-2 text-sm text-muted-foreground">Traducción y explicación en español del contenido mostrado en inglés.</Dialog.Description>
        <div lang="es" className="mt-5 grid gap-4 text-sm leading-7">
          {translation && <section><h3 className="font-semibold">Traducción</h3><p className="mt-1 whitespace-pre-wrap">{translation}</p></section>}
          <section><h3 className="font-semibold">Explicación</h3>
            {explanations.length ? <ul className="mt-2 grid list-disc gap-3 pl-5">{explanations.map((text, index) => <li key={index}><div className="flex items-start gap-2"><p className="min-w-0 whitespace-pre-wrap">{text}</p><ReportSpeechButton text={text} language="es" label="Escuchar explicación en español" /></div></li>)}</ul>
              : <p className="mt-1">No hay anotaciones adicionales disponibles.</p>}
          </section>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
