import type { ReactNode } from 'react';

type ParticipantState = 'idle' | 'speaking' | 'listening';
type SceneTopic = 'travel' | 'work' | 'studies' | 'everyday-conversation';

type PracticeSceneDetails = {
  topic: SceneTopic;
  label: string;
  image: string;
};

const scenes: Record<SceneTopic, PracticeSceneDetails> = {
  travel: { topic: 'travel', label: 'Travel conversation scene', image: '/images/scenes/travel-scene.svg' },
  work: { topic: 'work', label: 'Work conversation scene', image: '/images/scenes/work-scene.svg' },
  studies: { topic: 'studies', label: 'Study conversation scene', image: '/images/scenes/studies-scene.svg' },
  'everyday-conversation': {
    topic: 'everyday-conversation', label: 'Everyday conversation scene', image: '/images/scenes/everyday-conversation-scene.svg',
  },
};

export function getPracticeScene(topic: string): PracticeSceneDetails {
  return scenes[topic as SceneTopic] ?? scenes['everyday-conversation'];
}

function Participant({ name, figure, state }: { name: string; figure: 'learner' | 'partner'; state: ParticipantState }) {
  return (
    <div role="group" className="relative flex min-w-0 flex-1 flex-col items-center justify-end" data-state={state} aria-label={`${name} — ${state}`}>
      <div className="flex h-10 w-full shrink-0 items-start justify-center sm:h-12">
        {state === 'speaking' && <span aria-hidden="true" className="whitespace-nowrap rounded-2xl border border-primary/30 bg-background px-3 py-1 text-sm font-bold tracking-widest text-primary shadow-md motion-safe:animate-pulse sm:text-base">••• )))</span>}
        {state === 'listening' && <span aria-hidden="true" className="whitespace-nowrap rounded-full border border-sky-600/30 bg-background px-3 py-1 text-[11px] font-semibold text-sky-800 shadow-sm dark:text-sky-200 sm:text-xs">◖ Listening</span>}
      </div>
      <img
        className={`h-24 w-24 object-contain sm:h-32 sm:w-32 lg:h-[clamp(10rem,24svh,20rem)] lg:w-full motion-safe:transition-transform motion-reduce:transition-none ${state === 'speaking' ? '-translate-y-1' : ''}`}
        src={`/images/scenes/${figure}-figure.svg`}
        alt=""
        aria-hidden="true"
      />
      <span className="mt-1 rounded-full bg-background/90 px-3 py-1 text-xs font-medium shadow-sm sm:text-sm">{name}</span>
      <span className="sr-only">{state}</span>
    </div>
  );
}

export function PracticeScene({
  topic,
  learnerState = 'idle',
  partnerState = 'idle',
}: {
  topic: string;
  learnerState?: ParticipantState;
  partnerState?: ParticipantState;
}) {
  const scene = getPracticeScene(topic);
  const status = (state: ParticipantState) => state === 'idle' ? 'quiet' : state;
  const children: ReactNode[] = [
    <Participant key="partner" name="Conversation partner" figure="partner" state={partnerState} />,
    <Participant key="learner" name="You" figure="learner" state={learnerState} />,
  ];
  return (
    <section className="relative isolate mb-8 overflow-hidden rounded-2xl" aria-label={scene.label}>
      <img className="absolute inset-0 -z-10 h-full w-full object-cover" src={scene.image} alt="" aria-hidden="true" />
      <div className="flex min-h-52 items-end justify-center gap-2 px-2 pt-2 sm:min-h-64 sm:gap-4 lg:min-h-[clamp(20rem,45svh,36rem)]">
        {children}
      </div>
      <p className="sr-only" aria-live="polite">You are {status(learnerState)}; conversation partner is {status(partnerState)}.</p>
    </section>
  );
}
