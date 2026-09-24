import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Pool } from 'pg';
import type { QueryExecutor, QueryResult } from '../auth/identity-store';

const DATABASE_NAME = 'lingualoop';
const DATABASE_USER = 'lingualoop';
const CONFIG_ERROR = 'LinguaLoop database configuration is invalid.';
const QUERY_ERROR = 'LinguaLoop database operation failed.';

export interface LinguaLoopPostgresConfig {
  host: 'postgres' | '127.0.0.1';
  port: number;
  password: string;
}

export interface LinguaLoopPool {
  query(sql: string, parameters: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export class LinguaLoopDatabaseConfigurationError extends Error {
  constructor() {
    super(CONFIG_ERROR);
    this.name = 'LinguaLoopDatabaseConfigurationError';
  }
}

export class LinguaLoopDatabaseError extends Error {
  constructor() {
    super(QUERY_ERROR);
    this.name = 'LinguaLoopDatabaseError';
  }
}

function readPasswordFile(filePath: string | undefined): string {
  if (!filePath || !isAbsolute(filePath)) throw new LinguaLoopDatabaseConfigurationError();

  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 64 || stat.size > 65) {
      throw new LinguaLoopDatabaseConfigurationError();
    }

    const content = Buffer.alloc(66);
    const bytesRead = readSync(descriptor, content, 0, content.length, 0);
    const password = content.subarray(0, bytesRead).toString('ascii');
    if (!/^[0-9a-f]{64}\n?$/.test(password)) {
      throw new LinguaLoopDatabaseConfigurationError();
    }
    return password.endsWith('\n') ? password.slice(0, -1) : password;
  } catch {
    throw new LinguaLoopDatabaseConfigurationError();
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Do not expose filesystem details or credential material.
      }
    }
  }
}

export function loadLinguaLoopPostgresConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LinguaLoopPostgresConfig {
  const host = environment.LINGUALOOP_DB_HOST ?? 'postgres';
  const rawPort = environment.LINGUALOOP_DB_PORT ?? '5432';
  const port = Number(rawPort);
  if ((host !== 'postgres' && host !== '127.0.0.1') || !/^[0-9]+$/.test(rawPort) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LinguaLoopDatabaseConfigurationError();
  }

  return {
    host,
    port,
    password: readPasswordFile(environment.LINGUALOOP_DB_PASSWORD_FILE),
  };
}

function validateConfig(config: LinguaLoopPostgresConfig): void {
  if (!config || (config.host !== 'postgres' && config.host !== '127.0.0.1') ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      typeof config.password !== 'string' || !/^[0-9a-f]{64}$/.test(config.password)) {
    throw new LinguaLoopDatabaseConfigurationError();
  }
}

export function createLinguaLoopQueryExecutor(
  config: LinguaLoopPostgresConfig = loadLinguaLoopPostgresConfig(),
  injectedPool?: LinguaLoopPool,
): QueryExecutor & { close(): Promise<void> } {
  validateConfig(config);
  const ownsPool = injectedPool === undefined;
  let pool: LinguaLoopPool;
  try {
    if (injectedPool) {
      pool = injectedPool;
    } else {
      const ownedPool = new Pool({
        host: config.host,
        port: config.port,
        database: DATABASE_NAME,
        user: DATABASE_USER,
        password: config.password,
        connectionTimeoutMillis: 3_000,
        query_timeout: 5_000,
      });
      ownedPool.on('error', () => {
        // pg removes failed idle clients; consume the event without exposing raw errors.
      });
      pool = ownedPool;
    }
  } catch {
    throw new LinguaLoopDatabaseConfigurationError();
  }
  let closed = false;

  return {
    async query(sql: string, parameters: readonly unknown[]): Promise<QueryResult> {
      if (closed || typeof sql !== 'string' || !Array.isArray(parameters)) {
        throw new LinguaLoopDatabaseError();
      }
      try {
        const result = await pool.query(sql, [...parameters]);
        if (!result || !Array.isArray(result.rows)) throw new Error();
        return { rows: result.rows };
      } catch {
        throw new LinguaLoopDatabaseError();
      }
    },
    async close(): Promise<void> {
      if (!ownsPool || closed) return;
      closed = true;
      try {
        await pool.end();
      } catch {
        throw new LinguaLoopDatabaseError();
      }
    },
  };
}

export const LINGUALOOP_QUERY_EXECUTOR = Symbol('LINGUALOOP_QUERY_EXECUTOR');

export class LinguaLoopPostgresProvider implements QueryExecutor {
  constructor(private readonly executor: QueryExecutor & { close(): Promise<void> }) {}

  query(sql: string, parameters: readonly unknown[]): Promise<QueryResult> {
    return this.executor.query(sql, parameters);
  }

  async onModuleDestroy(): Promise<void> {
    await this.executor.close();
  }
}
