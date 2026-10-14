import { AccountStore, validateAccountName } from './account-store';
import { normalizeEmail } from './account-role';
import { validatePassword } from './password-hash';
import { createLinguaLoopQueryExecutor } from '../db/postgres';

const FAILURE = 'Offline admin bootstrap failed.';
/** Use the existing runtime credentials; require an exact operator-attested existing target. */
export function loadBootstrapConfiguration(env: NodeJS.ProcessEnv) {
  try {
    const host = env.LINGUALOOP_DB_HOST ?? 'postgres';
    const rawPort = env.LINGUALOOP_DB_PORT ?? '5432';
    const port = Number(rawPort);
    if (!['postgres', '127.0.0.1'].includes(host) || !/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535 ||
        env.LINGUALOOP_BOOTSTRAP_EXISTING_TARGET_CONFIRMED !== `${host}:${port}/lingualoop`) throw new Error();
    return { host, port, database: 'lingualoop' };
  } catch { throw new Error(FAILURE); }
}
export function parseBootstrapInput(value: unknown) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'email,name,password') throw new Error();
    const input = value as Record<string, unknown>;
    validateAccountName(input.name);
    validatePassword(input.password);
    return { name: input.name, email: normalizeEmail(input.email), password: input.password };
  } catch { throw new Error(FAILURE); }
}
async function main(): Promise<void> {
  let executor: ReturnType<typeof createLinguaLoopQueryExecutor> | undefined;
  try {
    loadBootstrapConfiguration(process.env);
    // JSON must arrive through a private pipe, not argv, shell-history credentials or an echoing TTY.
    if (process.stdin.isTTY) throw new Error();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 4096) throw new Error();
      chunks.push(bytes);
    }
    const input = parseBootstrapInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    executor = createLinguaLoopQueryExecutor();
    await new AccountStore(executor).bootstrapFirstAdmin(input.name, input.email, input.password);
    console.log('Offline administrator created.');
  } catch { console.error(FAILURE); process.exitCode = 1; }
  finally { try { await executor?.close(); } catch { process.exitCode = 1; } }
}
if (require.main === module) void main();
