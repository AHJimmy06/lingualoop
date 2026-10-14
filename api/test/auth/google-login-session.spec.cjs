const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GoogleLoginSession,
  GoogleLoginSessionError,
} = require('../../dist/auth/google-login-session.js');

const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const SESSION = '323e4567-e89b-42d3-a456-426614174000';
const IDENTITY = { issuer: 'google', subject: 'verified-google-subject', email: 'approved@example.test' };
const NOW = 1_800_000_000_000;
const ID_TOKEN = 'untrusted-google-id-token';
const ACCESS = 'signed-access-token';
const REFRESH = `${SESSION}.${'A'.repeat(43)}`;
const REFRESH_HASH = 'c'.repeat(64);

function fixture(overrides = {}) {
  const events = [];
  const calls = { identity: [], session: [], refresh: [], token: [], revoked: [] };
  const dependencies = {
    googleIdentityService: {
      async verify(token) {
        events.push('verify');
        if (token !== ID_TOKEN) throw new Error('bad token');
        return IDENTITY;
      },
    },
    identityStore: {
      async getOrCreateOwner(identity) {
        events.push('owner');
        calls.identity.push(identity);
        return OWNER;
      },
    },
    sessionStore: {
      async createSession(owner, expiry) {
        events.push('session');
        calls.session.push({ owner, expiry });
        return SESSION;
      },
      async revokeSession(owner, session, at) {
        events.push('revoke');
        calls.revoked.push({ owner, session, at });
      },
    },
    refreshStore: {
      async initialize(owner, session, hash, at) {
        events.push('refresh');
        calls.refresh.push({ owner, session, hash, at });
        return true;
      },
    },
    tokenService: {
      async issue(input) {
        events.push('token');
        calls.token.push(input);
        return ACCESS;
      },
    },
    now: () => NOW,
    createRefreshCredential(session) {
      events.push('generate-refresh');
      assert.equal(session, SESSION);
      return { credential: REFRESH, hash: REFRESH_HASH };
    },
    ...overrides,
  };
  return { login: new GoogleLoginSession(dependencies), events, calls };
}

function assertGenericFailure(promise, ...secrets) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.name, 'GoogleLoginSessionError');
    assert.equal(error.message, 'Google login could not be completed.');
    for (const secret of secrets) assert.equal(error.message.includes(secret), false);
    return true;
  });
}

test('verifies token before any database mutation and issues absolute seven-day session in order', async () => {
  const { login, events, calls } = fixture();
  const result = await login.issue(ID_TOKEN);

  assert.deepEqual(events, ['verify', 'owner', 'session', 'generate-refresh', 'refresh', 'token']);
  assert.deepEqual(calls.identity, [IDENTITY]);
  assert.deepEqual(calls.session, [{ owner: OWNER, expiry: NOW + 7 * 24 * 60 * 60 * 1000 }]);
  assert.deepEqual(calls.refresh, [{ owner: OWNER, session: SESSION, hash: REFRESH_HASH, at: NOW }]);
  assert.equal(JSON.stringify(calls.refresh).includes(REFRESH), false);
  assert.deepEqual(calls.token, [{ issuer: 'google', subject: IDENTITY.subject, sessionId: SESSION }]);
  assert.deepEqual(result, {
    accessToken: ACCESS,
    refreshCredential: REFRESH,
    expiresAtMs: NOW + 7 * 24 * 60 * 60 * 1000,
  });
});

test('invalid token and non-Google verifier identity are rejected before all store calls', async () => {
  const invalid = fixture({
    googleIdentityService: { async verify() { invalid.events.push('verify'); throw new Error('signature failure detail'); } },
  });
  await assertGenericFailure(invalid.login.issue(ID_TOKEN), 'signature failure detail');
  assert.deepEqual(invalid.events, ['verify']);

  const wrongIssuer = fixture({
    googleIdentityService: { async verify() { wrongIssuer.events.push('verify'); return { issuer: 'attacker', subject: 'untrusted' }; } },
  });
  await assertGenericFailure(wrongIssuer.login.issue(ID_TOKEN));
  assert.deepEqual(wrongIssuer.events, ['verify']);

  const bareIdentity = fixture();
  await assertGenericFailure(bareIdentity.login.issue({ issuer: 'google', subject: 'caller' }));
  assert.deepEqual(bareIdentity.events, []);
});

