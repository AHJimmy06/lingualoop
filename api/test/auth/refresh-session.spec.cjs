const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { RefreshSession, RefreshSessionError } = require('../../dist/auth/refresh-session.js');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_OWNER = '223e4567-e89b-42d3-a456-426614174000';
const SESSION = '323e4567-e89b-42d3-a456-426614174000';
const NOW = 1_800_000_000_000;
const EXPIRY = NOW + 3 * 24 * 60 * 60 * 1000;
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const CREDENTIAL = `${SESSION}.${SECRET}`;
const HASH = createHash('sha256').update(CREDENTIAL, 'utf8').digest('hex');
const NEXT = `${SESSION}.${Buffer.alloc(32, 8).toString('base64url')}`;
const NEXT_HASH = 'b'.repeat(64);
const ACCESS = 'new-access-token';

function fixture(overrides = {}) {
  const calls = { rotate: [], revoke: [], issue: [] };
  const deps = {
    refreshStore: {
      async rotate(...args) {
        calls.rotate.push(args);
        return { status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'verified-subject', expiresAtMs: EXPIRY };
      },
    },
    sessionStore: {
      async revokeSession(...args) { calls.revoke.push(args); },
    },
    tokenService: {
      async issue(input) { calls.issue.push(input); return ACCESS; },
    },
    now: () => NOW,
    createRefreshCredential(sessionId) {
      assert.equal(sessionId, SESSION);
      return { credential: NEXT, hash: NEXT_HASH };
    },
    ...overrides,
  };
  return { service: new RefreshSession(deps), calls };
}

function genericFailure(promise, ...privateDetails) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.name, 'RefreshSessionError');
    assert.equal(error.message, 'Session operation could not be completed.');
    for (const detail of privateDetails) assert.equal(error.message.includes(detail), false);
    return true;
  });
}

test('valid rotation returns access/new refresh credentials and the unchanged DB absolute expiry', async () => {
  const { service, calls } = fixture();
  const result = await service.refresh(CREDENTIAL);
  assert.deepEqual({
    accessToken: result.accessToken,
    refreshCredential: result.refreshCredential,
    expiresAtMs: result.expiresAtMs,
  }, { accessToken: ACCESS, refreshCredential: NEXT, expiresAtMs: EXPIRY });
  assert.equal(typeof result.compensateDeliveryFailure, 'function');
  await result.compensateDeliveryFailure();
  await result.compensateDeliveryFailure();
  assert.deepEqual(calls.revoke, [[OWNER, SESSION, NOW]]);
  assert.deepEqual(calls.rotate, [[SESSION, HASH, NEXT_HASH, NOW]]);
  assert.deepEqual(calls.issue, [{ issuer: 'google', subject: 'verified-subject', sessionId: SESSION }]);
  assert.equal(JSON.stringify(calls.rotate).includes(CREDENTIAL), false);
});

test('expired, spent replay, and unknown credentials fail generically without token issuance', async () => {
  for (const status of ['invalid', 'replay']) {
    const { service, calls } = fixture({ refreshStore: { async rotate() { return { status }; } } });
    await genericFailure(service.refresh(CREDENTIAL), status);
    assert.deepEqual(calls.issue, []);
    assert.deepEqual(calls.revoke, []);
  }
  const invalid = fixture();
  await genericFailure(invalid.service.refresh('not-a-refresh-credential'));
  assert.deepEqual(invalid.calls.rotate, []);
});

test('refresh store failures do not reveal database details', async () => {
  const secret = 'private SQL host detail';
  const { service } = fixture({ refreshStore: { async rotate() { throw new Error(secret); } } });
  await genericFailure(service.refresh(CREDENTIAL), secret);
});

test('delivery compensation is owner-scoped, idempotent, and best-effort', async () => {
  const detail = 'revoke backend detail';
  const { service, calls } = fixture({
    sessionStore: { async revokeSession(...args) { calls.revoke.push(args); throw new Error(detail); } },
  });
  const result = await service.refresh(CREDENTIAL);
  await result.compensateDeliveryFailure();
  await result.compensateDeliveryFailure();
  assert.deepEqual(calls.revoke, [[OWNER, SESSION, NOW]]);
});

test('token issuance failure revokes the rotated session by DB-verified owner and returns no credential', async () => {
  const { service, calls } = fixture({ tokenService: { async issue() { throw new Error(`${ACCESS} ${NEXT}`); } } });
  await genericFailure(service.refresh(CREDENTIAL), ACCESS, NEXT);
  assert.deepEqual(calls.revoke, [[OWNER, SESSION, NOW]]);
});

test('failed post-rotation compensation remains a generic failure', async () => {
  const detail = 'revoke backend detail';
  const { service, calls } = fixture({
    tokenService: { async issue() { throw new Error('signing detail'); } },
    sessionStore: { async revokeSession(...args) { calls.revoke.push(args); throw new Error(detail); } },
  });
  await genericFailure(service.refresh(CREDENTIAL), 'signing detail', detail, NEXT);
  assert.deepEqual(calls.revoke, [[OWNER, SESSION, NOW]]);
});

test('logout revokes only the verified owner/session pair and sanitizes store errors', async () => {
  const { service, calls } = fixture();
  await service.logout({ ownerId: OTHER_OWNER, sessionId: SESSION });
  assert.deepEqual(calls.revoke, [[OTHER_OWNER, SESSION, NOW]]);
  await genericFailure(service.logout({ ownerId: 'bad', sessionId: SESSION }));

  const detail = 'database failure';
  const failed = fixture({ sessionStore: { async revokeSession() { throw new Error(detail); } } });
  await genericFailure(failed.service.logout({ ownerId: OWNER, sessionId: SESSION }), detail);
});

test('concurrent reuse follows atomic store result: one rotation succeeds and replay is rejected', async () => {
  let used = false;
  let replayRevoked = false;
  const { service, calls } = fixture({
    refreshStore: {
      async rotate() {
        if (used) {
          replayRevoked = true; // Mirrors migration 004: DB revokes the session on spent replay.
          return { status: 'replay' };
        }
        used = true;
        return { status: 'rotated', ownerId: OWNER, issuer: 'google', subject: 'verified-subject', expiresAtMs: EXPIRY };
      },
    },
  });
  const outcomes = await Promise.allSettled([service.refresh(CREDENTIAL), service.refresh(CREDENTIAL)]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason instanceof RefreshSessionError).length, 1);
  assert.equal(replayRevoked, true);
  assert.equal(calls.issue.length, 1);
});
