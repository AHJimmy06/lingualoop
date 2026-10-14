export type Role = 'admin' | 'teacher' | 'student';
export type Profile = { ownerId: string; name: string; email: string; role: Role };
export function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
}
export function isPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && value === value.trim().toLowerCase() &&
    /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(value);
}
export function parseProfile(value: unknown): Profile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || !isName(record.name) || typeof record.ownerId !== 'string' || !UUID_PATTERN.test(record.ownerId) ||
      !isEmail(record.email) || typeof record.role !== 'string' || !['admin', 'teacher', 'student'].includes(record.role)) return null;
  return { ownerId: record.ownerId, name: record.name, email: record.email, role: record.role as Role };
}
