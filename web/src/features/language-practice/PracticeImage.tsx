import { useEffect, useMemo, useState } from 'react';
import { authSession } from '../../auth-session';
import { LanguagePracticeClient, type TeacherPractice } from './language-practice-client';
import { getPracticeScene } from './PracticeScene';

/** Covers use authenticated bytes, never public URLs or credentials in image src. */
export function PracticeImage({ practice, className }: { practice: TeacherPractice; className?: string }) {
  const client = useMemo(() => new LanguagePracticeClient(authSession), []);
  const [cover, setCover] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    let active = true;
    let ownedUrl: string | null = null;
    setCover(null);
    if (practice.hasImage) {
      void client.getPracticeImage(practice.id).then(blob => {
        if (!active) return;
        ownedUrl = URL.createObjectURL(blob);
        setCover({ id: practice.id, url: ownedUrl });
      }).catch(() => { if (active) setCover(null); });
    }
    return () => {
      active = false;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [client, practice.id, practice.hasImage]);
  const url = practice.hasImage && cover?.id === practice.id ? cover.url : null;
  return <img src={url ?? getPracticeScene(practice.setup.topic).image} alt="" aria-hidden="true" className={className} onError={() => {
    if (url) { URL.revokeObjectURL(url); setCover(null); }
  }} />;
}
