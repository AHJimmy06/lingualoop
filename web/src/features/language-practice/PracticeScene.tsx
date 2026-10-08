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
    <div role="group" className="flex min-w-0 flex-1 flex-col items-center justify-end" data-state={state} aria-label={`${name} — ${state}`}>
      <img
        className={`h-24 w-24 object-contain sm:h-32 sm:w-32 motion-safe:transition-transform motion-reduce:transition-none ${state === 'speaking' ? '-translate-y-1' : ''}`}
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
    <Participant key="learner" name="You" figure="learner" state={learnerState} />,
    <Participant key="partner" name="Conversation partner" figure="partner" state={partnerState} />,
  ];
  return (
    <section className="relative isolate mb-8 overflow-hidden rounded-2xl border bg-muted/30" aria-label={scene.label}>
      <img className="absolute inset-0 -z-10 h-full w-full object-cover" src={scene.image} alt="" aria-hidden="true" />
      <div className="flex min-h-52 items-end justify-center gap-4 bg-gradient-to-b from-background/10 via-background/15 to-background/55 px-5 pt-8 sm:min-h-64 sm:gap-12 sm:px-12">
        {children}
      </div>
      <p className="sr-only" aria-live="polite">You are {status(learnerState)}; conversation partner is {status(partnerState)}.</p>
    </section>
  );
}