test('unapproved email rejects generically before session, refresh or token issuance', async () => {
  const f = fixture({ identityStore: { async getOrCreateOwner(identity) {
    f.events.push('approval-rejected');
    assert.equal(identity.email, IDENTITY.email);
    throw Error('approval missing for private email');
  } } });
  await assertGenericFailure(f.login.issue(ID_TOKEN), 'private email');
  assert.deepEqual(f.events, ['verify', 'approval-rejected']);
  assert.deepEqual(f.calls.session, []);
  assert.deepEqual(f.calls.token, []);
});

test('verifier results without a normalized email never reach admission', async () => {
  for (const email of [undefined, '', 'UPPER@example.test', 'invalid']) {
    const f = fixture({ googleIdentityService: { async verify() { return { ...IDENTITY, email }; } } });
    await assertGenericFailure(f.login.issue(ID_TOKEN));
    assert.deepEqual(f.calls.identity, []);
    assert.deepEqual(f.calls.session, []);
  }
});

test('persists the generated hash only and returns both credentials only after complete success', async () => {
  const { login, calls } = fixture();
  const result = await login.issue(ID_TOKEN);
  assert.equal(calls.refresh[0].hash, REFRESH_HASH);
  assert.equal(JSON.stringify(calls).includes(REFRESH), false);
  assert.equal(result.accessToken, ACCESS);
  assert.equal(result.refreshCredential, REFRESH);
});

test('refresh initialization failure revokes the newly created owner-scoped session and leaks no credential', async () => {
  const { login, events, calls } = fixture({
    refreshStore: { async initialize() { events.push('refresh'); throw new Error('database detail'); } },
  });
  await assertGenericFailure(login.issue(ID_TOKEN), ACCESS, REFRESH, 'database detail');
  assert.deepEqual(events, ['verify', 'owner', 'session', 'generate-refresh', 'refresh', 'revoke']);
  assert.deepEqual(calls.revoked, [{ owner: OWNER, session: SESSION, at: NOW }]);
});

test('token issuance failure triggers owner-scoped revocation and never returns refresh credential', async () => {
  const { login, calls } = fixture({
    tokenService: { async issue() { throw new Error(`${ACCESS} ${REFRESH}`); } },
  });
  await assertGenericFailure(login.issue(ID_TOKEN), ACCESS, REFRESH);
  assert.deepEqual(calls.revoked, [{ owner: OWNER, session: SESSION, at: NOW }]);
});

test('failed compensation still rejects generically without returning either credential', async () => {
  const { login, events, calls } = fixture({
    tokenService: { async issue() { throw new Error('signing failed'); } },
    sessionStore: {
      async createSession() { events.push('session'); return SESSION; },
      async revokeSession(owner, session, at) {
        events.push('revoke');
        calls.revoked.push({ owner, session, at });
        throw new Error('revoke database details');
      },
    },
  });
  await assertGenericFailure(login.issue(ID_TOKEN), ACCESS, REFRESH, 'signing failed', 'revoke database details');
  assert.deepEqual(calls.revoked, [{ owner: OWNER, session: SESSION, at: NOW }]);
});

test('refresh initialization false is treated as failure and revoked', async () => {
  const { login, events, calls } = fixture({
    refreshStore: { async initialize() { events.push('refresh'); return false; } },
  });
  await assertGenericFailure(login.issue(ID_TOKEN), REFRESH);
  assert.equal(events.at(-1), 'revoke');
  assert.deepEqual(calls.revoked, [{ owner: OWNER, session: SESSION, at: NOW }]);
});
