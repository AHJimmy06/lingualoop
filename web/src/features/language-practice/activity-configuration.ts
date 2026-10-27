export interface ActivityConfiguration { mode: 'conversation' | 'single-response'; aiRole: string; location: string }
export function parseActivityConfiguration(value: unknown): ActivityConfiguration {
  if (value === undefined) return { mode: 'conversation', aiRole: '', location: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid activity configuration.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'aiRole,location,mode' || !['conversation', 'single-response'].includes(row.mode as string) ||
      typeof row.aiRole !== 'string' || row.aiRole.length > 500 || typeof row.location !== 'string' || row.location.length > 1000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]/u.test(row.aiRole + row.location)) throw new TypeError('Invalid activity configuration.');
  return { mode: row.mode as ActivityConfiguration['mode'], aiRole: row.aiRole, location: row.location };
}
