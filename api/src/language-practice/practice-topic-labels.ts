import type { LanguagePracticeTopic } from './language-practice-session-store';
import { validatePracticeText } from './practice-catalogue';

export const PRACTICE_TOPIC_LABELS: Record<LanguagePracticeTopic, string> = {
  travel: 'Travel',
  work: 'Work',
  studies: 'Studies',
  'everyday-conversation': 'Everyday conversation',
};

/** NULL historical/default themes retain their category label; never infer from a title. */
export function parseConversationTheme(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  validatePracticeText(value, 120);
  return value;
}

/** The resulting label is quoted untrusted prompt data, not system instructions. */
export function practiceTopicLabel(topic: unknown, theme: unknown): string {
  if (typeof topic !== 'string' || !Object.hasOwn(PRACTICE_TOPIC_LABELS, topic)) throw new TypeError('Invalid practice topic.');
  return parseConversationTheme(theme) ?? PRACTICE_TOPIC_LABELS[topic as LanguagePracticeTopic];
}
