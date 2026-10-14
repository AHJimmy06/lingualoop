import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 ||
      Buffer.from(value, 'utf8').toString('utf8') !== value) throw new TypeError('Invalid password.');
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: 32 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return `scrypt:${COST}:${BLOCK_SIZE}:${PARALLELISM}:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: unknown): Promise<boolean> {
  try {
    validatePassword(password);
    // Fixed parameters and exact lengths prevent untrusted stored values from allocating arbitrary work.
    if (typeof encoded !== 'string' || !/^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{128}$/.test(encoded)) return false;
    const parts = encoded.split(':');
    return timingSafeEqual(await derive(password, Buffer.from(parts[4], 'hex')), Buffer.from(parts[5], 'hex'));
  } catch { return false; }
}
