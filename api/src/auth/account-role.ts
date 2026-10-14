export type AccountRole = 'admin' | 'teacher' | 'student';

export function isAccountRole(value: unknown): value is AccountRole {
  return value === 'admin' || value === 'teacher' || value === 'student';
}

/** Deliberately no provider-specific dot, plus, or alias transformations. */
export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid email.');
  const trimmed = value.trim();
  if (trimmed.length > 254 || !/^[\x21-\x7e]+$/.test(trimmed)) throw new TypeError('Invalid email.');
  const email = trimmed.toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0].length > 64 ||
      !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(parts[0]) ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(parts[1]) ||
      parts[1].split('.').some(label => label.length > 63)) throw new TypeError('Invalid email.');
  return email;
}
