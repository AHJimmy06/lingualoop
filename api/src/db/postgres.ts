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
  connect?(): Promise<LinguaLoopPoolClient>;
  end(): Promise<void>;
}

interface LinguaLoopPoolClient {
  query(sql: string, parameters: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

type TransactionalQueryExecutor = QueryExecutor & {
  withTransaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

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

  const password = environment.LINGUALOOP_DB_PASSWORD;
  if (typeof password !== 'string' || !/^[0-9a-f]{64}$/.test(password)) {
    throw new LinguaLoopDatabaseConfigurationError();
  }

  return {
    host,
    port,
    password,
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
): TransactionalQueryExecutor {
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
    async withTransaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      if (closed || typeof callback !== 'function' || typeof pool.connect !== 'function') {
        throw new LinguaLoopDatabaseError();
      }

      let client: LinguaLoopPoolClient;
      try {
        client = await pool.connect();
      } catch {
        throw new LinguaLoopDatabaseError();
      }

      let began = false;
      let transactionFailed = false;
      try {
        await client.query('BEGIN', []);
        began = true;
        const tx: QueryExecutor = {
          async query(sql, parameters): Promise<QueryResult> {
            if (typeof sql !== 'string' || !Array.isArray(parameters)) {
              transactionFailed = true;
              throw new LinguaLoopDatabaseError();
            }
            try {
              const result = await client.query(sql, [...parameters]);
              if (!result || !Array.isArray(result.rows)) throw new Error();
              return { rows: result.rows };
            } catch {
              transactionFailed = true;
              throw new LinguaLoopDatabaseError();
            }
          },
        };
        const value = await callback(tx);
        if (transactionFailed) throw new LinguaLoopDatabaseError();
        await client.query('COMMIT', []);
        return value;
      } catch {
        if (began) {
          try {
            await client.query('ROLLBACK', []);
          } catch {
            // Preserve the generic transaction error if rollback also fails.
          }
        }
        throw new LinguaLoopDatabaseError();
      } finally {
        try {
          client.release();
        } catch {
          throw new LinguaLoopDatabaseError();
        }
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
  constructor(private readonly executor: TransactionalQueryExecutor) {}

  query(sql: string, parameters: readonly unknown[]): Promise<QueryResult> {
    return this.executor.query(sql, parameters);
  }

  withTransaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    return this.executor.withTransaction(callback);
  }

  async onModuleDestroy(): Promise<void> {
    await this.executor.close();
  }
}
