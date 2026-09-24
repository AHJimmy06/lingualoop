import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const TOKEN_SIGNING_KEY_FILE_ENV = 'LINGUALOOP_TOKEN_SIGNING_KEY_FILE';
export const TOKEN_SIGNING_KEY_ENV = 'LINGUALOOP_TOKEN_SIGNING_KEY';
const MINIMUM_KEY_BYTES = 32;

export interface TokenSigningKeyFileSystem {
  open(path: string, flags: number): number;
  fstat(fd: number): { isFile(): boolean; mode: number };
  readFile(fd: number): Buffer;
  close(fd: number): void;
}

const nodeFileSystem: TokenSigningKeyFileSystem = {
  open: (path, flags) => openSync(path, flags),
  fstat: fstatSync,
  readFile: (fd) => readFileSync(fd),
  close: closeSync,
};

/** Loads one explicitly configured key source without exposing file-system details in errors. */
export function loadTokenSigningKey(
  env: NodeJS.ProcessEnv = process.env,
  fileSystem: TokenSigningKeyFileSystem = nodeFileSystem,
): Buffer | string {
  const hasFileSetting = Object.prototype.hasOwnProperty.call(env, TOKEN_SIGNING_KEY_FILE_ENV);
  const hasValueSetting = Object.prototype.hasOwnProperty.call(env, TOKEN_SIGNING_KEY_ENV);

  if (hasFileSetting && hasValueSetting) {
    throw new TypeError('Configure exactly one LinguaLoop token signing key source.');
  }

  if (hasFileSetting) {
    const filePath = env[TOKEN_SIGNING_KEY_FILE_ENV];
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.trim() !== filePath || !isAbsolute(filePath)) {
      throw new TypeError('The LinguaLoop token signing key file setting must be an absolute path.');
    }

    let fd: number | undefined;
    try {
      fd = fileSystem.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = fileSystem.fstat(fd);
      if (!metadata.isFile() || (metadata.mode & 0o400) === 0 || (metadata.mode & 0o077) !== 0) {
        throw new TypeError('Invalid key file.');
      }
      const key = fileSystem.readFile(fd);
      if (key.length < MINIMUM_KEY_BYTES) {
        throw new TypeError('Invalid key file.');
      }
      return key;
    } catch {
      throw new TypeError('The LinguaLoop token signing key file is unavailable or invalid.');
    } finally {
      if (fd !== undefined) {
        try {
          fileSystem.close(fd);
        } catch {
          // A close failure must not expose filesystem details or mask a generic loader error.
        }
      }
    }
  }

  if (hasValueSetting) {
    const value = env[TOKEN_SIGNING_KEY_ENV];
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < MINIMUM_KEY_BYTES) {
      throw new TypeError('The LinguaLoop token signing key is invalid.');
    }
    return value;
  }

  throw new TypeError('A LinguaLoop token signing key source is required.');
}
