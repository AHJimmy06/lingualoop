export interface ActivityConfiguration {
  mode: 'conversation' | 'single-response';
  aiRole: string;
  location: string;
}
export function parseActivityConfiguration(value: unknown): ActivityConfiguration {
  if (value === undefined) return { mode: 'conversation', aiRole: '', location: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid activity configuration.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'aiRole,location,mode' ||
      !['conversation', 'single-response'].includes(row.mode as string)) throw new TypeError('Invalid activity configuration.');
  for (const [key, limit] of [['aiRole', 500], ['location', 1000]] as const) {
    if (typeof row[key] !== 'string' || row[key].length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]/u.test(row[key])) throw new TypeError('Invalid activity context.');
  }
  return { mode: row.mode as ActivityConfiguration['mode'], aiRole: row.aiRole as string, location: row.location as string };
}
